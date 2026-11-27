/**
 * MarketSync DataSync - 90-Day Multi-Flavor Dataset Compiler
 * 
 * Compiles up to 90 days of hourly dataset blocks per game flavor into
 * optimized MarketSyncData.lua builds for each WoW release version:
 *   - Forever (16001)
 *   - ClassicEra / Anniversary / SoD (11509, 11508)
 *   - Classic Progression (50503, 38000, 20506, 20505)
 *   - Retail (120001, 120000)
 */

const fs = require('fs');
const path = require('path');

const DATASETS_DIR = process.env.DATASETS_DIR || path.join(__dirname, '../datasets');
const ADDON_DIR = path.join(__dirname, '../MarketSyncData');
const DIST_DIR = process.env.MARKETSYNC_BUILD_DIR || path.join(__dirname, '../dist');
const BUILDS_DIR = path.join(DIST_DIR, 'builds');
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '90', 10);

const FLAVOR_CONFIG = {
  forever: {
    label: 'Forever',
    interfaces: '16001',
    allowLoadGameType: 'camelot'
  },
  anniversary: {
    label: 'Anniversary',
    interfaces: '20506, 20505, 11509, 11508',
    allowLoadGameType: 'classic, tbc'
  },
  classicEra: {
    label: 'ClassicEra',
    interfaces: '11509, 11508',
    allowLoadGameType: 'classic'
  },
  classic: {
    label: 'Classic',
    interfaces: '50503, 38000, 20506, 20505',
    allowLoadGameType: 'classic'
  },
  retail: {
    label: 'Retail',
    interfaces: '120001, 120000',
    allowLoadGameType: 'mainline'
  }
};

// Market gate from scripts/pack-markets.json. Only live Forever rulesets ship, so a planned
// market (hardcore until launch) produces no pack. Empty partitions are skipped in the loop below.
const MARKETS = JSON.parse(fs.readFileSync(path.join(__dirname, 'pack-markets.json'), 'utf8'));
const LIVE_FOREVER_RULESETS = new Set(MARKETS.forever.markets.filter(m => m.live).map(m => m.ruleset));
function IsBuildablePartition(flavor, partitionKey) {
  if (flavor !== 'forever') return true;
  return LIVE_FOREVER_RULESETS.has(partitionKey.split('@')[0]);
}

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
if (!fs.existsSync(BUILDS_DIR)) fs.mkdirSync(BUILDS_DIR, { recursive: true });

// Same tiers as MarketSync's in-game retention (Core.lua DownsampleRetention):
//   Hot  (age 0-7 days):   every 30-minute snapshot, "offset:price36:qty36,..."
//   Warm (age 8-30 days):  one daily summary, "D:min36:max36:avg36:vol36"
//   Cold (age 31+ days):   one weekly summary per week, key "W_<week>", "W:min36:max36:avg36:vol36"
const HOT_DAYS = 7;
const WARM_DAYS = 30;
const b36 = n => Math.round(n).toString(36);

function dailySummary(buckets) {
  let min = Infinity, max = 0, sum = 0, vol = 0, count = 0;
  for (const o of Object.keys(buckets)) {
    const { p, q } = buckets[o];
    if (p < min) min = p;
    if (p > max) max = p;
    sum += p;
    vol += q;
    count++;
  }
  return { min, max, avg: Math.floor(sum / count), vol };
}

// Mirrors MarketSync.MergeCompactRecords: avg weighted by volume.
function mergeSummary(a, b) {
  if (!a) return b;
  if (!b) return a;
  const total = a.vol + b.vol;
  const avg = total > 0 ? Math.floor((a.avg * a.vol + b.avg * b.vol) / total) : Math.floor((a.avg + b.avg) / 2);
  return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max), avg, vol: total };
}

function tieredHistory(days, todayIdx) {
  const entries = [];
  const weekly = {};
  for (const dStr of Object.keys(days)) {
    const d = Number(dStr);
    const age = todayIdx - d;
    const buckets = days[d];
    if (age <= HOT_DAYS) {
      const granular = Object.keys(buckets).map(Number).sort((a, b) => a - b)
        .map(o => `${o}:${b36(buckets[o].p)}:${b36(buckets[o].q)}`);
      entries.push(`[${d}] = "${granular.join(',')}"`);
    } else if (age <= WARM_DAYS) {
      const s = dailySummary(buckets);
      entries.push(`[${d}] = "D:${b36(s.min)}:${b36(s.max)}:${b36(s.avg)}:${b36(s.vol)}"`);
    } else {
      const wk = Math.floor(d / 7);
      weekly[wk] = mergeSummary(weekly[wk], dailySummary(buckets));
    }
  }
  for (const wk of Object.keys(weekly).map(Number).sort((a, b) => a - b)) {
    const s = weekly[wk];
    entries.push(`["W_${wk}"] = "W:${b36(s.min)}:${b36(s.max)}:${b36(s.avg)}:${b36(s.vol)}"`);
  }
  return entries;
}

function compileFlavor(flavor, now = new Date()) {
  const flavorDir = path.join(DATASETS_DIR, flavor);
  const cutoffDate = new Date(now.getTime() - RETENTION_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  const dateStr = now.toISOString().slice(0, 10);
  const versionTag = dateStr.replace(/-/g, '.');
  const unixNow = Math.floor(now.getTime() / 1000);
  const todayIdx = Math.floor(unixNow / 86400);

  const mergedPartitions = {};
  let blocksMerged = 0;

  if (fs.existsSync(flavorDir)) {
    const dateDirs = fs.readdirSync(flavorDir)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cutoffDate)
      .sort();

    for (const dDir of dateDirs) {
      const fullDateDir = path.join(flavorDir, dDir);
      const blockFiles = fs.readdirSync(fullDateDir).filter(f => f.endsWith('.json')).sort();

      for (const file of blockFiles) {
        try {
          const block = JSON.parse(fs.readFileSync(path.join(fullDateDir, file), 'utf8'));
          if (!block.rulesets) continue;
          blocksMerged++;

          for (const [rulesetKey, factions] of Object.entries(block.rulesets)) {
            for (const [factionName, items] of Object.entries(factions)) {
              const partitionKey = `${rulesetKey}@${factionName}`;
              if (!mergedPartitions[partitionKey]) mergedPartitions[partitionKey] = {};
              const partition = mergedPartitions[partitionKey];

              for (const [itemKey, entry] of Object.entries(items)) {
                const obsTime = entry.time || block.timestamp;
                if (!partition[itemKey]) partition[itemKey] = { m: entry.minPrice, q: entry.totalQty, t: obsTime, days: {} };
                const existing = partition[itemKey];
                if (obsTime >= existing.t) {
                  existing.m = entry.minPrice;
                  existing.q = entry.totalQty;
                  existing.t = obsTime;
                }
                // Every hourly snapshot is kept, in MarketSync's in-game granular format:
                // days[scanDay][bucketOffset] = { p, q, t }. Scan day = floor(unix / 86400) and
                // bucket offset = 30-minute slot within that day (0..47), as MarketSync computes them.
                if (entry.minPrice > 0) {
                  const dayIndex = Math.floor(obsTime / 86400);
                  const offset = Math.floor((obsTime % 86400) / 1800);
                  const dayBuckets = existing.days[dayIndex] || (existing.days[dayIndex] = {});
                  const snap = dayBuckets[offset];
                  if (!snap || obsTime >= snap.t) {
                    dayBuckets[offset] = { p: entry.minPrice, q: entry.totalQty, t: obsTime };
                  }
                }
              }
            }
          }
        } catch (err) {
          console.warn(`[Compiler] Error reading ${flavor}/${dDir}/${file}: ${err.message}`);
        }
      }
    }
  }

  // Generate Lua table
  let lua = `-- ============================================================================\n`;
  lua += `-- MarketSyncData (${flavor}) - 90-Day Compiled Auction Dataset (${dateStr})\n`;
  lua += `-- ============================================================================\n`;
  lua += `-- Generated: ${now.toISOString()}\n`;
  lua += `-- Retention Window: ${RETENTION_DAYS} days | Blocks Merged: ${blocksMerged}\n`;
  lua += `-- ============================================================================\n\n`;
  lua += `MarketSyncDataDB = MarketSyncDataDB or {}\n`;
  lua += `MarketSyncData.generatedAt = ${unixNow}\n`;
  lua += `MarketSyncData.version = "${versionTag}"\n`;
  lua += `MarketSyncData.flavor = "${flavor}"\n\n`;

  // Header shared by the single file and every Forever pack.
  const headerLua = lua;

  // Lua 5.1 caps each function at 262143 constants, and every history string and key is one.
  // Items are written in chunks, each inside its own function, so no single function overflows.
  const CONSTANT_BUDGET = 150000;
  let totalUniqueItems = 0;
  const partitionLua = {};
  for (const [partitionKey, items] of Object.entries(mergedPartitions)) {
    if (!IsBuildablePartition(flavor, partitionKey)) continue;
    const keys = Object.keys(items);
    if (keys.length === 0) continue;
    totalUniqueItems += keys.length;
    let body = `MarketSyncDataDB["${partitionKey}"] = MarketSyncDataDB["${partitionKey}"] or {}\n`;
    let chunk = [];
    let budget = 0;
    const flush = () => {
      if (chunk.length === 0) return;
      body += `;(function(t)\n${chunk.join('')}end)(MarketSyncDataDB["${partitionKey}"])\n`;
      chunk = [];
      budget = 0;
    };
    for (const key of keys) {
      const e = items[key];
      const hist = tieredHistory(e.days, todayIdx);
      // Rough constant cost: key, m, q, t, plus a key and value string per history entry.
      const cost = 4 + 2 * hist.length;
      if (budget + cost > CONSTANT_BUDGET) flush();
      budget += cost;
      chunk.push(`  t["${key}"] = { m = ${e.m}, q = ${e.q}, t = ${e.t}, h = { ${hist.join(', ')} } }\n`);
    }
    flush();
    body += `\n`;
    partitionLua[partitionKey] = body;
  }

  // Write to per-flavor build folder
  const cfg = FLAVOR_CONFIG[flavor];
  const buildAddonDir = path.join(BUILDS_DIR, cfg.label, 'MarketSyncData');
  if (!fs.existsSync(buildAddonDir)) fs.mkdirSync(buildAddonDir, { recursive: true });

  // Copy Core.lua
  fs.copyFileSync(path.join(ADDON_DIR, 'Core.lua'), path.join(buildAddonDir, 'Core.lua'));

  // Forever is split into one LoadOnDemand pack per ruleset and faction. The core addon then
  // holds only the loader, and the character's own pack is loaded on demand.
  const splitPacks = flavor === 'forever';
  const tocContent = [
    `## Interface: ${cfg.interfaces}`,
    `## Title: MarketSyncData (${cfg.label})`,
    `## Notes: ${splitPacks ? 'Loader for the MarketSync data packs' : '90-day compiled auction data pack for MarketSync'} (${cfg.label}).`,
    `## Author: MarketSync Team`,
    `## Version: ${versionTag}`,
    `## OptionalDeps: MarketSync`,
    `## DefaultState: Enabled`,
    `## LoadOnDemand: 0`,
    `## AllowLoadGameType: ${cfg.allowLoadGameType}`,
    `## X-Category: Auction & Economy`,
    `## X-Part-Of: MarketSync`,
    ``,
    ...(splitPacks ? ['Flavor.lua'] : []),
    `Core.lua`,
    ...(splitPacks ? [] : ['MarketSyncData.lua']),
    ``
  ].join('\n');
  fs.writeFileSync(path.join(buildAddonDir, 'MarketSyncData.toc'), tocContent, 'utf8');

  if (splitPacks) {
    // Flavor is set before Core.lua runs, so the loader knows to load a pack before any pack is loaded.
    fs.writeFileSync(path.join(buildAddonDir, 'Flavor.lua'), `MarketSyncData = MarketSyncData or {}\nMarketSyncData.flavor = "${flavor}"\n`, 'utf8');
    fs.rmSync(path.join(buildAddonDir, 'MarketSyncData.lua'), { force: true });
    const packsDir = path.join(BUILDS_DIR, cfg.label, 'packs');
    fs.rmSync(packsDir, { recursive: true, force: true });
    fs.mkdirSync(packsDir, { recursive: true });
    const built = [];
    for (const market of MARKETS.forever.markets.filter(m => m.live)) {
      for (const faction of MARKETS.forever.factions) {
        const own = `${market.ruleset}@${faction}`;
        if (!partitionLua[own]) {
          console.warn(`[Compiler] ${cfg.label}: no data for ${own}; no pack built.`);
          continue;
        }
        // Each faction pack carries its ruleset's Neutral auction data too.
        const neutral = `${market.ruleset}@Neutral`;
        const body = [own, neutral].filter(k => partitionLua[k]).map(k => partitionLua[k]).join('');
        const name = `MarketSyncData_Forever_${market.ruleset}_${faction}`;
        const packDir = path.join(packsDir, name);
        fs.mkdirSync(packDir, { recursive: true });
        fs.writeFileSync(path.join(packDir, `${name}.lua`), headerLua + body, 'utf8');
        fs.writeFileSync(path.join(packDir, `${name}.toc`), [
          `## Interface: ${cfg.interfaces}`,
          `## Title: ${name}`,
          `## Notes: MarketSync data pack for the ${market.ruleset} ${faction} market (includes Neutral auction data).`,
          `## Author: MarketSync Team`,
          `## Version: ${versionTag}`,
          `## Dependencies: MarketSyncData`,
          `## LoadOnDemand: 1`,
          `## DefaultState: Enabled`,
          `## AllowLoadGameType: ${cfg.allowLoadGameType}`,
          `## X-Category: Auction & Economy`,
          `## X-Part-Of: MarketSync`,
          ``,
          `${name}.lua`,
          ``
        ].join('\n'), 'utf8');
        built.push(name);
      }
    }
    console.log(`[Compiler] ${cfg.label}: ${built.length} pack(s) -> ${packsDir}`);
  } else {
    fs.writeFileSync(path.join(buildAddonDir, 'MarketSyncData.lua'), headerLua + Object.values(partitionLua).join(''), 'utf8');
  }

  console.log(`[Compiler] ${cfg.label}: ${blocksMerged} blocks merged -> ${totalUniqueItems} records.`);

  return {
    flavor,
    label: cfg.label,
    blocksMerged,
    partitions: Object.keys(mergedPartitions),
    totalUniqueItems
  };
}

function compileAll() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const summary = {
    date: dateStr,
    version: dateStr.replace(/-/g, '.'),
    retentionDays: RETENTION_DAYS,
    generatedAt: now.toISOString(),
    flavors: {}
  };

  for (const flavor of Object.keys(FLAVOR_CONFIG)) {
    summary.flavors[flavor] = compileFlavor(flavor, now);
  }

  fs.writeFileSync(path.join(DIST_DIR, 'compile-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

if (require.main === module) {
  compileAll();
}

module.exports = { compileAll, compileFlavor, FLAVOR_CONFIG, IsBuildablePartition };
