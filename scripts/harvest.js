/**
 * MarketSync DataSync - Multi-Flavor Hourly Auction Harvester
 * 
 * Fetches auction house and commodity data across all supported WoW flavors:
 *   - forever    (WoW: Forever rulesets)
 *   - classicEra (Classic Era / Anniversary / SoD / Hardcore)
 *   - classic    (Classic Progression: MoP / Cata / TBC)
 *   - retail     (Modern WoW + Region-wide Commodities)
 * 
 * Enforces a 90-day rolling retention window on stored dataset blocks.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@pinta365/blizzard_api');

const REGION = process.env.BLIZZARD_REGION || 'us';
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const FLAVORS = (process.env.HARVEST_FLAVORS || 'forever,classicEra,classic,retail')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '90', 10);

const DATASETS_DIR = path.join(__dirname, '../datasets');
const INDEX_FILE = path.join(DATASETS_DIR, 'index.json');

if (!fs.existsSync(DATASETS_DIR)) {
  fs.mkdirSync(DATASETS_DIR, { recursive: true });
}

function getIndex() {
  if (fs.existsSync(INDEX_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    } catch {
      return { blocks: [], lastUpdated: null };
    }
  }
  return { blocks: [], lastUpdated: null };
}

function saveIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

/**
 * Prune dataset blocks older than RETENTION_DAYS (default 90 days)
 */
function pruneOldBlocks(retentionDays = RETENTION_DAYS) {
  const cutoffMs = Date.now() - retentionDays * 86400 * 1000;
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
  let prunedCount = 0;

  for (const flavor of ['forever', 'classicEra', 'classic', 'retail']) {
    const flavorDir = path.join(DATASETS_DIR, flavor);
    if (!fs.existsSync(flavorDir)) continue;

    for (const dateDir of fs.readdirSync(flavorDir)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateDir) && dateDir < cutoffDate) {
        fs.rmSync(path.join(flavorDir, dateDir), { recursive: true, force: true });
        prunedCount++;
      }
    }
  }

  const index = getIndex();
  const before = index.blocks.length;
  index.blocks = index.blocks.filter(b => b.date >= cutoffDate);
  if (index.blocks.length !== before) {
    saveIndex(index);
  }

  if (prunedCount > 0) {
    console.log(`[Retention] Pruned ${prunedCount} date directories older than ${cutoffDate} (${retentionDays}d).`);
  }
}

/**
 * Process raw auction and commodity listings into an aggregated item price map
 */
function aggregateAuctionListings(auctions = [], commodities = [], timestamp = Math.floor(Date.now() / 1000)) {
  const itemMap = {};

  for (const auc of auctions) {
    if (!auc.item || !auc.item.id) continue;
    const itemId = auc.item.id;
    const qty = auc.quantity || 1;
    let unitPrice = 0;
    if (auc.buyout && auc.buyout > 0) {
      unitPrice = Math.floor(auc.buyout / qty);
    } else if (auc.bid && auc.bid > 0) {
      unitPrice = Math.floor(auc.bid / qty);
    }
    if (unitPrice <= 0) continue;

    const key = (auc.item.modifiers && auc.item.modifiers.length > 0)
      ? `${itemId}:${auc.item.modifiers[0].value}`
      : String(itemId);

    if (!itemMap[key]) {
      itemMap[key] = {
        minPrice: unitPrice,
        maxPrice: unitPrice,
        totalQty: qty,
        listings: 1,
        time: timestamp
      };
    } else {
      const entry = itemMap[key];
      if (unitPrice < entry.minPrice) entry.minPrice = unitPrice;
      if (unitPrice > entry.maxPrice) entry.maxPrice = unitPrice;
      entry.totalQty += qty;
      entry.listings += 1;
    }
  }

  for (const com of commodities) {
    if (!com.item || !com.item.id) continue;
    const itemId = String(com.item.id);
    const qty = com.quantity || 1;
    const unitPrice = com.unit_price || 0;
    if (unitPrice <= 0) continue;

    if (!itemMap[itemId]) {
      itemMap[itemId] = {
        minPrice: unitPrice,
        maxPrice: unitPrice,
        totalQty: qty,
        listings: 1,
        time: timestamp
      };
    } else {
      const entry = itemMap[itemId];
      if (unitPrice < entry.minPrice) entry.minPrice = unitPrice;
      if (unitPrice > entry.maxPrice) entry.maxPrice = unitPrice;
      entry.totalQty += qty;
      entry.listings += 1;
    }
  }

  return itemMap;
}

async function harvestForever(client, unixNow) {
  const partitions = {};
  let totalItems = 0;
  let totalVolume = 0;

  const rulesetsResp = await client.wowForever.rulesets();
  const rulesetList = rulesetsResp.rulesets || [];
  console.log(`[Forever] Found ${rulesetList.length} rulesets.`);

  for (const rsRef of rulesetList) {
    const rsId = rsRef.id;
    const rsData = await client.wowForever.ruleset(rsId);
    const rsName = (rsData.name && (rsData.name.en_US || rsData.name.en_GB || Object.values(rsData.name)[0])) || `ruleset${rsId}`;
    const canonicalName = String(rsName).toLowerCase().replace(/[^a-z0-9]/g, '');

    if (!partitions[canonicalName]) partitions[canonicalName] = {};

    const housesResp = await client.wowForever.auctionHouses(rsId);
    for (const house of (housesResp.auctions || [])) {
      const houseId = house.id;
      let houseName = house.name || 'Faction';
      if (houseId === 2 || String(houseName).toLowerCase().includes('horde')) houseName = 'Horde';
      else if (houseId === 6 || String(houseName).toLowerCase().includes('alliance')) houseName = 'Alliance';
      else if (houseId === 7 || String(houseName).toLowerCase().includes('neutral') || String(houseName).toLowerCase().includes('blackwater')) houseName = 'Neutral';

      let auctions = [];
      let commodities = [];
      try { auctions = (await client.wowForever.auctionHouse(rsId, houseId)).auctions || []; } catch {}
      try { commodities = (await client.wowForever.auctionHouseCommodities(rsId, houseId)).auctions || []; } catch {}

      const aggregated = aggregateAuctionListings(auctions, commodities, unixNow);
      partitions[canonicalName][houseName] = aggregated;

      const count = Object.keys(aggregated).length;
      totalItems += count;
      totalVolume += Object.values(aggregated).reduce((s, i) => s + i.totalQty, 0);
      console.log(`  [Forever] ${canonicalName}@${houseName}: ${count} unique items`);
    }
  }

  return { partitions, totalItems, totalVolume };
}

async function harvestClassicEra(client, unixNow) {
  const partitions = {};
  let totalItems = 0;
  let totalVolume = 0;

  const crResp = await client.wowClassicEra.connectedRealms();
  const crLinks = crResp.connected_realms || [];
  console.log(`[ClassicEra/Anniversary] Found ${crLinks.length} connected realms.`);

  for (const crLink of crLinks) {
    const match = String(crLink.href || '').match(/connected-realm\/(\d+)/);
    if (!match) continue;
    const crId = parseInt(match[1], 10);

    let realmLabel = `cr${crId}`;
    try {
      const crData = await client.wowClassicEra.connectedRealm(crId);
      const firstRealm = crData.realms && crData.realms[0];
      if (firstRealm && firstRealm.slug) realmLabel = firstRealm.slug;
    } catch {}

    partitions[realmLabel] = {};
    try {
      const housesResp = await client.wowClassicEra.auctionHouses(crId);
      for (const house of (housesResp.auctions || [])) {
        const houseId = house.id;
        let houseName = house.name || 'Faction';
        if (houseId === 2 || String(houseName).toLowerCase().includes('horde')) houseName = 'Horde';
        else if (houseId === 6 || String(houseName).toLowerCase().includes('alliance')) houseName = 'Alliance';
        else if (houseId === 7 || String(houseName).toLowerCase().includes('neutral') || String(houseName).toLowerCase().includes('blackwater')) houseName = 'Neutral';

        let auctions = [];
        try { auctions = (await client.wowClassicEra.auctionHouse(crId, houseId)).auctions || []; } catch {}

        const aggregated = aggregateAuctionListings(auctions, [], unixNow);
        partitions[realmLabel][houseName] = aggregated;

        const count = Object.keys(aggregated).length;
        totalItems += count;
        totalVolume += Object.values(aggregated).reduce((s, i) => s + i.totalQty, 0);
      }
      console.log(`  [ClassicEra] ${realmLabel}: harvested`);
    } catch (err) {
      console.warn(`  [ClassicEra] Skipped ${realmLabel}: ${err.message}`);
    }
  }

  return { partitions, totalItems, totalVolume };
}

async function harvestClassic(client, unixNow) {
  const partitions = {};
  let totalItems = 0;
  let totalVolume = 0;

  const crResp = await client.wowClassic.connectedRealms();
  const crLinks = crResp.connected_realms || [];
  console.log(`[Classic Progression] Found ${crLinks.length} connected realms.`);

  for (const crLink of crLinks) {
    const match = String(crLink.href || '').match(/connected-realm\/(\d+)/);
    if (!match) continue;
    const crId = parseInt(match[1], 10);

    let realmLabel = `cr${crId}`;
    try {
      const crData = await client.wowClassic.connectedRealm(crId);
      const firstRealm = crData.realms && crData.realms[0];
      if (firstRealm && firstRealm.slug) realmLabel = firstRealm.slug;
    } catch {}

    try {
      const aucResp = await client.wowClassic.auctions(crId);
      const auctions = aucResp.auctions || [];
      const aggregated = aggregateAuctionListings(auctions, [], unixNow);
      partitions[realmLabel] = { CrossFaction: aggregated };

      const count = Object.keys(aggregated).length;
      totalItems += count;
      totalVolume += Object.values(aggregated).reduce((s, i) => s + i.totalQty, 0);
      console.log(`  [Classic] ${realmLabel}: ${count} unique items`);
    } catch (err) {
      console.warn(`  [Classic] Skipped ${realmLabel}: ${err.message}`);
    }
  }

  return { partitions, totalItems, totalVolume };
}

async function harvestRetail(client, unixNow) {
  const partitions = {};
  let totalItems = 0;
  let totalVolume = 0;

  // Region-wide commodities
  try {
    const comResp = await client.wow.commodities();
    const commodities = comResp.auctions || [];
    const comAgg = aggregateAuctionListings([], commodities, unixNow);
    partitions['region'] = { Commodities: comAgg };
    totalItems += Object.keys(comAgg).length;
    totalVolume += Object.values(comAgg).reduce((s, i) => s + i.totalQty, 0);
    console.log(`  [Retail] Region Commodities: ${Object.keys(comAgg).length} unique items`);
  } catch (err) {
    console.warn(`  [Retail] Commodities failed: ${err.message}`);
  }

  return { partitions, totalItems, totalVolume };
}

async function saveFlavorBlock(flavor, dateStr, hourStr, now, unixNow, result, simulated = false) {
  const targetDir = path.join(DATASETS_DIR, flavor, dateStr);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const blockPath = path.join(targetDir, `${hourStr}-00.json`);
  const blockData = {
    version: '1.0',
    flavor,
    timestamp: unixNow,
    isoDate: now.toISOString(),
    region: REGION,
    rulesets: result.partitions,
    stats: {
      totalItems: result.totalItems,
      totalVolume: result.totalVolume,
      status: simulated ? 'simulated' : 'live'
    }
  };

  fs.writeFileSync(blockPath, JSON.stringify(blockData, null, 2), 'utf8');

  const index = getIndex();
  index.blocks = index.blocks.filter(b => !(b.flavor === flavor && b.date === dateStr && b.hour === hourStr));
  index.blocks.push({
    flavor,
    date: dateStr,
    hour: hourStr,
    path: `datasets/${flavor}/${dateStr}/${hourStr}-00.json`,
    items: result.totalItems,
    volume: result.totalVolume,
    timestamp: unixNow,
    simulated
  });
  index.lastUpdated = now.toISOString();
  saveIndex(index);

  console.log(`[Harvester] Saved ${flavor} block -> ${blockPath} (${result.totalItems} items)`);
  return blockData;
}

async function harvest() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const hourStr = String(now.getUTCHours()).padStart(2, '0');
  const unixNow = Math.floor(now.getTime() / 1000);

  console.log(`[MarketSyncData Harvester] Starting multi-flavor harvest (${FLAVORS.join(', ')}) for ${dateStr} ${hourStr}:00 UTC...`);

  pruneOldBlocks(RETENTION_DAYS);

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn(`[WARNING] BLIZZARD_CLIENT_ID or BLIZZARD_CLIENT_SECRET not provided. Generating simulated blocks.`);
    const sampleItems = {
      '13464': { minPrice: 12500, maxPrice: 15000, totalQty: 48, listings: 6, time: unixNow },
      '13463': { minPrice: 8500, maxPrice: 9200, totalQty: 120, listings: 12, time: unixNow },
      '14344': { minPrice: 220000, maxPrice: 245000, totalQty: 4, listings: 4, time: unixNow }
    };
    const results = {};
    for (const flavor of FLAVORS) {
      results[flavor] = await saveFlavorBlock(flavor, dateStr, hourStr, now, unixNow, {
        partitions: { english: { Horde: sampleItems, Alliance: sampleItems, Neutral: sampleItems } },
        totalItems: 9,
        totalVolume: 516
      }, true);
    }
    return results;
  }

  const client = createClient({
    region: REGION,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET
  });

  const results = {};
  for (const flavor of FLAVORS) {
    try {
      let res;
      if (flavor === 'forever') res = await harvestForever(client, unixNow);
      else if (flavor === 'classicEra') res = await harvestClassicEra(client, unixNow);
      else if (flavor === 'classic') res = await harvestClassic(client, unixNow);
      else if (flavor === 'retail') res = await harvestRetail(client, unixNow);

      if (res) {
        results[flavor] = await saveFlavorBlock(flavor, dateStr, hourStr, now, unixNow, res, false);
      }
    } catch (err) {
      console.error(`[Harvester Error] Flavor ${flavor} failed: ${err.message}`);
    }
  }

  return results;
}

if (require.main === module) {
  harvest();
}

module.exports = { harvest, aggregateAuctionListings, pruneOldBlocks };
