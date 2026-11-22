/**
 * MarketSync DataSync - Multi-Flavor Pipeline Integration Test Suite
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marketsync-data-test-'));
const TEST_DATASETS_DIR = path.join(TEST_ROOT, 'datasets');
const TEST_BUILD_DIR = path.join(TEST_ROOT, 'builds');
process.env.DATASETS_DIR = TEST_DATASETS_DIR;
process.env.MARKETSYNC_BUILD_DIR = TEST_BUILD_DIR;
delete process.env.BLIZZARD_CLIENT_ID;
delete process.env.BLIZZARD_CLIENT_SECRET;
delete process.env.REQUIRE_LIVE_HARVEST;

const { harvest, harvestFactionRealms, aggregateAuctionListings } = require('../scripts/harvest');
const { updateItemCatalog } = require('../scripts/catalog');
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
    { id: 104, item: { id: 19999, modifiers: [{ type: 1, value: 832 }] }, buyout: 5000, quantity: 1 },
    { id: 105, item: { id: 2447 }, unit_price: 15, quantity: 30 },
    { id: 106, item: { id: 82800, pet_species_id: 159 }, buyout: 500, quantity: 1 },
    { id: 107, item: { id: 2447, rand: -1 }, buyout: 1, quantity: 20 }
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
  assert.strictEqual(aggregated['13463'].totalQty, 60);
  assert.strictEqual(aggregated['13463'].listings, 2);
  assert.strictEqual(aggregated['2447'].totalQty, 30);
  assert.strictEqual(aggregated['82800:159'].listings, 1);
  assert.strictEqual(aggregated['2447:-1'].minPrice, 1);
  console.log('  [PASS] Listing aggregation passed.');

  const mockClient = {
    async requestHref(href) {
      const url = new URL(href);
      assert.equal(url.searchParams.get('namespace'), 'dynamic-classicann-us');
      switch (url.pathname) {
        case '/data/wow/connected-realm/index':
          return { connected_realms: [{ href: 'https://us.api.blizzard.com/data/wow/connected-realm/123' }] };
        case '/data/wow/connected-realm/123':
          return { realms: [{ slug: 'dreamscythe' }] };
        case '/data/wow/connected-realm/123/auctions/index':
          return { auctions: [
            { name: 'Alliance', key: { href: 'https://us.api.blizzard.com/data/wow/connected-realm/123/auctions/2' } },
            { name: 'Horde', id: 6 }, { name: 'Neutral', id: 7 }
          ] };
        case '/data/wow/connected-realm/123/auctions/2':
          return { auctions: [{ item: { id: 2447 }, unit_price: 15, quantity: 30 }] };
        case '/data/wow/connected-realm/123/auctions/6':
          return { auctions: [] };
        case '/data/wow/connected-realm/123/auctions/7':
          throw Object.assign(new Error('Gateway unavailable'), { statusCode: 503 });
        default:
          throw new Error('Unexpected request ' + url.pathname);
      }
    },
  };
  const scan = await harvestFactionRealms(mockClient, 1795300000, 'Anniversary', 'dynamic-classicann-us');
  assert.equal(scan.markets.dreamscythe.Alliance.status, 'available');
  assert.equal(scan.markets.dreamscythe.Horde.status, 'empty');
  assert.equal(scan.markets.dreamscythe.Neutral.status, 'unavailable');
  assert.equal(scan.totalVolume, 30);

  await updateItemCatalog({
    client: {
      async requestHref(href) {
        const url = new URL(href);
        assert.equal(url.searchParams.get('namespace'), 'static-classicann-us');
        assert.equal(url.searchParams.get('id'), '[2001,3000]');
        return { results: [{ data: {
          id: 2447, name: { en_US: 'Peacebloom' }, item_class: { id: 7 },
          item_subclass: { id: 9, name: { en_US: 'Herb' } },
        } }] };
      },
    },
    flavor: 'anniversary', region: 'us', partitions: scan.partitions, datasetsDir: TEST_DATASETS_DIR, now: new Date(),
  });
  const catalog = JSON.parse(fs.readFileSync(path.join(TEST_DATASETS_DIR, 'anniversary', 'catalog.json'), 'utf8'));
  assert.deepEqual(catalog.items['2447'], { name: 'Peacebloom', itemClass: 7, itemSubclass: 9, subclassName: 'Herb' });
  console.log('  [PASS] House availability and Blizzard item catalog passed.');

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
    const expectedPath = path.join(TEST_BUILD_DIR, `MSData-${label}-${expectedDate}.zip`);
    assert.ok(zips.includes(expectedPath), `Expected zip in outputs: ${expectedPath}`);
    assert.ok(fs.existsSync(expectedPath) && fs.statSync(expectedPath).size > 0, `Missing or empty zip: ${expectedPath}`);
  }
  console.log(`  [PASS] Packager built all 5 MSData-<Flavor>-${expectedDate}.zip archives.`);

  console.log('\nAll multi-flavor pipeline integration tests passed successfully!\n');
}

runTests()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));
