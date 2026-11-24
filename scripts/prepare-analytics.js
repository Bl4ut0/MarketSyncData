const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  HISTORY_RANGES, MAX_ANALYTICS_CAPTURES, analyzeMarket, enrichEntry, groupAuctionVariants,
  indexMarketObservations, normalizeSnapshot, packAnalyticsReport, parseDatasetIndex, selectHistoryBlocks,
} = require('./analytics-engine.cjs');

const ENGINE_REVISION = createHash('sha256')
  .update(fs.readFileSync(require.resolve('./analytics-engine.cjs')))
  .update(fs.readFileSync(__filename))
  .digest('hex');
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readCapture(dataDir, block) {
  const relativePath = block.path.slice('datasets/'.length);
  const snapshot = normalizeSnapshot(readJson(path.join(dataDir, relativePath)), block.flavor);
  if (snapshot.timestamp !== block.timestamp) throw new Error(`Changed capture: ${block.path}`);
  return snapshot;
}

function readCatalog(dataDir, flavor) {
  try {
    return fs.readFileSync(path.join(dataDir, flavor, 'catalog.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '{}';
  }
}

function prepareFlavor(dataDir, outputDir, anchor, samplesByRange, catalog, revision) {
  const current = readCapture(dataDir, anchor);
  const markets = [];
  const partitions = [];
  for (const partition of Object.values(current.partitions)) {
    if (!SAFE_SEGMENT.test(partition.key)) continue;
    const factions = [];
    for (const [faction, entries] of Object.entries(partition.factions)) {
      if (!SAFE_SEGMENT.test(faction) || Object.keys(entries).length === 0) continue;
      factions.push(faction);
      markets.push({
        partition: partition.key,
        faction,
        rows: groupAuctionVariants(Object.values(entries).map((entry) =>
          enrichEntry(entry, anchor.flavor, catalog[entry.itemId]))),
        samples: new Map([[anchor.path, indexMarketObservations(anchor.timestamp, entries)]]),
      });
    }
    partitions.push({ key: partition.key, label: partition.label, entryCount: partition.entryCount, factions });
  }

  const planned = new Map(samplesByRange.flatMap(([_, blocks]) => blocks.map((block) => [block.path, block])));
  planned.delete(anchor.path);
  for (const block of markets.length ? planned.values() : []) {
    try {
      const snapshot = readCapture(dataDir, block);
      for (const market of markets) {
        const entries = snapshot.partitions[market.partition]?.factions[market.faction];
        if (entries) market.samples.set(block.path, indexMarketObservations(block.timestamp, entries));
      }
    } catch (error) {
      console.warn(`[Analytics] Skipping historical capture ${block.path}: ${error.message}`);
    }
  }

  for (const { partition, faction, rows, samples } of markets) {
    const output = path.join(outputDir, 'analytics', 'v2', anchor.flavor, revision, partition, faction);
    fs.mkdirSync(output, { recursive: true });
    for (const [hours, blocks] of samplesByRange) {
      const observations = [samples.get(anchor.path)];
      for (const block of blocks) {
        if (block.path !== anchor.path && samples.has(block.path)) observations.push(samples.get(block.path));
      }
      const { categories, view } = analyzeMarket(rows, observations, anchor.flavor);
      const report = packAnalyticsReport(anchor.timestamp, categories, view);
      fs.writeFileSync(path.join(output, `${hours}.json`), JSON.stringify(report));
    }
  }

  console.log(`[Analytics] ${anchor.flavor}: wrote ${markets.length * HISTORY_RANGES.length} reports for ${anchor.path}.`);
  return { revision, partitions };
}

function pruneReports(root, keep) {
  if (!fs.existsSync(root)) return;
  const rootPath = fs.realpathSync(root);
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name) && !keep.has(entry.name)) {
      const target = path.join(rootPath, entry.name);
      if (fs.realpathSync(target) === target) fs.rmSync(target, { recursive: true });
    }
  }
}

function prepareAnalytics(dataDir = process.env.DATASETS_DIR || path.join(__dirname, '../datasets'),
                          outputDir = dataDir) {
  const index = readJson(path.join(dataDir, 'index.json'));
  const { blocks, latestLiveByFlavor } = parseDatasetIndex(index, { includeSimulated: false });
  let changed = 0;
  const retain = new Map();

  for (const anchor of Object.values(latestLiveByFlavor)) {
    const current = index.blocks.find((block) => block.path === anchor.path && block.timestamp === anchor.timestamp);
    const samplesByRange = HISTORY_RANGES.map((hours) => [hours,
      selectHistoryBlocks(blocks, anchor, hours).slice(0, MAX_ANALYTICS_CAPTURES)]);
    const catalogJson = readCatalog(dataDir, anchor.flavor);
    const revisions = index.blocks.filter((block) => block.flavor === anchor.flavor && block.analytics)
      .sort((a, b) => b.timestamp - a.timestamp);
    const revision = createHash('sha256').update(ENGINE_REVISION).update(catalogJson)
      .update(JSON.stringify(samplesByRange.map(([hours, sample]) => [hours,
        sample.map(({ path, timestamp }) => [path, timestamp])])))
      .digest('hex').slice(0, 24);
    const reportRoot = path.join(outputDir, 'analytics', 'v2', anchor.flavor);
    if (current.analytics?.revision === revision && (
      !current.analytics.partitions.some((partition) => partition.factions.length > 0) ||
      fs.existsSync(path.join(reportRoot, revision))
    )) continue;

    const catalog = JSON.parse(catalogJson);
    const items = catalog.version === 1 && catalog.flavor === anchor.flavor ? catalog.items ?? {} : {};
    const manifest = prepareFlavor(dataDir, outputDir, anchor, samplesByRange, items, revision);
    const previous = revisions.find((block) => block !== current);
    const keep = new Set([revision, previous?.analytics.revision, current.analytics?.revision]);
    for (const block of revisions) {
      if (block !== current && block !== previous) delete block.analytics;
    }
    current.analytics = manifest;
    retain.set(reportRoot, keep);
    changed += 1;
  }

  if (changed) {
    fs.mkdirSync(outputDir, { recursive: true });
    const outputIndex = path.join(outputDir, 'index.json');
    const tempPath = `${outputIndex}.analytics.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(tempPath, outputIndex);
    for (const [root, keep] of retain) pruneReports(root, keep);
  }
  return changed;
}

if (require.main === module) prepareAnalytics();
module.exports = { prepareAnalytics };
