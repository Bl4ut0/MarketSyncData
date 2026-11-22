/**
 * MarketSync DataSync - Multi-Flavor Pipeline Integration Test Suite
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { harvest, aggregateAuctionListings } = require('../scripts/harvest');
const { compileAll } = require('../scripts/compile');
const { packageAll } = require('../scripts/package');

async function runTests() {
  console.log('=== Running MarketSync DataSync Multi-Flavor Pipeline Tests ===');

  // 1. Test Listing Aggregator
  console.log('Testing listing aggregation...');
  const mockAuctions = [
    { id: 101, item: { id: 13464 }, buyout: 25000, quantity: 2 },
    { id: 102, item: { id: 13464 }, buyout: 30000, quantity: 2 },
    { id: 103, item: { id: 14344 }, bid: 220000, quantity: 1 },
    { id: 104, item: { id: 19999, modifiers: [{ type: 1, value: 832 }] }, buyout: 5000, quantity: 1 }
  ];
  const mockCommodities = [
    { id: 201, item: { id: 13463 }, unit_price: 8500, quantity: 20 },
    { id: 202, item: { id: 13463 }, unit_price: 9000, quantity: 40 }
  ];

  const aggregated = aggregateAuctionListings(mockAuctions, mockCommodities, 1795300000);
  assert.strictEqual(aggregated['13464'].minPrice, 12500);
  assert.strictEqual(aggregated['13464'].maxPrice, 15000);
  assert.strictEqual(aggregated['13464'].totalQty, 4);
  assert.strictEqual(aggregated['19999:832'].minPrice, 5000);
  assert.strictEqual(aggregated['13463'].minPrice, 8500);
  console.log('  [PASS] Listing aggregation passed.');

  // 2. Test Multi-Flavor Harvester
  console.log('Testing multi-flavor harvest execution...');
  const results = await harvest();
  assert.ok(results.forever);
  assert.ok(results.anniversary);
  assert.ok(results.classicEra);
  assert.ok(results.classic);
  assert.ok(results.retail);
  console.log('  [PASS] Harvester generated blocks for all 5 flavors.');

  // 3. Test 90-Day Compiler
  console.log('Testing 90-day multi-flavor compiler...');
  const summary = compileAll();
  assert.ok(summary.flavors.forever);
  assert.ok(summary.flavors.anniversary);
  assert.ok(summary.flavors.classicEra);
  assert.ok(summary.flavors.classic);
  assert.ok(summary.flavors.retail);
  console.log('  [PASS] Compiler generated Lua datasets for all 5 flavors.');

  // 4. Test Multi-Flavor Packager
  console.log('Testing multi-flavor zip packager...');
  const expectedDate = new Date().toISOString().slice(0, 10);
  const zips = packageAll(expectedDate);
  assert.strictEqual(zips.length, 5);
  for (const label of ['Forever', 'Anniversary', 'ClassicEra', 'Classic', 'Retail']) {
    const expectedPath = path.join(__dirname, `../dist/MSData-${label}-${expectedDate}.zip`);
    assert.ok(zips.includes(expectedPath), `Expected zip in outputs: ${expectedPath}`);
    assert.ok(fs.existsSync(expectedPath) && fs.statSync(expectedPath).size > 0, `Missing or empty zip: ${expectedPath}`);
  }
  console.log(`  [PASS] Packager built all 5 MSData-<Flavor>-${expectedDate}.zip archives.`);

  console.log('\nAll multi-flavor pipeline integration tests passed successfully!\n');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
