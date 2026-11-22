/**
 * MarketSync DataSync - Hourly Auction Harvester
 * 
 * Fetches auction house and commodity data via the Blizzard Battle.net Game Data API
 * (using @pinta365/blizzard_api for WoW: Forever realmless rulesets).
 * Saves structured hourly dataset blocks partitioned by date (YYYY-MM-DD/HH-00.json).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createClient } = require('@pinta365/blizzard_api');

const REGION = process.env.BLIZZARD_REGION || 'us';
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const DATASETS_DIR = path.join(__dirname, '../datasets');
const INDEX_FILE = path.join(DATASETS_DIR, 'index.json');

// Ensure dataset root exists
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
 * Process raw auction and commodity listings into an aggregated item price map
 */
function aggregateAuctionListings(auctions = [], commodities = [], timestamp = Math.floor(Date.now() / 1000)) {
  const itemMap = {};

  // 1. Process standard equipment / item listings
  for (const auc of auctions) {
    if (!auc.item || !auc.item.id) continue;
    const itemId = auc.item.id;
    const qty = auc.quantity || 1;
    // Calculate per-unit price in copper
    let unitPrice = 0;
    if (auc.buyout && auc.buyout > 0) {
      unitPrice = Math.floor(auc.buyout / qty);
    } else if (auc.bid && auc.bid > 0) {
      unitPrice = Math.floor(auc.bid / qty);
    }
    if (unitPrice <= 0) continue;

    // Support random suffixes / modifiers if present
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

  // 2. Process commodities
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

async function harvest() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const hourStr = String(now.getUTCHours()).padStart(2, '0'); // HH
  const unixNow = Math.floor(now.getTime() / 1000);

  console.log(`[MarketSyncData Harvester] Starting harvest for ${dateStr} ${hourStr}:00 UTC...`);

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn(`[WARNING] BLIZZARD_CLIENT_ID or BLIZZARD_CLIENT_SECRET not provided.`);
    console.warn(`Generating simulated test dataset block for offline validation.`);
    
    // Generate valid sample data block for verification
    const sampleItems = {
      '13464': { minPrice: 12500, maxPrice: 15000, totalQty: 48, listings: 6, time: unixNow }, // Golden Sansam
      '13463': { minPrice: 8500, maxPrice: 9200, totalQty: 120, listings: 12, time: unixNow }, // Dreamfoil
      '14344': { minPrice: 220000, maxPrice: 245000, totalQty: 4, listings: 4, time: unixNow }, // Large Brilliant Shard
      '14343': { minPrice: 45000, maxPrice: 50000, totalQty: 35, listings: 9, time: unixNow }, // Small Brilliant Shard
      '17011': { minPrice: 14000, maxPrice: 15500, totalQty: 80, listings: 10, time: unixNow }, // Lava Core
      '11382': { minPrice: 1800, maxPrice: 2200, totalQty: 250, listings: 22, time: unixNow }, // Bloodvine
    };

    const targetDir = path.join(DATASETS_DIR, dateStr);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const blockPath = path.join(targetDir, `${hourStr}-00.json`);
    const blockData = {
      version: '1.0',
      timestamp: unixNow,
      isoDate: now.toISOString(),
      region: REGION,
      rulesets: {
        'english': {
          Horde: sampleItems,
          Alliance: sampleItems,
          Neutral: sampleItems
        }
      },
      stats: {
        totalItems: Object.keys(sampleItems).length,
        totalVolume: Object.values(sampleItems).reduce((sum, i) => sum + i.totalQty, 0),
        status: 'simulated'
      }
    };

    fs.writeFileSync(blockPath, JSON.stringify(blockData, null, 2), 'utf8');

    // Update index manifest
    const index = getIndex();
    index.blocks = index.blocks.filter(b => !(b.date === dateStr && b.hour === hourStr));
    index.blocks.push({
      date: dateStr,
      hour: hourStr,
      path: `datasets/${dateStr}/${hourStr}-00.json`,
      items: blockData.stats.totalItems,
      volume: blockData.stats.totalVolume,
      timestamp: unixNow,
      simulated: true
    });
    index.lastUpdated = now.toISOString();
    saveIndex(index);

    console.log(`[MarketSyncData Harvester] Wrote simulated block to ${blockPath}`);
    return blockData;
  }

  // Live Blizzard API harvest
  const client = createClient({
    region: REGION,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET
  });

  const dataset = {
    version: '1.0',
    timestamp: unixNow,
    isoDate: now.toISOString(),
    region: REGION,
    rulesets: {},
    stats: {
      totalItems: 0,
      totalVolume: 0,
      status: 'live'
    }
  };

  try {
    const rulesetsResp = await client.wowForever.rulesets();
    const rulesetList = rulesetsResp.rulesets || [];
    console.log(`Found ${rulesetList.length} Forever rulesets.`);

    for (const rsRef of rulesetList) {
      const rsId = rsRef.id;
      const rsData = await client.wowForever.ruleset(rsId);
      const rsName = (rsData.name && (rsData.name.en_US || rsData.name.en_GB || Object.values(rsData.name)[0])) || `Ruleset-${rsId}`;
      const canonicalName = String(rsName).toLowerCase().replace(/[^a-z0-9]/g, '');

      dataset.rulesets[canonicalName] = {};

      const housesResp = await client.wowForever.auctionHouses(rsId);
      const houses = housesResp.auctions || [];

      for (const house of houses) {
        const houseId = house.id;
        let houseName = house.name || 'Faction';
        if (houseId === 2 || String(houseName).toLowerCase().includes('horde')) houseName = 'Horde';
        else if (houseId === 6 || String(houseName).toLowerCase().includes('alliance')) houseName = 'Alliance';
        else if (houseId === 7 || String(houseName).toLowerCase().includes('neutral') || String(houseName).toLowerCase().includes('blackwater')) houseName = 'Neutral';

        console.log(`Fetching auctions for ${rsName} -> ${houseName} (House ID: ${houseId})...`);
        
        let auctions = [];
        let commodities = [];

        try {
          const aucResp = await client.wowForever.auctionHouse(rsId, houseId);
          auctions = aucResp.auctions || [];
        } catch (err) {
          console.warn(`Could not fetch regular auctions for house ${houseId}: ${err.message}`);
        }

        try {
          const comResp = await client.wowForever.auctionHouseCommodities(rsId, houseId);
          commodities = comResp.auctions || [];
        } catch (err) {
          console.warn(`Could not fetch commodities for house ${houseId}: ${err.message}`);
        }

        const aggregated = aggregateAuctionListings(auctions, commodities, unixNow);
        dataset.rulesets[canonicalName][houseName] = aggregated;

        const itemCount = Object.keys(aggregated).length;
        dataset.stats.totalItems += itemCount;
        dataset.stats.totalVolume += Object.values(aggregated).reduce((sum, i) => sum + i.totalQty, 0);

        console.log(`  -> ${houseName}: ${auctions.length} auctions, ${commodities.length} commodities => ${itemCount} unique items.`);
      }
    }

    const targetDir = path.join(DATASETS_DIR, dateStr);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const blockPath = path.join(targetDir, `${hourStr}-00.json`);
    fs.writeFileSync(blockPath, JSON.stringify(dataset, null, 2), 'utf8');

    // Update index manifest
    const index = getIndex();
    index.blocks = index.blocks.filter(b => !(b.date === dateStr && b.hour === hourStr));
    index.blocks.push({
      date: dateStr,
      hour: hourStr,
      path: `datasets/${dateStr}/${hourStr}-00.json`,
      items: dataset.stats.totalItems,
      volume: dataset.stats.totalVolume,
      timestamp: unixNow,
      simulated: false
    });
    index.lastUpdated = now.toISOString();
    saveIndex(index);

    console.log(`[MarketSyncData Harvester] Successfully saved hourly block to ${blockPath}`);
    return dataset;

  } catch (error) {
    console.error(`[MarketSyncData Harvester Error]`, error);
    process.exit(1);
  }
}

if (require.main === module) {
  harvest();
}

module.exports = { harvest, aggregateAuctionListings };
