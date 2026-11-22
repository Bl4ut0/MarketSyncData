# MarketSync DataSync Architecture

## 1. System Overview

MarketSync DataSync is an automated multi-flavor ingestion, long-term archival, and compilation pipeline for World of Warcraft Auction House and Commodity data via Blizzard's official Battle.net Game Data API (`@pinta365/blizzard_api`). It serves two consumers cleanly:
1. **MarketSyncWeb**: Reads permanent historical hourly blocks directly from `datasets/<flavor>/YYYY-MM-DD/HH-00.json` via `datasets/index.json`.
2. **In-Game MarketSync Addon (`MSData-<Flavor>-<Date>.zip`)**: Receives a lightweight, **strictly per-flavor** data pack trimmed to the latest **90 days** of hourly blocks.

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Hourly Multi-Flavor Ingestion                      │
├──────────────────────────────────────────────────────────────────────┤
│ 1. Cron Trigger (12,42 * * * * with UTC-hour idempotency check)      │
│ 2. Authenticate via Battle.net OAuth client_credentials              │
│ 3. Harvest all 5 flavors across Alliance/Horde/Neutral/Commodities:  │
│      - forever (Rulesets 1/2/3/15 -> houses 110..125)                │
│      - anniversary (dynamic-classicann -> Dreamscythe/Nightslayer..) │
│      - classicEra (dynamic-classic1x -> 23 connected realms)         │
│      - classic (dynamic-classic -> 23 connected realms)              │
│      - retail (dynamic -> region commodities)                        │
│ 4. Archive permanent snapshot: datasets/<flavor>/YYYY-MM-DD/HH-00.json│
│ 5. Update datasets/index.json tracking manifest                      │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
          ┌────────────────────────┴────────────────────────┐
          ▼                                                 ▼
┌────────────────────────────────────┐   ┌─────────────────────────────────────┐
│ Permanent Web Data Store (GitHub)  │   │ Daily 90-Day AddOn Compiler (06:20) │
├────────────────────────────────────┤   ├─────────────────────────────────────┤
│ - Retains ALL historical blocks    │   │ 1. Filters blocks >= (now - 90d)    │
│   forever for MarketSyncWeb charts │   │ 2. Compiles strictly per-flavor:    │
│ - Indexed in datasets/index.json   │   │    dist/builds/<Flavor>/            │
└────────────────────────────────────┘   │ 3. Generates flavor .toc & Lua data │
                                         │ 4. Zips MSData-<Flavor>-<Date>.zip  │
                                         │ 5. Publishes GitHub + CurseForge    │
                                         └──────────────────┬──────────────────┘
                                                            ▼
                                         ┌─────────────────────────────────────┐
                                         │ In-Game Flavor-Guarded Ingestion    │
                                         ├─────────────────────────────────────┤
                                         │ 1. Checks GetBuildInfo() == flavor  │
                                         │ 2. Merges MarketSyncDataDB into     │
                                         │    GuildData if newer than local    │
                                         │ 3. Never overwrites newer guild     │
                                         │    or personal AH scans             │
                                         └─────────────────────────────────────┘
```

---

## 2. Flavor Ingestion Details

### WoW: Forever (`forever`)
- Forever is realmless and organizes economies by **Rulesets** (`PvP`, `Normal`, `Roleplay`, `Roleplay PvP`) under `dynamic-forever-{region}`.
- Blizzard's `/data/wow/ruleset/{id}/auctions/` index returns all 15 regional house IDs (`110`–`125`) regardless of the queried `rulesetId`. `scripts/harvest.js` maps each ruleset explicitly to its exact Alliance/Horde/Blackwater house triplet (`FOREVER_RULESET_HOUSES`: `1 -> 110/113/116`, `2 -> 111/114/117`, `3 -> 119/120/121`, `15 -> 123/124/125`) so each ruleset keeps its distinct market listings and commodities without cross-overwriting.

### Classic Anniversary (`anniversary`)
- Harvested via Blizzard's dedicated `dynamic-classicann-{region}` namespace (connected realms `dreamscythe`, `nightslayer`, `maladath`, across `Alliance`, `Horde`, and `Neutral`).
- If Blizzard's `/auctions/{houseId}` detail route returns HTTP 404 (a known upstream Blizzard issue on Classic Era / Anniversary dynamic namespaces), the harvester still records the realm and house structure cleanly with `0` items without failing other flavors.

### Classic Era / SoD / Hardcore (`classicEra`)
- Harvested via `client.wowClassicEra` (`dynamic-classic1x-{region}`) across all 23 US connected realms (`whitemane`, `doomhowl`, `defias-pillager`, `crusader-strike`, `mankrik`, etc.).

### Classic Progression (`classic`) & Retail (`retail`)
- **Classic Progression**: Harvested via `client.wowClassic` (`dynamic-classic-{region}`) across all connected realms (`CrossFaction`).
- **Retail**: Harvested via `client.wow` (`dynamic-{region}`) region-wide commodities endpoint.

---

## 3. Permanent GitHub Storage vs. 90-Day AddOn Window

- **GitHub Archive (`datasets/`)**: `scripts/harvest.js` never deletes older historical blocks, allowing `MarketSyncWeb` to serve long-term historical price trends straight from GitHub without a separate cloud database.
- **Compiled AddOn Window (`scripts/compile.js`)**: When compiling addon `.lua` bundles, `compileFlavor(flavor)` filters directory dates strictly by `dDir >= cutoffDate` where `cutoffDate = now - 90 days` (`RETENTION_DAYS = 90`). Only the latest 90 days of JSON blocks for **that single flavor** are included in `dist/MSData-<Flavor>-<YYYY-MM-DD>.zip`.

---

## 4. In-Game Flavor Guard & Non-Destructive Sync (`MarketSyncData/Core.lua`)

- **Flavor Verification**: `IsClientFlavorCompatible(MarketSyncData.flavor)` checks the running client interface via `GetBuildInfo()` against `FLAVOR_INTERFACES` so a pack compiled for one game flavor (e.g. Forever `16001`) will refuse to inject into another (e.g. Anniversary `20506`).
- **Partition Matching**: Resolves `<realm>@<faction>` cleanly (handling empty `GetNormalizedRealmName()` strings in realmless Forever clients via faction matching).
- **Timestamp Protection**: Only inserts `MarketSyncDataDB` entries where `existing.t < entry.t`, preserving all newer personal or guild scans recorded in-game.
