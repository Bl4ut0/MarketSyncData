const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'marketsync-harvest-test-'));
process.env.DATASETS_DIR = output;
const { harvest } = require('../scripts/harvest');

const time = new Date('2026-11-22T17:21:00Z');
const editionPath = 'anniversary/2026-11-22/17-00.json';
const file = (name) => path.join(output, name);
const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'));
const auction = { item: { id: 2447 }, unit_price: 23, quantity: 8 };

function makeClient(responses) {
  return {
    async requestHref(href) {
      const url = new URL(href);
      const route = url.pathname.replace('/data/wow/connected-realm/', '');
      switch (route) {
        case 'index': return { connected_realms: [{ href: 'https://us.api.blizzard.com/data/wow/connected-realm/6064' }] };
        case '6064': return { realms: [{ slug: 'dreamscythe' }] };
        case '6064/auctions/index': return { auctions: [{ id: 2 }, { id: 6 }, { id: 7 }] };
        case '6064/auctions': return {
          _links: { self: { href } },
          connected_realm: { href: 'https://us.api.blizzard.com/data/wow/connected-realm/6064' },
          commodities: { href: 'https://us.api.blizzard.com/data/wow/auctions/commodities' },
        };
        default: {
          const data = responses[route.split('/').at(-1)];
          if (data instanceof Error) throw data;
          return { auctions: data };
        }
      }
    },
  };
}

async function main() {
  const missing = Object.assign(new Error('not found'), { statusCode: 404 });
  const unavailable = makeClient({ 2: missing, 6: missing, 7: missing });
  await harvest({ client: unavailable, flavors: ['anniversary', 'classic'], now: time });
  const first = read('harvest-status.json');
  assert.equal(first.editions.anniversary.status, 'unavailable');
  assert.equal(first.editions.anniversary.markets.dreamscythe.Alliance.errors[0].httpStatus, 404);
  assert.equal(fs.existsSync(file(editionPath)), false);
  assert.deepEqual(read('index.json').blocks.map(block => block.flavor), ['classic']);
  assert.equal(first.editions.classic.markets.dreamscythe.CrossFaction.status, 'empty');

  const partial = makeClient({ 2: [auction], 6: missing, 7: [] });
  await harvest({ client: partial, flavors: ['anniversary'], now: time });
  const recovered = read(editionPath);
  assert.equal(recovered.rulesets.dreamscythe.Alliance['2447'].totalQty, 8);
  assert.equal(recovered.rulesets.dreamscythe.Alliance['2447'].minPrice, 23);
  assert.deepEqual(recovered.rulesets.dreamscythe.Neutral, {});
  assert.equal(recovered.rulesets.dreamscythe.Horde, undefined);
  assert.equal(read('harvest-status.json').editions.anniversary.status, 'partial');
  assert.equal(read('index.json').blocks.find(block => block.flavor === 'anniversary').volume, 8);

  const partialRetry = makeClient({ 2: missing, 6: [auction], 7: [] });
  await harvest({ client: partialRetry, flavors: ['anniversary'], now: new Date(time.getTime() + 3000) });
  assert.deepEqual(read(editionPath), recovered);
  console.log('Verified unavailable, empty, partial, quantity, and same-hour retry behavior.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
