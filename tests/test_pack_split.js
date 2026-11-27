// Runs the real compiler into a temporary build folder and checks the Forever pack split.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msd-split-'));
const run = spawnSync(process.execPath, [path.join(__dirname, '../scripts/compile.js')], {
  env: { ...process.env, MARKETSYNC_BUILD_DIR: buildDir },
  encoding: 'utf8',
});
assert.strictEqual(run.status, 0, 'compile.js should succeed: ' + run.stderr);

const forever = path.join(buildDir, 'builds', 'Forever');
const core = path.join(forever, 'MarketSyncData');
const coreToc = fs.readFileSync(path.join(core, 'MarketSyncData.toc'), 'utf8');
assert.ok(!coreToc.includes('MarketSyncData.lua'), 'the core addon must not load the old single file');
assert.ok(coreToc.includes('Flavor.lua') && coreToc.includes('Core.lua'), 'core loads Flavor.lua then Core.lua');
assert.ok(!fs.existsSync(path.join(core, 'MarketSyncData.lua')), 'no single data file in the core addon');
console.log('PASS the core addon is a loader with no data file');

const packsDir = path.join(forever, 'packs');
const packs = fs.readdirSync(packsDir).sort();
const expected = [];
for (const ruleset of ['normal', 'pvp', 'roleplay', 'roleplaypvp']) {
  for (const faction of ['Alliance', 'Horde']) expected.push(`MarketSyncData_Forever_${ruleset}_${faction}`);
}
assert.deepStrictEqual(packs, expected.sort(), 'one pack per live ruleset and faction, and no hardcore pack');
console.log(`PASS ${packs.length} packs, one per live ruleset and faction, no hardcore`);

for (const name of packs) {
  const toc = fs.readFileSync(path.join(packsDir, name, `${name}.toc`), 'utf8');
  assert.ok(toc.includes('## LoadOnDemand: 1'), `${name} must be LoadOnDemand`);
  assert.ok(toc.includes('## Dependencies: MarketSyncData'), `${name} must depend on the core loader`);
  const lua = fs.readFileSync(path.join(packsDir, name, `${name}.lua`), 'utf8');
  const [ruleset, faction] = name.replace('MarketSyncData_Forever_', '').split('_');
  const keys = [...lua.matchAll(/MarketSyncDataDB\["([^"]+)"\] = MarketSyncDataDB/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(keys, [`${ruleset}@${faction}`, `${ruleset}@Neutral`].sort(), `${name} holds only its market and its Neutral`);
}
console.log('PASS each pack holds only its own faction and its ruleset Neutral data');

fs.rmSync(buildDir, { recursive: true, force: true });
console.log('All pack split tests passed.');
