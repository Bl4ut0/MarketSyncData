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
const DIST_DIR = path.join(__dirname, '../dist');
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

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
if (!fs.existsSync(BUILDS_DIR)) fs.mkdirSync(BUILDS_DIR, { recursive: true });

function compileFlavor(flavor, now = new Date()) {
  const flavorDir = path.join(DATASETS_DIR, flavor);
  const cutoffDate = new Date(now.getTime() - RETENTION_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  const dateStr = now.toISOString().slice(0, 10);
  const versionTag = dateStr.replace(/-/g, '.');
  const unixNow = Math.floor(now.getTime() / 1000);

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
                const existing = partition[itemKey];
                const obsTime = entry.time || block.timestamp;
                if (!existing || obsTime >= existing.t) {
                  partition[itemKey] = {
                    m: entry.minPrice,
                    q: entry.totalQty,
                    t: obsTime
                  };
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

  let totalUniqueItems = 0;
  for (const [partitionKey, items] of Object.entries(mergedPartitions)) {
    const keys = Object.keys(items);
    totalUniqueItems += keys.length;
    lua += `MarketSyncDataDB["${partitionKey}"] = {\n`;
    for (const key of keys) {
      const e = items[key];
      lua += `  ["${key}"] = { m = ${e.m}, q = ${e.q}, t = ${e.t} },\n`;
    }
    lua += `}\n\n`;
  }

  // Write to per-flavor build folder
  const cfg = FLAVOR_CONFIG[flavor];
  const buildAddonDir = path.join(BUILDS_DIR, cfg.label, 'MarketSyncData');
  if (!fs.existsSync(buildAddonDir)) fs.mkdirSync(buildAddonDir, { recursive: true });

  // Copy Core.lua
  fs.copyFileSync(path.join(ADDON_DIR, 'Core.lua'), path.join(buildAddonDir, 'Core.lua'));

  // Write flavor-specific .toc
  const tocContent = [
    `## Interface: ${cfg.interfaces}`,
    `## Title: MarketSyncData (${cfg.label})`,
    `## Notes: 90-day compiled auction data pack for MarketSync (${cfg.label}).`,
    `## Author: MarketSync Team`,
    `## Version: ${versionTag}`,
    `## OptionalDeps: MarketSync`,
    `## DefaultState: Enabled`,
    `## LoadOnDemand: 0`,
    `## AllowLoadGameType: ${cfg.allowLoadGameType}`,
    `## X-Category: Auction & Economy`,
    `## X-Part-Of: MarketSync`,
    ``,
    `Core.lua`,
    `MarketSyncData.lua`,
    ``
  ].join('\n');
  fs.writeFileSync(path.join(buildAddonDir, 'MarketSyncData.toc'), tocContent, 'utf8');
  fs.writeFileSync(path.join(buildAddonDir, 'MarketSyncData.lua'), lua, 'utf8');

  // Also update root MarketSyncData/MarketSyncData.lua if this is forever
  if (flavor === 'forever') {
    fs.writeFileSync(path.join(ADDON_DIR, 'MarketSyncData.lua'), lua, 'utf8');
    const rootTocPath = path.join(ADDON_DIR, 'MarketSyncData.toc');
    if (fs.existsSync(rootTocPath)) {
      let rootToc = fs.readFileSync(rootTocPath, 'utf8');
      rootToc = rootToc.replace(/## Version: .*/, `## Version: ${versionTag}`);
      fs.writeFileSync(rootTocPath, rootToc, 'utf8');
    }
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

module.exports = { compileAll, compileFlavor, FLAVOR_CONFIG };
