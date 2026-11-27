# MarketSync Data Packs: Breakout Plan

Status: draft for discussion. Nothing here is built yet.
Owner: MarketSync team. Related: `ARCHITECTURE.md`, `DATASET_SCHEMA.md`, `scripts/compile.js`.

## 1. Problem

One pack file containing every realm, ruleset, and faction does not scale.

- The current Forever pack is one 61.7 MB Lua file with 12 partitions and 165,845 items, built from 4 days of data.
- Every partition loads at addon start and stays in memory until `/reload`. Lua cannot unload it. The in-game panel shows about 200 MB resident.
- A full 90-day history projects to about 424 MB of text for Forever alone, roughly 1.3 GB in memory. Each Forever ruleset-and-faction partition is about 52 MB of text.
- Classic (23 realms), Retail (1 partition), Anniversary (9 slots), and ClassicEra (69 slots) are smaller, but they add up.

Projected sizes at 90 days of hourly history, using the calibration in the session notes (about 2.5 KB of text per item; in-memory cost about 3.2x text):

| Pack | Items | Text | In memory |
|---|---|---|---|
| Classic, median realm | ~400 | ~1 MB | ~3 MB |
| Classic, largest realm (pagle) | 7,481 | ~19 MB | ~57 MB |
| Classic, all 23 realms | 10,743 | ~28 MB | ~82 MB |
| Retail | 10,251 | ~26 MB | ~79 MB |
| Forever, one ruleset and faction | ~20,500 | ~52 MB | ~157 MB |
| Forever, all 12 partitions | 165,845 | ~424 MB | ~1.3 GB |

These projections are estimates. Thin items will have fewer observations than the model assumes, so real files will be smaller.

## 2. Goals

1. A player only downloads and loads the data for their own market.
2. Each pack is an optional install. Players who don't want it skip it.
3. The addon loads at most one pack for the current character, plus Neutral only when the Neutral source is used.
4. Full history for any market is reachable through the MarketSync website deep links, so the addon never needs gigabytes of data.
5. Packs are built per market unit, not one monolithic file per flavor.

## 3. Facts the plan depends on

- **Forever** data is keyed by ruleset and faction, not by realm: `<ruleset>@<faction>`. Rulesets currently present: `pvp`, `normal`, `roleplay`, `roleplaypvp`. `hardcore` is a ruleset in the addon, but it has no partition in the current pack.
- **Classic** data is keyed by realm slug with `CrossFaction`: 23 partitions in the current build. Classic Era and Anniversary have empty partitions today, so their realm lists are not yet confirmed by data.
- **Retail** is one partition, `region@Commodities`.
- The harvester already calls the Blizzard connected-realm endpoints (`harvest.js`, `realmUrl`, and `wowClassic.connectedRealms`). It fetches auctions per connected realm, so the connected realm is the true market unit. Partition keys currently use realm slugs, which may not match connected-realm IDs. This is the main open question for grouping.
- The term "battle group" does not appear anywhere in the data or harvester. The connected-realm ID is the grouping the API provides. Whether any retail or classic UI still shows battle groups is unverified.

## 4. Market units and grouping

Proposed grouping, from the most to least granular:

| Flavor | Market unit | Count today | Pack key |
|---|---|---|---|
| Forever | ruleset x faction | 5 rulesets x 2 factions (+ Neutral) | `forever-<ruleset>-<faction>` |
| Classic | connected realm | 23 realm slugs; fewer if grouped by connected realm | `classic-<connectedRealmId>` |
| Classic Era | connected realm | 69 slots, all empty | `classicEra-<connectedRealmId>` |
| Anniversary | connected realm | 9 slots, all empty | `anniversary-<connectedRealmId>` |
| Retail | region | 1 | `retail-commodities` |

Decision needed: Classic grouping.
- **Option A, per realm slug:** matches the data we have now. Many small packs.
- **Option B, per connected realm:** matches the auction house. Fewer packs, fewer duplicates. Requires a mapping from slug to connected-realm ID. The harvester has most of this.
- **Option C, per region or battle group:** fewest packs, but may not match real markets. Only use it if the connected-realm data shows the same markets.

Recommendation: Option B. Derive the mapping from the connected-realm endpoint during harvest and store it in the dataset index.

## 5. Pack structure in the addon

Each pack is a separate LoadOnDemand addon. The core `MarketSyncData` addon holds only the loader and the index.

```
MarketSyncData/                       core loader, always loaded, small
  MarketSyncData.toc                  LoadOnDemand: 0, Dependencies: MarketSync
  Core.lua                            resolves the character's pack and calls LoadAddOn
  Index.lua                           maps market key -> pack addon name

MarketSyncData_Forever_pvp_Horde/     LoadOnDemand: 1, Dependencies: MarketSyncData
  MarketSyncData_Forever_pvp_Horde.toc
  Pack.lua                            MarketSyncDataDB["pvp@Horde"] = { ... }
```

Loader behavior:
1. At login, read ruleset (`MarketSync.GetForeverAuctionRuleset()`) and faction (`UnitFactionGroup`), or realm and connected-realm ID for Classic.
2. Look up the pack name in `Index.lua`.
3. If the pack is installed (`C_AddOns.IsAddOnLoaded` or `C_AddOns.GetAddOnInfo`), call `C_AddOns.LoadAddOn` once. Data is available immediately without `/reload`.
4. If the pack is not installed, show the existing "Data Pack not installed" state with a link to the CurseForge project.
5. Neutral packs load only when the Neutral source is selected.

Optional setting: "Load all installed packs" for players who want Neutral and other markets. Off by default.

## 6. CurseForge projects

Decision needed: how many CF projects.

- A CurseForge download is a whole project. A player cannot pick a sub-folder from one project. "Optional" therefore means one project per pack, or one project per group of packs the player installs together.
- Forever: 5 rulesets x 2 factions = 10 packs, or 5 projects if each project holds both factions for one ruleset. Neutral can go with either.
- Classic: 23 realm slugs, or fewer connected-realm packs. Each would need a project if the packs are separate.
- Retail: one project.

Recommendation: one CF project per Forever ruleset (5), one per Classic connected realm (confirm count after mapping), one for Retail. Each project holds both factions for its ruleset, so a player installs one project for their market. Confirm this does not produce too many projects for CurseForge.

## 7. Build pipeline changes

`scripts/compile.js` currently writes one `MarketSyncData.lua` per flavor. Changes:

1. Emit one Lua file per market unit: per ruleset-faction for Forever, per connected realm for Classic and Anniversary, per Classic Era connected realm, and per Retail region.
2. Emit an index file (`Index.lua`) mapping market key to pack addon name and size.
3. Emit one addon folder and zip per market unit. `scripts/package.js` already packages per flavor; extend it.
4. Keep the 90-day tiered history from `compile.js` as is. Size control is per pack, not a shorter window.
5. Add a size gate: fail the build if a pack exceeds a limit (proposed 60 MB text) so a single market cannot bloat the release.

## 8. MarketSync addon changes

- `Processing.lua`: `GetDataPackRecord` reads the current partition only. This is already the case. Add a loader call before the read.
- `UI_Analytics.lua` and `Config.lua`: when the pack is not installed, show the install link instead of an empty graph.
- Settings: "Load all installed packs" toggle, default off.

## 9. Website role

- Full 90-day history for any market stays on the MarketSync website, reachable through the deep-link routes in `deepLink.ts`.
- The site already serves per-hour blocks from `datasets/<flavor>/<date>/<HH>-00.json`. Market keys in the link must match the pack keys, so use one key format for both.
- The addon's "View full history" button opens the site link for the current item, market, and date.

## 10. Open questions

1. Classic grouping: per slug, per connected realm, or per region? (Section 4.)
2. CurseForge projects: one per ruleset and per connected realm, or one per flavor with everything in it? (Section 6.)
3. Hardcore: launch pending, no data yet. It gets its own two faction packs (Alliance and Horde) with Neutral included, like the other rulesets. It is listed in `scripts/pack-markets.json` with `live: false`, so the framework is ready and nothing ships until it is switched on.
4. Classic Era and Anniversary: which realms and connected-realm IDs are live? The packs are empty.
5. Should Neutral be inside each market pack or a separate pack? Currently separate per ruleset.
6. Is there a battle-group concept in any client we support? Not found in the data or harvester.
7. Size limit per pack: 60 MB text proposed. Confirm.

## 11. Phases

**Phase 1: Mapping.** Build the slug to connected-realm mapping from the harvester. Output an index. Check it against the 23 Classic slugs and against the Forever rulesets. Acceptance: every current Classic slug maps to exactly one connected-realm ID, and the mapping is stored in the dataset.

**Phase 2: Pack split in the build.** Change `compile.js` and `package.js` to emit one addon per market unit, plus the index. Acceptance: `npm test` passes; the Forever build produces 10 or 12 packs whose text sizes sum to the current 61.7 MB, within 2%.

**Phase 3: Loader in MarketSync.** Load one pack at login with `C_AddOns.LoadAddOn`. Acceptance: in game, the Analytics tab shows the character's market, and the panel's resident memory drops to about one partition.

**Phase 4: CurseForge projects.** Publish the packs as projects. Acceptance: each project installs on its own, and the loader finds it.

**Phase 5: Website links.** Link the "View full history" action to the site. Acceptance: the link opens the right item, market, and date.

## 12. Risks

- Connected-realm IDs may change when servers merge. The index must be rebuilt on each harvest.
- More CurseForge projects means more release work per patch.
- A player with no installed pack sees an empty Analytics tab. The install prompt has to be clear.
- Lua loads a LoadOnDemand addon's file in full. One pack per market keeps that cost bounded, but a single market can still grow. The size gate in section 7 is the control.
