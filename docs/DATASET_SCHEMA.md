# Dataset Block & Compilation Schema

## 1. Hourly Block Schema (`datasets/YYYY-MM-DD/HH-00.json`)

```json
{
  "version": "1.0",
  "timestamp": 1795324800,
  "isoDate": "2026-11-22T07:00:00.000Z",
  "region": "us",
  "rulesets": {
    "english": {
      "Horde": {
        "13464": {
          "minPrice": 12500,
          "maxPrice": 15000,
          "totalQty": 48,
          "listings": 6,
          "time": 1795324800
        },
        "19999:832": {
          "minPrice": 5000,
          "maxPrice": 5000,
          "totalQty": 1,
          "listings": 1,
          "time": 1795324800
        }
      },
      "Alliance": { ... },
      "Neutral": { ... }
    }
  },
  "stats": {
    "totalItems": 14200,
    "totalVolume": 85000,
    "status": "live"
  }
}
```

### Field Definitions:
- `key`: Standard Item ID (`13464`) or Suffix Variant (`<ItemID>:<SuffixID>`).
- `minPrice`: Lowest buyout price in copper ($10,000\text{ copper} = 1\text{ gold}$).
- `maxPrice`: Highest buyout price observed during that hour.
- `totalQty`: Total aggregated quantity of that item available across all active listings.
- `listings`: Total number of individual auction listings.
- `time`: Unix epoch timestamp when the observation occurred.

---

## 2. Tracking Manifest Schema (`datasets/index.json`)

```json
{
  "blocks": [
    {
      "date": "2026-11-22",
      "hour": "07",
      "path": "datasets/2026-11-22/07-00.json",
      "items": 14200,
      "volume": 85000,
      "timestamp": 1795324800,
      "simulated": false
    }
  ],
  "lastUpdated": "2026-11-22T07:05:00.000Z"
}
```

---

## 3. In-Game Lua Data Pack Schema (`MarketSyncData.lua`)

```lua
MarketSyncDataDB = MarketSyncDataDB or {}
MarketSyncData.generatedAt = 1795324800
MarketSyncData.version = "2026.11.22"

MarketSyncDataDB["english@Horde"] = {
  ["13464"] = { m = 12500, q = 48, t = 1795324800 },
  ["13463"] = { m = 8500, q = 120, t = 1795324800 },
}

MarketSyncDataDB["english@Alliance"] = {
  ["13464"] = { m = 13000, q = 32, t = 1795324800 },
}

MarketSyncDataDB["english@Neutral"] = { ... }
```
