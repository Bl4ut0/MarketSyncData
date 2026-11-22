const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const output = process.env.DATASETS_DIR;
assert.ok(output, 'Set DATASETS_DIR to the isolated validation run directory.');
const read = (name) => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
const health = read('harvest-status.json');
const index = read('index.json');
assert.deepEqual(Object.keys(health.editions).sort(), ['anniversary', 'classic', 'classicEra', 'forever', 'retail']);

for (const [edition, source] of Object.entries(health.editions)) {
  const metadata = index.blocks.find(block => block.flavor === edition);
  if (source.status === 'unavailable') {
    assert.equal(metadata, undefined, edition + ' must not publish a blank capture');
  } else {
    assert.ok(metadata, edition + ' must publish a valid capture');
    const capture = read(metadata.path.replace(/^datasets\//, ''));
    const entries = Object.values(capture.rulesets).flatMap(houses =>
      Object.values(houses).flatMap(items => Object.values(items)));
    assert.equal(metadata.items, entries.length);
    assert.equal(metadata.volume, entries.reduce((sum, entry) => sum + entry.totalQty, 0));
    assert.equal(metadata.items, source.totalItems);
    assert.equal(metadata.volume, source.totalVolume);
  }
  const errors = Object.values(source.markets ?? {}).flatMap(Object.values).flatMap(market => market.errors ?? []);
  console.log(edition, JSON.stringify({
    status: source.status,
    markets: source.counts,
    itemRows: metadata?.items,
    quantity: metadata?.volume,
    http404: errors.filter(error => error.httpStatus === 404).length,
  }));
}
assert.ok(index.blocks.some(block => block.items > 0), 'Live API returned no priced items');
