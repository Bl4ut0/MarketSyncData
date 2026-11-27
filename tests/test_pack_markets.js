// Checks the market list used to plan data packs (scripts/pack-markets.json).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/pack-markets.json'), 'utf8'));

const forever = config.forever;
assert.deepStrictEqual(forever.factions, ['Alliance', 'Horde'], 'Forever packs are split by faction');
assert.strictEqual(forever.neutralInEachFactionPack, true, 'Neutral data ships in each faction pack');

const rulesets = forever.markets.map((m) => m.ruleset);
assert.deepStrictEqual(rulesets, ['pvp', 'normal', 'roleplay', 'roleplaypvp', 'hardcore'], 'all five Forever rulesets are listed');

const live = forever.markets.filter((m) => m.live).map((m) => m.ruleset);
assert.deepStrictEqual(live, ['pvp', 'normal', 'roleplay', 'roleplaypvp'], 'only rulesets with data are live');
const pending = forever.markets.find((m) => m.ruleset === 'hardcore');
assert.strictEqual(pending.live, false, 'hardcore stays off until it launches');

assert.strictEqual(config.classic.unit, 'connected-realm', 'Classic packs are per connected realm');
assert.strictEqual(config.retail.unit, 'region', 'Retail packs are per region');
assert.ok(config.retail.regions.every((r) => typeof r.region === 'string' && typeof r.live === 'boolean'));

console.log('PASS Forever rulesets, factions, and live flags match the plan');
console.log('PASS Classic and Retail units match the plan');
console.log('All pack market config tests passed.');

// The build gate must follow the same live flags.
const { IsBuildablePartition } = require('../scripts/compile.js');
assert.strictEqual(IsBuildablePartition('forever', 'pvp@Horde'), true, 'live ruleset ships');
assert.strictEqual(IsBuildablePartition('forever', 'roleplaypvp@Alliance'), true, 'live ruleset ships');
assert.strictEqual(IsBuildablePartition('forever', 'hardcore@Horde'), false, 'hardcore is skipped until launch');
assert.strictEqual(IsBuildablePartition('classic', 'pagle@CrossFaction'), true, 'Classic is not gated by ruleset');
console.log('PASS the build gate skips hardcore and keeps live rulesets and other flavors');
