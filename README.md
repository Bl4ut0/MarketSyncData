# MarketSyncData — Multi-Flavor Auction House DataSync Pipeline

**Automated hourly auction harvesting, permanent historical archival, and daily per-version addon compilation for [MarketSync](https://github.com/Bl4ut0/MarketSync) and [MarketSyncWeb](https://github.com/Bl4ut0/MarketSyncData).**

This repository automates ingestion, long-term archival, and compilation of Auction House and Commodity data across **all supported World of Warcraft flavors** via Blizzard's official Game Data API (`@pinta365/blizzard_api`). Full hourly snapshots remain archived permanently in `datasets/` as the web data store, while the daily compiler packages **strictly per-flavor 90-day addon bundles** so Forever data never mixes into Anniversary, Classic Era, Classic Progression, or Retail installs.

---

## Supported Game Flavors & Per-Version Releases

| Flavor Key | Target Game Version | Interface TOC | Daily Release Archive |
| :--- | :--- | :--- | :--- |
| **`forever`** | WoW: Forever (`pvp`, `normal`, `roleplay`, `roleplaypvp`) | `16001` | `MSData-Forever-YYYY-MM-DD.zip` |
| **`anniversary`** | Classic Anniversary (`dreamscythe`, `nightslayer`, `maladath`) | `20506`, `20505`, `11509`, `11508` | `MSData-Anniversary-YYYY-MM-DD.zip` |
| **`classicEra`** | Classic Era / SoD / Hardcore (23 connected realms) | `11509`, `11508` | `MSData-ClassicEra-YYYY-MM-DD.zip` |
| **`classic`** | Classic Progression (23 connected realms) | `50503`, `38000`, `20506`, `20505` | `MSData-Classic-YYYY-MM-DD.zip` |
| **`retail`** | Modern Retail (region-wide commodities) | `120001`, `120000` | `MSData-Retail-YYYY-MM-DD.zip` |

> **Per-Flavor Isolation**: Each compiled addon zip contains **only its own flavor's 90-day rolling dataset**, and `MarketSyncData/Core.lua` verifies `GetBuildInfo()` against `MarketSyncData.flavor` before injecting data into MarketSync so mismatched packs never cross-contaminate another game client.

---

## Features

- **Hourly Multi-Flavor Harvesting**: [`hourly-harvest.yml`](.github/workflows/hourly-harvest.yml) runs hourly at `:12` past the hour (with a `:42` automatic retry if GitHub queues/drops `:12`) to snapshot all 5 flavors across Alliance, Horde, Neutral/Blackwater, CrossFaction, and Commodities.
- **Permanent GitHub Historical Archive**: All hourly blocks are retained indefinitely in `datasets/<flavor>/YYYY-MM-DD/HH-00.json` and indexed in `datasets/index.json` for `MarketSyncWeb` long-term price history without requiring an external database.
- **90-Day Per-Flavor Daily Compiler**: [`daily-compile.yml`](.github/workflows/daily-compile.yml) runs daily at `06:20 UTC`, filters each flavor strictly to the latest **90 days** of JSON blocks (`RETENTION_DAYS = 90`), generates flavor-scoped `MarketSyncData.lua` + `MarketSyncData.toc` builds under `dist/builds/<Flavor>/`, and publishes separate `MSData-<Flavor>-YYYY-MM-DD.zip` packages to GitHub Releases and CurseForge.
- **Non-Destructive In-Game Sync**: On login, `MarketSyncData/Core.lua` seeds `MarketSync` with baseline observations without overwriting fresher in-game local or guild scans.

---

## Quick Start (Local Development)

```bash
# 1. Install dependencies
npm install

# 2. Run multi-flavor pipeline & Lua compatibility tests
npm test

# 3. Harvest current hour (simulated without credentials, or live with credentials)
npm run harvest

# 4. Compile 90-day per-flavor builds into dist/builds/<Flavor>/MarketSyncData/
npm run compile

# 5. Package dated per-flavor release zips into dist/MSData-<Flavor>-<Date>.zip
npm run package

# 6. Deploy each flavor's matching build into local WoW installs (_forever_, _anniversary_, etc.)
powershell -ExecutionPolicy Bypass -File scripts/deploy_local.ps1 -Product all
```

---

## Repository Structure

```text
MarketSyncData/
├── .github/workflows/
│   ├── hourly-harvest.yml     # Cron (12,42 * * * *): harvests all 5 flavors & commits hourly block
│   └── daily-compile.yml      # Cron (20 6 * * *): compiles 90-day per-flavor packs & publishes releases
├── MarketSyncData/            # Core Lua addon loader + default manifest
│   ├── MarketSyncData.toc     # Client interface manifest
│   ├── MarketSyncData.lua     # Compiled Lua pricing table
│   └── Core.lua               # Flavor-guarded ingestion into MarketSync
├── scripts/
│   ├── harvest.js             # Multi-flavor harvester using @pinta365/blizzard_api
│   ├── compile.js             # 90-day per-flavor Lua dataset compiler (dist/builds/<Flavor>/)
│   ├── package.js             # Builds MSData-<Flavor>-<Date>.zip release archives
│   └── deploy_local.ps1       # Maps & deploys each flavor build to its local WoW client directory
├── datasets/                  # Permanent historical dataset blocks partitioned by flavor & UTC date
│   ├── forever/
│   ├── anniversary/
│   ├── classicEra/
│   ├── classic/
│   ├── retail/
│   └── index.json             # Global manifest indexing every recorded snapshot block
├── docs/
│   ├── ARCHITECTURE.md        # Pipeline, flavor isolation, and Forever house mapping details
│   ├── DATASET_SCHEMA.md      # Hourly block, index manifest, and compiled Lua schemas
│   └── SETUP.md               # Guide to configuring Battle.net, CurseForge, & GitHub secrets
└── tests/
    ├── test_pipeline.js       # Multi-flavor harvest, 90-day compile, & MSData-*.zip tests
    └── test_lua_core.js       # Fengari Lua 5.1 ingestion & realmless empty-string regression test
```

---

## Documentation

- **[Architecture & Multi-Flavor Pipeline](docs/ARCHITECTURE.md)**
- **[Dataset & Lua Table Schemas](docs/DATASET_SCHEMA.md)**
- **[Battle.net API & GitHub Setup Guide](docs/SETUP.md)**

---

## License

MarketSyncData is free and open-source software licensed under the **GNU General Public License v3.0** (GPL-3.0). See [LICENSE](LICENSE) for details.
