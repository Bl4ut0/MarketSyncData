// Tests for the connected-realm mapping written by the harvester (scripts/harvest.js).
const assert = require('assert');
const { connectedRealmRecord } = require('../scripts/harvest.js');

// A connected realm lists every realm that shares its auction house.
const shared = connectedRealmRecord(4577, { realms: [{ slug: 'pagle' }, { slug: 'arugal' }] }, 'pagle');
assert.deepStrictEqual(shared, {
  connectedRealmId: 4577,
  primarySlug: 'pagle',
  slugs: ['pagle', 'arugal'],
  fallback: 'pagle',
});
console.log('PASS a connected realm keeps every slug that shares its auction house');

// A single-realm connected realm maps to its own slug.
const solo = connectedRealmRecord(1, { realms: [{ slug: 'atiesh' }] }, 'cr1');
assert.deepStrictEqual(solo.slugs, ['atiesh']);
console.log('PASS a single-realm connected realm maps to its own slug');

// No realm list means no record, so the caller keeps its fallback slug.
assert.strictEqual(connectedRealmRecord(2, {}, 'cr2'), null);
assert.strictEqual(connectedRealmRecord(2, { realms: [] }, 'cr2'), null);
assert.strictEqual(connectedRealmRecord(2, null, 'cr2'), null);
console.log('PASS a detail without realms returns no record');

// Blank or malformed slugs are dropped.
const messy = connectedRealmRecord(3, { realms: [{ slug: '' }, null, { slug: 'myzrael' }] }, 'myzrael');
assert.deepStrictEqual(messy.slugs, ['myzrael']);
console.log('PASS blank and malformed realm entries are ignored');

console.log('All connected-realm mapping tests passed.');
