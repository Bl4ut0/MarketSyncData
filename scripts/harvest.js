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

const REGION = process.env.BLIZZARD_REGION || 'us';
const CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const FLAVORS = (process.env.HARVEST_FLAVORS || 'forever,anniversary,classicEra,classic,retail')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '90', 10);

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
  const items = {};
  const validPrice = (value) => Number.isSafeInteger(value) && value > 0;

  for (const feed of [auctions, commodities]) {
    for (const listing of feed) {
      const item = listing?.item;
      const quantity = listing?.quantity ?? 1;
      if (!Number.isSafeInteger(item?.id) || item.id <= 0 || !Number.isSafeInteger(quantity) || quantity < 1) continue;
      const stackPrice = validPrice(listing.buyout) ? listing.buyout : listing.bid;
      const price = validPrice(listing.unit_price) ? listing.unit_price :
        validPrice(stackPrice) ? Math.max(1, Math.floor(stackPrice / quantity)) : 0;
      if (!price) continue;

      const suffix = item.id === 82800 && Number.isSafeInteger(item.pet_species_id) && item.pet_species_id > 0
        ? item.pet_species_id : item.rand ?? item.modifiers?.[0]?.value;
      const key = Number.isSafeInteger(suffix) && suffix !== 0 ? item.id + ':' + suffix : String(item.id);
      if (!items[key]) {
        items[key] = { minPrice: price, maxPrice: price, totalQty: quantity, listings: 1, time: timestamp };
      } else {
        const entry = items[key];
        entry.minPrice = Math.min(entry.minPrice, price);
        entry.maxPrice = Math.max(entry.maxPrice, price);
        entry.totalQty += quantity;
        entry.listings += 1;
      }
    }
  }
  return items;
}

function refId(ref, resource) {
  if (Number.isSafeInteger(ref?.id) && ref.id > 0) return ref.id;
  const href = String(ref?.key?.href ?? ref?.href ?? '');
  const id = href.match(new RegExp('/' + resource + '/(\\d+)(?:/|[?#]|$)'))?.[1];
  return id ? Number(id) : undefined;
}

function resolveHouseName(house) {
  const id = refId(house, 'auctions');
  const name = typeof house?.name === 'string' ? house.name : house?.name?.en_US ?? house?.name?.en_GB ?? '';
  const label = name.toLowerCase();
  if (id === 2 || label.includes('alliance')) return 'Alliance';
  if (id === 6 || label.includes('horde')) return 'Horde';
  if (id === 7 || label.includes('neutral') || label.includes('blackwater')) return 'Neutral';
  return name || 'House ' + (id ?? 'unknown');
}

const FOREVER_RULESET_HOUSES = {
  1: { Alliance: 110, Horde: 113, Neutral: 116 },  // PvP
  2: { Alliance: 111, Horde: 114, Neutral: 117 },  // Normal
  3: { Alliance: 119, Horde: 120, Neutral: 121 },  // Roleplay
  15: { Alliance: 123, Horde: 124, Neutral: 125 }, // Roleplay PvP
};

function newHarvest() {
  return { partitions: {}, markets: {} };
}

function failure(reason, error) {
  const httpStatus = error?.statusCode ?? error?.status;
  return { reason, ...(Number.isInteger(httpStatus) ? { httpStatus } : {}) };
}

async function readAuctions(request, acceptsOmittedList = () => false) {
  try {
    const response = await request();
    if (Array.isArray(response?.auctions)) return { rows: response.auctions };
    if (response?.auctions === undefined && acceptsOmittedList(response)) return { rows: [] };
    return { error: failure('invalid-auction-response') };
  } catch (error) {
    return { error: failure('auction-request-failed', error) };
  }
}

function recordMarket(result, partition, house, timestamp, auctions, commodities = { rows: [] }) {
  const errors = [auctions.error, commodities.error].filter(Boolean);
  const upstreamListings = (auctions.rows?.length ?? 0) + (commodities.rows?.length ?? 0);
  const entries = aggregateAuctionListings(auctions.rows, commodities.rows, timestamp);
  const counts = result.markets[partition] ??= {};
  const previous = counts[house];
  if (previous?.errors) errors.push(...previous.errors);
  if (upstreamListings > 0 && Object.keys(entries).length === 0) errors.push(failure('no-priced-listings-parsed'));

  if (!errors.length || Object.keys(entries).length) {
    const houses = result.partitions[partition] ??= {};
    const items = houses[house] ??= {};
    for (const [key, entry] of Object.entries(entries)) {
      const past = items[key];
      if (!past) {
        items[key] = entry;
        continue;
      }
      past.minPrice = Math.min(past.minPrice, entry.minPrice);
      past.maxPrice = Math.max(past.maxPrice, entry.maxPrice);
      past.totalQty += entry.totalQty;
      past.listings += entry.listings;
    }
  }

  const recorded = Object.values(result.partitions[partition]?.[house] ?? {});
  counts[house] = {
    status: errors.length ? (recorded.length ? 'partial' : 'unavailable') : (recorded.length ? 'available' : 'empty'),
    upstreamListings: upstreamListings + (previous?.upstreamListings ?? 0),
    items: recorded.length,
    quantity: recorded.reduce((sum, entry) => sum + entry.totalQty, 0),
    ...(errors.length ? { errors } : {}),
  };
  console.log('Market ' + JSON.stringify({ partition, house, ...counts[house] }));
}

function realmUrl(id, subpath, namespace) {
  const url = new URL('https://' + REGION + '.api.blizzard.com/data/wow/connected-realm/' + id + subpath);
  url.searchParams.set('namespace', namespace);
  return url;
}

async function harvestForever(client, timestamp) {
  const result = newHarvest();
  const listed = await client.wowForever.rulesets();
  for (const { id } of listed.rulesets) {
    const info = await client.wowForever.ruleset(id);
    const name = typeof info.name === 'string' ? info.name : info.name?.en_US ?? info.name?.en_GB ?? 'ruleset' + id;
    const ruleset = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const known = FOREVER_RULESET_HOUSES[id];
    const houses = known ? Object.entries(known) : (await client.wowForever.auctionHouses(id)).auctions
      .map(house => [resolveHouseName(house), refId(house, 'auctions')]);
    for (const [house, houseId] of houses) {
      if (!houseId) continue;
      const [auctions, commodities] = await Promise.all([
        readAuctions(() => client.wowForever.auctionHouse(id, houseId), data => Boolean(data?._links?.self && data.id === houseId)),
        readAuctions(() => client.wowForever.auctionHouseCommodities(id, houseId), data => Boolean(data?._links?.self)),
      ]);
      recordMarket(result, ruleset, house, timestamp, auctions, commodities);
    }
  }
  return result;
}

async function harvestConnectedRealms(client, timestamp, namespace, factionHouses) {
  const result = newHarvest();
  const request = (id, subpath = '') => client.requestHref(realmUrl(id, subpath, namespace).href);
  const { connected_realms: references } = await request('index');
  if (!Array.isArray(references)) throw new Error('Invalid connected realm index');

  for (const reference of references) {
    const id = refId(reference, 'connected-realm');
    if (!id) continue;
    let realm = 'cr' + id;
    try {
      realm = (await request(id)).realms?.[0]?.slug ?? realm;
    } catch (error) {
      console.warn(namespace + ' ' + realm + ' metadata: ' + JSON.stringify(failure('realm-request-failed', error)));
    }
    if (!factionHouses) {
      const auctions = await readAuctions(() => request(id, '/auctions'), data =>
        Boolean(data?._links?.self && data.connected_realm?.href && data.commodities?.href));
      recordMarket(result, realm, 'CrossFaction', timestamp, auctions);
      continue;
    }

    let houses;
    try {
      houses = (await request(id, '/auctions/index')).auctions;
      if (!Array.isArray(houses) || !houses.length) throw new Error('Invalid auction house index');
    } catch (error) {
      for (const house of ['Alliance', 'Horde', 'Neutral']) {
        recordMarket(result, realm, house, timestamp, { error: failure('house-index-unavailable', error) });
      }
      continue;
    }
    for (const house of houses) {
      const houseId = refId(house, 'auctions');
      const auctions = houseId
        ? await readAuctions(() => request(id, '/auctions/' + houseId), data =>
          Boolean(data?._links?.self && data.connected_realm?.href && data.id === houseId))
        : { error: failure('missing-house-id') };
      recordMarket(result, realm, resolveHouseName(house), timestamp, auctions);
    }
  }
  return result;
}

async function harvestRetail(client, timestamp) {
  const result = newHarvest();
  const commodities = await readAuctions(() => client.wow.commodities());
  recordMarket(result, 'region', 'Commodities', timestamp, { rows: [] }, commodities);
  return result;
}

function summarize(result) {
  const markets = Object.values(result.markets).flatMap(Object.values);
  const available = markets.filter(market => market.status === 'available').length;
  const empty = markets.filter(market => market.status === 'empty').length;
  const partial = markets.filter(market => market.status === 'partial').length;
  const unavailable = markets.filter(market => market.status === 'unavailable').length;
  return {
    status: available + empty + partial === 0 ? 'unavailable' : (partial + unavailable ? 'partial' : 'available'),
    counts: { available, empty, partial, unavailable },
    totalItems: markets.reduce((sum, market) => sum + market.items, 0),
    totalVolume: markets.reduce((sum, market) => sum + market.quantity, 0),
  };
}

function losesKnownListings(previous, result) {
  if (!previous || !result.markets) return false;
  return Object.entries(previous.rulesets ?? {}).some(([partition, houses]) => Object.entries(houses).some(([house, items]) => {
    if (!Object.keys(items).length) return false;
    const status = result.markets[partition]?.[house]?.status;
    return status !== 'available' && status !== 'empty';
  }));
}

async function saveFlavorBlock(flavor, dateStr, hourStr, now, unixNow, result, simulated = false) {
  const targetDir = path.join(DATASETS_DIR, flavor, dateStr);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const blockPath = path.join(targetDir, `${hourStr}-00.json`);
  if (fs.existsSync(blockPath)) {
    const previous = JSON.parse(fs.readFileSync(blockPath, 'utf8'));
    if (previous.stats?.status === 'live' && (simulated || losesKnownListings(previous, result))) {
      console.warn('[Harvester] Keeping the earlier ' + flavor + ' capture for this UTC hour.');
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

async function harvest({ client, flavors = FLAVORS, now = new Date() } = {}) {
  const dateStr = now.toISOString().slice(0, 10);
  const hourStr = String(now.getUTCHours()).padStart(2, '0');
  const unixNow = Math.floor(now.getTime() / 1000);

  console.log(`[MarketSyncData Harvester] Starting multi-flavor harvest (${flavors.join(', ')}) for ${dateStr} ${hourStr}:00 UTC...`);

  if (!client && (!CLIENT_ID || !CLIENT_SECRET)) {
    if (process.env.REQUIRE_LIVE_HARVEST === '1') throw new Error('Blizzard API credentials are required.');
    console.warn(`[WARNING] BLIZZARD_CLIENT_ID or BLIZZARD_CLIENT_SECRET not provided. Generating simulated blocks.`);
    const sampleItems = {
      '13464': { minPrice: 12500, maxPrice: 15000, totalQty: 48, listings: 6, time: unixNow },
      '13463': { minPrice: 8500, maxPrice: 9200, totalQty: 120, listings: 12, time: unixNow },
      '14344': { minPrice: 220000, maxPrice: 245000, totalQty: 4, listings: 4, time: unixNow }
    };
    const results = {};
    for (const flavor of flavors) {
      results[flavor] = await saveFlavorBlock(flavor, dateStr, hourStr, now, unixNow, {
        partitions: { english: { Horde: sampleItems, Alliance: sampleItems, Neutral: sampleItems } },
        totalItems: 9,
        totalVolume: 516
      }, true);
    }
    return results;
  }

  client ??= createClient({ region: REGION, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const namespaces = {
    anniversary: 'dynamic-classicann-' + REGION,
    classicEra: 'dynamic-classic1x-' + REGION,
    classic: 'dynamic-classic-' + REGION,
  };
  const results = {};
  const report = { checkedAt: now.toISOString(), region: REGION, editions: {} };
  for (const flavor of flavors) {
    try {
      let result;
      if (flavor === 'forever') result = await harvestForever(client, unixNow);
      else if (flavor === 'retail') result = await harvestRetail(client, unixNow);
      else if (namespaces[flavor]) result = await harvestConnectedRealms(client, unixNow, namespaces[flavor], flavor !== 'classic');
      else throw new Error('Unknown edition');
      const summary = summarize(result);
      report.editions[flavor] = { ...summary, markets: result.markets };
      if (summary.status === 'unavailable') {
        console.warn('[Harvester] ' + flavor + ' unavailable. The latest indexed capture is retained.');
        continue;
      }
      results[flavor] = await saveFlavorBlock(flavor, dateStr, hourStr, now, unixNow, { ...result, ...summary });
    } catch (error) {
      report.editions[flavor] = { status: 'unavailable', errors: [failure('edition-request-failed', error)] };
      console.error('[Harvester] ' + flavor + ': ' + JSON.stringify(report.editions[flavor].errors));
    }
  }
  fs.writeFileSync(path.join(DATASETS_DIR, 'harvest-status.json'), JSON.stringify(report, null, 2));
  if (!Object.keys(results).length) throw new Error('No edition returned a usable auction capture.');
  return results;
}

if (require.main === module) {
  harvest().catch(error => {
    console.error('[Harvester] ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { harvest, aggregateAuctionListings, pruneOldBlocks };
