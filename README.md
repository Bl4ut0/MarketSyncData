# MarketSyncData — Automated Auction House DataSync Pipeline

**Automated daily auction house compilation and distribution pack for the [MarketSync](https://github.com/Bl4ut0/MarketSync) World of Warcraft addon.**

This repository automates the ingestion, archival, and compilation of live World of Warcraft: Forever auction house and commodity data via Blizzard's official API, publishing daily pre-compiled datasets so players have a baseline market loaded the moment they log in.

---

## Features

- **Automated Hourly Harvesting**: Queries realmless rulesets (`Normal`, `PvP`, `RP`) using `@pinta365/blizzard_api`, extracting live auction listings and commodities across Alliance, Horde, and Neutral markets.
- **Partitioned Dataset Archival**: Records hourly snapshot blocks under `datasets/YYYY-MM-DD/HH-00.json`, tracking minimum buyouts, market depth, and total volume.
- **Daily Compilation Engine**: Compiles the day's 24 hourly blocks into an optimized, Base-36 compatible `MarketSyncData.lua` file at 06:00 UTC daily.
- **Plug-and-Play In-Game Addon**: Distributes as a standard World of Warcraft companion addon (`MarketSyncData`), automatically ingested into MarketSync on login without overwriting fresher in-game guild scans.
- **Continuous Deployment**: Automated GitHub Actions workflows for both hourly harvesting and daily release publishing (GitHub Releases & CurseForge API).

---

## Quick Start (Local Development)

```bash
# 1. Install dependencies
npm install

# 2. Run test pipeline
npm test

# 3. Harvest current hour (simulated without credentials, or live with credentials)
npm run harvest

# 4. Compile today's blocks into MarketSyncData.lua
npm run compile

# 5. Build distribution zip
npm run package
```

---

## Repository Structure

```text
MarketSyncData/
├── .github/workflows/
│   ├── hourly-harvest.yml     # Hourly cron: gathers API data & commits block
│   └── daily-compile.yml      # Daily cron (06:00 UTC): compiles data pack & publishes release
├── MarketSyncData/            # In-game World of Warcraft companion addon
│   ├── MarketSyncData.toc     # Multi-version client manifest (16001, 11509, 120001)
│   ├── MarketSyncData.lua     # Daily compiled auction pricing data table
│   └── Core.lua               # AddOn registration & ingestion into MarketSync
├── scripts/
│   ├── harvest.js             # Hourly harvest script using @pinta365/blizzard_api
│   ├── compile.js             # Aggregates hourly blocks into MarketSyncData.lua
│   └── package.js             # Packages addon into dist/MarketSyncData.zip
├── datasets/                  # Historical dataset blocks & database tracking manifest
│   └── index.json             # Manifest of all recorded blocks
├── docs/
│   ├── ARCHITECTURE.md        # Technical architectural breakdown
│   ├── DATASET_SCHEMA.md      # Hourly and compiled data schemas
│   └── SETUP.md               # Guide to configuring Battle.net & GitHub secrets
└── tests/
    └── test_pipeline.js       # End-to-end integration tests
```

---

## Documentation

- **[Architecture & Ingestion Pipeline](docs/ARCHITECTURE.md)**
- **[Dataset & Lua Table Schemas](docs/DATASET_SCHEMA.md)**
- **[Battle.net API & GitHub Setup Guide](docs/SETUP.md)**

---

## License

MarketSyncData is free and open-source software licensed under the **GNU General Public License v3.0** (GPL-3.0). See [LICENSE](LICENSE) for details.
