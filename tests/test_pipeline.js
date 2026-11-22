/**
 * MarketSync DataSync - Pipeline Integration Test Suite
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { harvest, aggregateAuctionListings } = require('../scripts/harvest');
const { compileDay } = require('../scripts/compile');
const { packageAddon } = require('../scripts/package');

async function runTests() {
  console.log('=== Running MarketSync DataSync Pipeline Tests ===');

  // 1. Test Listing Aggregator
  console.log('Testing listing aggregation...');
  const mockAuctions = [
    { id: 101, item: { id: 13464 }, buyout: 25000, quantity: 2 }, // Golden Sansam: 12500c/ea
    { id: 102, item: { id: 13464 }, buyout: 30000, quantity: 2 }, // Golden Sansam: 15000c/ea
    { id: 103, item: { id: 14344 }, bid: 220000, quantity: 1 },    // Large Brilliant Shard: 220000c/ea
    { id: 104, item: { id: 19999, modifiers: [{ type: 1, value: 832 }] }, buyout: 5000, quantity: 1 } // Suffix
  ];
  const mockCommodities = [
    { id: 201, item: { id: 13463 }, unit_price: 8500, quantity: 20 },
    { id: 202, item: { id: 13463 }, unit_price: 9000, quantity: 40 }
  ];

  const aggregated = aggregateAuctionListings(mockAuctions, mockCommodities, 1795300000);
  assert.strictEqual(aggregated['13464'].minPrice, 12500);
  assert.strictEqual(aggregated['13464'].maxPrice, 15000);
  assert.strictEqual(aggregated['13464'].totalQty, 4);
  assert.strictEqual(aggregated['13464'].listings, 2);

  assert.strictEqual(aggregated['14344'].minPrice, 220000);
  assert.strictEqual(aggregated['14344'].totalQty, 1);

  assert.strictEqual(aggregated['19999:832'].minPrice, 5000);
  assert.strictEqual(aggregated['13463'].minPrice, 8500);
  assert.strictEqual(aggregated['13463'].totalQty, 60);
  console.log('  [PASS] Listing aggregation correctly calculates minPrice, totalQty, and suffixes.');

  // 2. Test Harvester
  console.log('Testing harvest execution (simulated block)...');
  const dataset = await harvest();
  assert.ok(dataset);
  assert.ok(dataset.rulesets.english);
  assert.ok(dataset.rulesets.english.Horde);
  assert.strictEqual(dataset.stats.totalItems, 6);
  console.log('  [PASS] Harvester generated and indexed dataset block.');

  // 3. Test Compiler
  console.log('Testing compiler day aggregation...');
  const summary = compileDay();
  assert.ok(summary);
  assert.ok(summary.totalUniqueItems > 0);
  assert.ok(summary.partitions.includes('english@Horde'));

  const luaPath = path.join(__dirname, '../MarketSyncData/MarketSyncData.lua');
  assert.ok(fs.existsSync(luaPath));
  const luaContent = fs.readFileSync(luaPath, 'utf8');
  assert.ok(luaContent.includes('MarketSyncDataDB["english@Horde"]'));
  assert.ok(luaContent.includes('["13464"] = { m ='));
  assert.ok(luaContent.includes('MarketSyncData.generatedAt'));
  console.log('  [PASS] Compiler generated valid MarketSyncData.lua.');

  // 4. Test Packager
  console.log('Testing zip packager...');
  const zipPath = packageAddon();
  assert.ok(fs.existsSync(zipPath));
  assert.ok(fs.statSync(zipPath).size > 100);
  console.log('  [PASS] Packager produced distributable zip archive.');

  console.log('\nAll pipeline integration tests passed successfully!\n');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
