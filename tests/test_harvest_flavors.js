// Anniversary and Classic Era have no Blizzard auction API yet; their data comes
// from player uploads, so the live harvest must not call the API for them.
const assert = require('assert');

delete process.env.HARVEST_PLAYER_DATA_FLAVORS;
const { harvestsFromApi } = require('../scripts/harvest');

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`PASS ${name}`);
  passed++;
}

test('Anniversary and Classic Era are not harvested from the API', () => {
  assert.strictEqual(harvestsFromApi('anniversary'), false);
  assert.strictEqual(harvestsFromApi('classicEra'), false);
});

test('Forever, Classic and Retail still use the API', () => {
  for (const flavor of ['forever', 'classic', 'retail']) {
    assert.strictEqual(harvestsFromApi(flavor), true, flavor);
  }
});

test('HARVEST_PLAYER_DATA_FLAVORS=1 turns the API back on for them', () => {
  process.env.HARVEST_PLAYER_DATA_FLAVORS = '1';
  try {
    assert.strictEqual(harvestsFromApi('anniversary'), true);
    assert.strictEqual(harvestsFromApi('classicEra'), true);
  } finally {
    delete process.env.HARVEST_PLAYER_DATA_FLAVORS;
  }
});

console.log(`All ${passed} harvest flavor tests passed.`);
