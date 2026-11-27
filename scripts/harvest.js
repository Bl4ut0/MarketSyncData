/**
 * MarketSync DataSync - Multi-Flavor Hourly Auction Harvester
 * 
 * Fetches auction house and commodity data across all supported WoW flavors:
 *   - forever     (WoW: Forever rulesets)
 *   - anniversary (WoW Classic Anniversary realms via dynamic-classicann)
 *   - classicEra  (Classic Era / SoD / Hardcore)
 *   - classic     (Classic Progression: MoP / Cata / TBC)
 *   - retail      (Modern WoW + Region-wide Commodities)
 * 
 * Keeps all historical hourly blocks in datasets/.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@pinta365/blizzard_api');
const { updateItemCatalog } = require('./catalog');

const REGION = process.env.BLIZZARD_REGION || 'us';
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const FLAVORS = (process.env.HARVEST_FLAVORS || 'forever,anniversary,classicEra,classic,retail')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '90', 10);

// Blizzard has no auction API for these editions yet. Their data will come
// from player scan uploads, so the live harvest never calls the API for
// them. Their packs are still compiled and released (empty until uploads
// start). Set HARVEST_PLAYER_DATA_FLAVORS=1 to call the API for them anyway.
const PLAYER_DATA_FLAVORS = new Set(['anniversary', 'classicEra']);
function harvestsFromApi(flavor) {
  return !PLAYER_DATA_FLAVORS.has(flavor) || process.env.HARVEST_PLAYER_DATA_FLAVORS === '1';
}

const DATASETS_DIR = process.env.DATASETS_DIR || path.join(__dirname, '../datasets');
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

  for (const flavor of ['forever', 'anniversary', 'classicEra', 'classic', 'retail']) {
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

  for (const listing of [...auctions, ...commodities]) {
    const item = listing?.item;
    const qty = listing?.quantity ?? 1;
    if (!Number.isSafeInteger(item?.id) || item.id <= 0 || !Number.isSafeInteger(qty) || qty <= 0) continue;
    const isPrice = (value) => Number.isSafeInteger(value) && value > 0;
    const stackPrice = isPrice(listing.buyout) ? listing.buyout : listing.bid;
    const unitPrice = isPrice(listing.unit_price)
      ? listing.unit_price
      : isPrice(stackPrice) ? Math.max(1, Math.floor(stackPrice / qty)) : 0;
    if (!unitPrice) continue;

    const variant = item.id === 82800 && Number.isSafeInteger(item.pet_species_id) && item.pet_species_id > 0
      ? item.pet_species_id : (item.rand ?? item.modifiers?.[0]?.value);
    const key = Number.isSafeInteger(variant) && variant !== 0 ? `${item.id}:${variant}` : String(item.id);

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

  return itemMap;
}

function describeError(error) {
  return Number.isInteger(error?.statusCode) ? `HTTP ${error.statusCode}` : 'request failed';
}

async function readAuctions(label, request, allowMissing = false) {
  try {
    const response = await request();
    if (Array.isArray(response?.auctions)) return { rows: response.auctions };
    if (allowMissing && response && (response._links || response.id) && response.auctions === undefined) return { rows: [] };
    console.warn(`  ${label}: response has no auctions array (${Object.keys(response ?? {}).join(', ')})`);
    return { rows: [], error: 'missing auctions array' };
  } catch (error) {
    const reason = describeError(error);
    console.warn(`  ${label}: ${reason}`);
    return { rows: [], error: reason };
  }
}

function captureMarket(result, partition, house, auctions, commodities = { rows: [] }, timestamp) {
  const entries = aggregateAuctionListings(auctions.rows, commodities.rows, timestamp);
  const errors = [auctions.error, commodities.error].filter(Boolean);
  const upstreamListings = auctions.rows.length + commodities.rows.length;
  if (upstreamListings && !Object.keys(entries).length) {
    const sample = auctions.rows[0] ?? commodities.rows[0];
    errors.push('no priced listings parsed');
    console.warn(`  ${partition}@${house}: no priced listings parsed from ${upstreamListings} rows (${Object.keys(sample ?? {}).join(', ')})`);
  }

  result.partitions[partition] ??= {};
  result.markets[partition] ??= {};
  const market = result.partitions[partition][house] ??= {};
  const previous = result.markets[partition][house];
  if (previous?.errors) errors.push(...previous.errors);
  for (const [key, entry] of Object.entries(entries)) {
    const existing = market[key];
    if (existing) {
      existing.minPrice = Math.min(existing.minPrice, entry.minPrice);
      existing.maxPrice = Math.max(existing.maxPrice, entry.maxPrice);
      existing.totalQty += entry.totalQty;
      existing.listings += entry.listings;
    } else {
      market[key] = entry;
      result.totalItems += 1;
    }
    result.totalVolume += entry.totalQty;
  }
  const keys = Object.keys(market).length;
  const quantities = Object.values(market).reduce((sum, entry) => sum + entry.totalQty, 0);
  result.markets[partition][house] = {
    status: errors.length ? (keys ? 'partial' : 'unavailable') : (keys ? 'available' : 'empty'),
    upstreamListings: upstreamListings + (previous?.upstreamListings ?? 0),
    ...(errors.length ? { errors } : {}),
  };
  console.log(`  ${partition}@${house}: ${result.markets[partition][house].status}, ${keys} items, ${quantities} units`);
}

function newHarvest() {
  return { partitions: {}, markets: {}, connectedRealms: {}, totalItems: 0, totalVolume: 0 };
}

// Maps a Blizzard connected-realm detail to the realm slugs that share its auction house.
// Returns null when the detail has no realm list, so the caller keeps the fallback slug.
function connectedRealmRecord(id, detail, fallbackSlug) {
  const slugs = (detail?.realms ?? []).map((realm) => realm?.slug).filter(Boolean);
  if (!slugs.length) return null;
  return { connectedRealmId: id, primarySlug: slugs[0], slugs, fallback: fallbackSlug };
}

function recordConnectedRealm(result, id, detail, fallbackSlug) {
  const record = connectedRealmRecord(id, detail, fallbackSlug);
  if (record) result.connectedRealms[String(id)] = record;
}

function resolveHouseName(house) {
  const name = typeof house?.name === 'string' ? house.name : house?.name?.en_US ?? house?.name?.en_GB ?? '';
  const raw = name.toLowerCase();
  if (raw.includes('alliance')) return 'Alliance';
  if (raw.includes('horde')) return 'Horde';
  if (raw.includes('neutral') || raw.includes('blackwater')) return 'Neutral';
  const id = auctionId(house, 'auctions');
  if (id === 2) return 'Alliance';
  if (id === 6) return 'Horde';
  if (id === 7) return 'Neutral';
  return name || `House ${id ?? 'unknown'}`;
}

const FOREVER_RULESET_HOUSES = {
  1: { Alliance: 110, Horde: 113, Neutral: 116 },  // PvP
  2: { Alliance: 111, Horde: 114, Neutral: 117 },  // Normal
  3: { Alliance: 119, Horde: 120, Neutral: 121 },  // Roleplay
  15: { Alliance: 123, Horde: 124, Neutral: 125 }, // Roleplay PvP
};

function auctionId(ref, pathPart) {
  if (Number.isSafeInteger(ref?.id) && ref.id > 0) return ref.id;
  const href = ref?.href ?? ref?.key?.href ?? "";
  const match = String(href).match(new RegExp("/" + pathPart + "/(\\d+)(?:/|[?#]|$)"));
  return match ? Number(match[1]) : null;
}

function realmUrl(id, endpoint, namespace) {
  const url = new URL("https://" + REGION + ".api.blizzard.com/data/wow/connected-realm/" + id + endpoint);
  url.searchParams.set("namespace", namespace);
  return url.href;
}

async function harvestForever(client, unixNow) {
  const result = newHarvest();
  const { rulesets } = await client.wowForever.rulesets();
  console.log("[Forever] Found " + rulesets.length + " rulesets.");

  for (const { id } of rulesets) {
    const info = await client.wowForever.ruleset(id);
    const name = typeof info.name === "string" ? info.name : info.name?.en_US ?? info.name?.en_GB ?? "ruleset" + id;
    const ruleset = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const knownHouses = FOREVER_RULESET_HOUSES[id];
    const houses = knownHouses ? Object.entries(knownHouses) :
      (await client.wowForever.auctionHouses(id)).auctions.map((house) => [resolveHouseName(house), auctionId(house, "auctions")]);

    for (const [house, houseId] of houses) {
      if (!houseId) continue;
      const [auctions, commodities] = await Promise.all([
        readAuctions("[Forever] " + ruleset + "/" + houseId + " auctions", () => client.wowForever.auctionHouse(id, houseId), true),
        readAuctions("[Forever] " + ruleset + "/" + houseId + " commodities", () => client.wowForever.auctionHouseCommodities(id, houseId), true),
      ]);
      captureMarket(result, ruleset, house, auctions, commodities, unixNow);
    }
  }
  return result;
}

async function harvestFactionRealms(client, unixNow, flavor, namespace) {
  const result = newHarvest();
  const { connected_realms: realms } = await client.requestHref(realmUrl("index", "", namespace));
  let trailingSlash;
  console.log("[" + flavor + "] Found " + realms.length + " connected realms (" + namespace + ").");

  for (const reference of realms) {
    const id = auctionId(reference, "connected-realm");
    if (!id) continue;
    let slug = "cr" + id;
    try {
      const detail = await client.requestHref(realmUrl(id, "", namespace));
      slug = detail.realms?.[0]?.slug ?? slug;
      recordConnectedRealm(result, id, detail, slug);
    } catch (error) {
      console.warn("  [" + flavor + "] " + slug + " realm details: " + describeError(error));
    }
    try {
      const { auctions: houses } = await client.requestHref(realmUrl(id, "/auctions/index", namespace));
      if (!Array.isArray(houses)) throw new Error("No auction house index");
      for (const house of houses) {
        const faction = resolveHouseName(house);
        const houseId = auctionId(house, "auctions");
        const label = "[" + flavor + "] " + slug + "/" + faction + " (house " + houseId + ")";
        const auctions = houseId ? await readAuctions(label, async () => {
          const endpoint = "/auctions/" + houseId;
          try {
            return await client.requestHref(realmUrl(id, endpoint + (trailingSlash ? "/" : ""), namespace));
          } catch (error) {
            if (error?.statusCode !== 404 || trailingSlash !== undefined) throw error;
            trailingSlash = false;
            const alternate = await client.requestHref(realmUrl(id, endpoint + "/", namespace));
            trailingSlash = true;
            return alternate;
          }
        }) : { rows: [], error: "no auction house ID" };
        captureMarket(result, slug, faction, auctions, undefined, unixNow);
      }
    } catch (error) {
      for (const faction of ["Alliance", "Horde", "Neutral"]) {
        captureMarket(result, slug, faction, { rows: [], error: "auction house index: " + describeError(error) }, undefined, unixNow);
      }
    }
  }
  return result;
}

async function harvestClassic(client, unixNow) {
  const result = newHarvest();
  const { connected_realms: realms } = await client.wowClassic.connectedRealms();
  console.log("[Classic Progression] Found " + realms.length + " connected realms.");

  for (const reference of realms) {
    const id = auctionId(reference, "connected-realm");
    if (!id) continue;
    let slug = "cr" + id;
    try {
      const detail = await client.wowClassic.connectedRealm(id);
      slug = detail.realms?.[0]?.slug ?? slug;
      recordConnectedRealm(result, id, detail, slug);
    } catch (error) {
      console.warn("  [Classic] " + slug + " realm details: " + describeError(error));
    }
    const auctions = await readAuctions("[Classic] " + slug, () => client.wowClassic.auctions(id));
    captureMarket(result, slug, "CrossFaction", auctions, undefined, unixNow);
  }
  return result;
}

async function harvestRetail(client, unixNow) {
  const result = newHarvest();
  const commodities = await readAuctions("[Retail] Region Commodities", () => client.wow.commodities());
  captureMarket(result, "region", "Commodities", { rows: [] }, commodities, unixNow);
  return result;
}

async function saveFlavorBlock(flavor, dateStr, hourStr, now, unixNow, result, simulated = false) {
  const targetDir = path.join(DATASETS_DIR, flavor, dateStr);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const blockPath = path.join(targetDir, `${hourStr}-00.json`);
  if (fs.existsSync(blockPath)) {
    const previous = JSON.parse(fs.readFileSync(blockPath, 'utf8'));
    if (previous.stats?.status === 'live' && (simulated || (previous.stats.totalItems > 0 && result.totalItems === 0))) {
      console.warn(`[Harvester] Keeping the earlier ${flavor} capture for this hour.`);
      return previous;
    }
  }
  const blockData = {
    version: '1.0',
    flavor,
    timestamp: unixNow,
    isoDate: now.toISOString(),
    region: REGION,
    rulesets: result.partitions,
    ...(result.markets ? { markets: result.markets } : {}),
    ...(Object.keys(result.connectedRealms ?? {}).length ? { connectedRealms: result.connectedRealms } : {}),
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

  if (!CLIENT_ID || !CLIENT_SECRET) {
    if (process.env.REQUIRE_LIVE_HARVEST === '1') throw new Error('Blizzard API credentials are required for the live harvest.');
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
    if (!harvestsFromApi(flavor)) {
      console.log(`[Harvester] ${flavor}: no Blizzard auction API; data comes from player uploads. Skipped.`);
      continue;
    }
    try {
      let res;
      if (flavor === 'forever') res = await harvestForever(client, unixNow);
      else if (flavor === 'anniversary') res = await harvestFactionRealms(client, unixNow, 'Anniversary', `dynamic-classicann-${REGION}`);
      else if (flavor === 'classicEra') res = await harvestFactionRealms(client, unixNow, 'Classic Era', `dynamic-classic1x-${REGION}`);
      else if (flavor === 'classic') res = await harvestClassic(client, unixNow);
      else if (flavor === 'retail') res = await harvestRetail(client, unixNow);

      if (res) {
        results[flavor] = await saveFlavorBlock(flavor, dateStr, hourStr, now, unixNow, res, false);
        if (process.env.HARVEST_CATALOG !== '0') {
          try {
            await updateItemCatalog({ client, flavor, region: REGION, partitions: res.partitions, datasetsDir: DATASETS_DIR, now });
          } catch {
            console.warn(`[Catalog] ${flavor} metadata could not be updated this run.`);
          }
        }
      }
    } catch (err) {
      console.error(`[Harvester Error] Flavor ${flavor} failed: ${err.message}`);
    }
  }

  if (!Object.keys(results).length) throw new Error('No edition could be harvested.');
  return results;
}

if (require.main === module) {
  harvest().catch((error) => {
    console.error(`[Harvester] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { harvest, harvestFactionRealms, aggregateAuctionListings, pruneOldBlocks, connectedRealmRecord, harvestsFromApi };
