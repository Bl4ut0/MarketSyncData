# MarketSync DataSync Architecture

## 1. System Overview

MarketSync DataSync is an automated data ingestion and compilation pipeline designed to extract World of Warcraft: Forever auction house and commodity data via Blizzard's official API, store historical dataset blocks, and compile daily distribution data packs for the in-game MarketSync addon.

```
┌────────────────────────────────────────────────────────────────┐
│               Hourly Ingestion Pipeline                        │
├────────────────────────────────────────────────────────────────┤
│ 1. Cron Trigger (Every Hour, 00:00 UTC)                        │
│ 2. Authenticate via Battle.net OAuth client_credentials        │
│ 3. Fetch Rulesets & Auction Houses (@pinta365/blizzard_api)    │
│ 4. Download Active Auctions + Commodities                      │
│ 5. Calculate minPrice, maxPrice, volume, and unit prices       │
│ 6. Commit Dataset Block: datasets/YYYY-MM-DD/HH-00.json        │
│ 7. Update datasets/index.json tracking manifest                │
└───────────────────────────────┬────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────┐
│               Daily Compilation Pipeline                       │
├────────────────────────────────────────────────────────────────┤
│ 1. Cron Trigger (Daily at 06:00 UTC)                           │
│ 2. Read 24 Hourly Dataset Blocks for target date               │
│ 3. Deduplicate & Merge latest price observations               │
│ 4. Generate Lua Data Tables: MarketSyncData/MarketSyncData.lua │
│ 5. Update Version in MarketSyncData.toc (e.g. 2026.11.22)      │
│ 6. Package dist/MarketSyncData.zip                             │
│ 7. Publish GitHub Release & CurseForge DataPack                │
└───────────────────────────────┬────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────┐
│               In-Game AddOn Integration                        │
├────────────────────────────────────────────────────────────────┤
│ 1. Player launches WoW with MarketSync + MarketSyncData        │
│ 2. MarketSyncData/Core.lua fires on ADDON_LOADED/PLAYER_LOGIN   │
│ 3. Ingests MarketSyncDataDB into MarketSync.GuildData          │
│ 4. Safeguard: Never overwrites fresher local/guild scans       │
│ 5. Instant offline market browsing before visiting auctioneer   │
└────────────────────────────────────────────────────────────────┘
```

---

## 2. Realmless Ruleset Ingestion (WoW: Forever)

Unlike traditional World of Warcraft flavors that group auctions by connected realm IDs, **World of Warcraft: Forever** replaces realms with **Rulesets**:
- Endpoints query the dynamic namespace (`dynamic-forever-{region}`).
- Rulesets (e.g. Normal, PvP, Roleplay) list three standard auction houses:
  - **Alliance** (House ID 6)
  - **Horde** (House ID 2)
  - **Neutral / Blackwater** (House ID 7)
- Standard equipment auctions and commodities are fetched separately and merged by item ID.

---

## 3. Dataset Block Structure

Hourly blocks are archived in `datasets/YYYY-MM-DD/HH-00.json`.
Each block contains:
- `timestamp`: Unix timestamp of the harvest.
- `isoDate`: UTC ISO timestamp.
- `rulesets`: Partitions mapped by canonical ruleset name (`english`, `pvp`, etc.) and faction.
- `stats`: Total items, total volume, and status (`live` or `simulated`).

---

## 4. In-Game Ingestion Safeguards

Inside `MarketSyncData/Core.lua`:
- When injecting records into `MarketSync.GetRealmDB().GuildData`:
  ```lua
  if not existing or (entry.t and existing.t < entry.t) then
      guildData[itemKey] = {
          m = entry.m,
          q = entry.q,
          t = entry.t,
          src = "DataPack"
      }
  end
  ```
- **Preserves In-Game Scans**: If a guild member performed a fresh scan in-game at 14:00 and the daily pack was compiled at 06:00, the in-game observation takes precedence.
- **Fail-Closed Faction Isolation**: Partition keys strictly enforce `@Horde`, `@Alliance`, and `@Neutral` scopes.
