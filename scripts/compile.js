/**
 * MarketSync DataSync - Daily Dataset Compiler
 * 
 * Aggregates all hourly dataset blocks from the day into a unified,
 * compressed MarketSyncData.lua table formatted for in-game loading.
 */

const fs = require('fs');
const path = require('path');

const DATASETS_DIR = path.join(__dirname, '../datasets');
const ADDON_DIR = path.join(__dirname, '../MarketSyncData');
const OUTPUT_LUA = path.join(ADDON_DIR, 'MarketSyncData.lua');
const DIST_DIR = path.join(__dirname, '../dist');

// Ensure directories exist
if (!fs.existsSync(ADDON_DIR)) fs.mkdirSync(ADDON_DIR, { recursive: true });
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

function compileDay(targetDateStr) {
  const now = new Date();
  const dateStr = targetDateStr || now.toISOString().slice(0, 10);
  const targetDir = path.join(DATASETS_DIR, dateStr);

  console.log(`[MarketSyncData Compiler] Compiling dataset for date: ${dateStr}...`);

  let blockFiles = [];
  if (fs.existsSync(targetDir)) {
    blockFiles = fs.readdirSync(targetDir)
      .filter(f => f.endsWith('.json'))
      .sort();
  }

  // If no blocks found for today, check yesterday as fallback
  if (blockFiles.length === 0) {
    const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    const yDir = path.join(DATASETS_DIR, yesterday);
    if (fs.existsSync(yDir)) {
      console.log(`No blocks found for ${dateStr}. Falling back to previous day: ${yesterday}`);
      return compileDay(yesterday);
    }
  }

  if (blockFiles.length === 0) {
    console.warn(`[WARNING] No dataset blocks found in ${targetDir}.`);
    console.warn(`Generating empty fallback MarketSyncData.lua.`);
    const fallbackLua = `-- MarketSyncData: Empty dataset fallback\nMarketSyncDataDB = MarketSyncDataDB or {}\nMarketSyncData.generatedAt = ${Math.floor(Date.now() / 1000)}\nMarketSyncData.version = "${dateStr.replace(/-/g, '.')}"\n`;
    fs.writeFileSync(OUTPUT_LUA, fallbackLua, 'utf8');
    return { compiledItems: 0, date: dateStr };
  }

  console.log(`Found ${blockFiles.length} hourly blocks to merge for ${dateStr}.`);

  // Merged store: partitionKey => itemKey => { m, q, t }
  const mergedPartitions = {};
  let totalUniqueItems = 0;

  for (const file of blockFiles) {
    const filePath = path.join(targetDir, file);
    try {
      const block = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!block.rulesets) continue;

      for (const [rulesetKey, factions] of Object.entries(block.rulesets)) {
        for (const [factionName, items] of Object.entries(factions)) {
          const partitionKey = `${rulesetKey}@${factionName}`;
          if (!mergedPartitions[partitionKey]) {
            mergedPartitions[partitionKey] = {};
          }

          const partition = mergedPartitions[partitionKey];

          for (const [itemKey, entry] of Object.entries(items)) {
            const existing = partition[itemKey];
            // Prioritize the latest price observation
            if (!existing || (entry.time && entry.time >= existing.t)) {
              partition[itemKey] = {
                m: entry.minPrice,
                q: entry.totalQty,
                t: entry.time || block.timestamp
              };
            }
          }
        }
      }
    } catch (err) {
      console.warn(`Error reading block ${file}: ${err.message}`);
    }
  }

  // Generate Lua Code
  const versionTag = dateStr.replace(/-/g, '.');
  const unixNow = Math.floor(now.getTime() / 1000);

  let lua = `-- ============================================================================\n`;
  lua += `-- MarketSyncData - Daily Compiled Auction Dataset (${dateStr})\n`;
  lua += `-- ============================================================================\n`;
  lua += `-- Generated: ${now.toISOString()}\n`;
  lua += `-- Blocks Aggregated: ${blockFiles.length}\n`;
  lua += `-- Version: ${versionTag}\n`;
  lua += `-- ============================================================================\n\n`;
  lua += `MarketSyncDataDB = MarketSyncDataDB or {}\n`;
  lua += `MarketSyncData.generatedAt = ${unixNow}\n`;
  lua += `MarketSyncData.version = "${versionTag}"\n\n`;

  for (const [partitionKey, items] of Object.entries(mergedPartitions)) {
    const keys = Object.keys(items);
    totalUniqueItems += keys.length;
    lua += `MarketSyncDataDB["${partitionKey}"] = {\n`;

    for (const key of keys) {
      const e = items[key];
      // Format: ["key"] = { m = minPrice, q = quantity, t = timestamp },
      lua += `  ["${key}"] = { m = ${e.m}, q = ${e.q}, t = ${e.t} },\n`;
    }

    lua += `}\n\n`;
  }

  fs.writeFileSync(OUTPUT_LUA, lua, 'utf8');
  console.log(`[MarketSyncData Compiler] Wrote ${totalUniqueItems} aggregated records to ${OUTPUT_LUA}`);

  // Summary JSON
  const summary = {
    date: dateStr,
    version: versionTag,
    generatedAt: now.toISOString(),
    unixTimestamp: unixNow,
    blocksMerged: blockFiles.length,
    partitions: Object.keys(mergedPartitions),
    totalUniqueItems: totalUniqueItems,
    fileSizeKB: Math.round(fs.statSync(OUTPUT_LUA).size / 1024)
  };

  fs.writeFileSync(path.join(DIST_DIR, 'compile-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  // Update TOC version to match compile date
  const tocPath = path.join(ADDON_DIR, 'MarketSyncData.toc');
  if (fs.existsSync(tocPath)) {
    let tocContent = fs.readFileSync(tocPath, 'utf8');
    tocContent = tocContent.replace(/## Version: .*/, `## Version: ${versionTag}`);
    fs.writeFileSync(tocPath, tocContent, 'utf8');
  }

  return summary;
}

if (require.main === module) {
  const argDate = process.argv[2];
  compileDay(argDate);
}

module.exports = { compileDay };
