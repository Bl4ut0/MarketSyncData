# Dataset Block & Compilation Schema

## 1. Hourly Block Schema (`datasets/<flavor>/YYYY-MM-DD/HH-00.json`)

Each flavor writes its own hourly snapshot block under `datasets/<flavor>/YYYY-MM-DD/HH-00.json` (for example `datasets/forever/2026-11-22/17-00.json`, `datasets/anniversary/2026-11-22/17-00.json`, `datasets/classic/2026-11-22/17-00.json`, `datasets/retail/2026-11-22/17-00.json`):

```json
{
  "version": "1.0",
  "flavor": "forever",
  "timestamp": 1795368000,
  "isoDate": "2026-11-22T17:20:00.000Z",
  "region": "us",
  "rulesets": {
    "pvp": {
      "Alliance": {
        "13464": {
          "minPrice": 12500,
          "maxPrice": 15000,
          "totalQty": 48,
          "listings": 6,
          "time": 1795368000
        },
        "19999:832": {
          "minPrice": 5000,
          "maxPrice": 5000,
          "totalQty": 1,
          "listings": 1,
          "time": 1795368000
        }
      },
      "Horde": { "...": "..." },
      "Neutral": { "...": "..." }
    }
  },
  "stats": {
    "totalItems": 115254,
    "totalVolume": 1234567,
    "status": "live"
  }
}
```

### Field Definitions
- `flavor`: `"forever" | "anniversary" | "classicEra" | "classic" | "retail"`.
- `rulesets`: Maps canonical ruleset key (`pvp`, `normal`, `roleplay`, `roleplaypvp`) or connected realm slug (`dreamscythe`, `pagle`, `whitemane`, `region`) to auction house buckets (`Alliance`, `Horde`, `Neutral`, `CrossFaction`, `Commodities`).
- `itemKey`: Standard Item ID (`"13464"`), Random Suffix Variant (`"<ItemID>:<SuffixID>"`), or Pet Cage (`"82800:<SpeciesID>"`).
- `minPrice` / `maxPrice`: Unit buyout (or fallback unit bid) price in copper ($10,000\text{ copper} = 1\text{ gold}$).
- `totalQty` is the number of individual units across listings with a reported price. `listings` counts those auctions separately.
- `time`: Unix epoch seconds when the observation was harvested.
- `markets` is an optional map keyed by partition and auction house. Each result records the number of upstream listings and whether the capture was `available`, `empty`, `partial`, or `unavailable`.

The harvester also writes a compact Blizzard item catalog at `datasets/<flavor>/catalog.json`. Its `items` object maps each covered item ID to its name, item class and subclass IDs, and optional rarity and level data. This file is independent of the hourly captures. Older captures remain readable when no catalog is available.

---

## 2. Tracking Manifest Schema (`datasets/index.json`)

```json
{
  "blocks": [
    {
      "flavor": "forever",
      "date": "2026-11-22",
      "hour": "17",
      "path": "datasets/forever/2026-11-22/17-00.json",
      "items": 115254,
      "volume": 1234567,
      "timestamp": 1795368000,
      "simulated": false
    },
    {
      "flavor": "anniversary",
      "date": "2026-11-22",
      "hour": "17",
      "path": "datasets/anniversary/2026-11-22/17-00.json",
      "items": 0,
      "volume": 0,
      "timestamp": 1795368000,
      "simulated": false
    }
  ],
  "lastUpdated": "2026-11-22T17:20:00.000Z"
}
```

*Note: Early pre-flavor blocks (`2026-11-22 07:00` and `08:00 UTC`) omit `flavor` and default to `"forever"` in consumers.*

---

## 3. Compiled Per-Flavor Lua Schema (`MarketSyncData.lua`)

Each compiled release archive (`MSData-<Flavor>-YYYY-MM-DD.zip`) writes **only its target flavor's 90-day dataset**:

```lua
MarketSyncDataDB = MarketSyncDataDB or {}
MarketSyncData.generatedAt = 1795368000
MarketSyncData.version = "2026.11.22"
MarketSyncData.flavor = "forever"

MarketSyncDataDB["pvp@Horde"] = {
  ["13464"] = { m = 12500, q = 48, t = 1795368000 },
  ["13463"] = { m = 8500, q = 120, t = 1795368000 },
}
```
