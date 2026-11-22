# Setting Up Battle.net API, Local Sync, & GitHub Automation

## 1. Obtain Battle.net Developer Credentials

1. Go to the [Battle.net Developer Portal](https://develop.battle.net/access/clients).
2. Log in with your Battle.net account.
3. Click **Create Client**:
   - Client Name: `MarketSyncData`
   - Redirect URL: `https://localhost` *(not used for client_credentials)*
   - Service URL: Check *I do not have a service URL for this client*
4. Copy your **Client ID** and **Client Secret**.

---

## 2. Configure GitHub Secrets

In your GitHub repository (`Bl4ut0/MarketSyncData`):
1. Navigate to **Settings → Secrets and variables → Actions**.
2. Add the required secrets:
   - `BLIZZARD_CLIENT_ID`: Your Battle.net Client ID.
   - `BLIZZARD_CLIENT_SECRET`: Your Battle.net Client Secret.
3. *(Optional for CurseForge Auto-Publishing)*:
   - `CURSEFORGE_TOKEN`: An API token generated from your CurseForge author profile.
   - `CURSEFORGE_PROJECT_ID`: The numeric project ID of `MarketSyncData` on CurseForge.

---

## 3. Automated Schedules

- **Hourly Harvest (`.github/workflows/hourly-harvest.yml`)**: Runs at `:12` past every UTC hour (`cron: '12,42 * * * *'`), with `:42` acting as an automatic backup if GitHub delays or drops the `:12` queue slot (skipping cleanly if the current UTC hour already exists on disk). Stores snapshots across all 5 flavors permanently in `datasets/`.
- **Daily Compile & Release (`.github/workflows/daily-compile.yml`)**: Runs once daily at `06:20 UTC` (`cron: '20 6 * * *'`), trims each flavor's compilation to the latest **90 days** (`RETENTION_DAYS = 90`), packages `MSData-<Flavor>-YYYY-MM-DD.zip`, and publishes them to GitHub Releases (and CurseForge when configured).

---

## 4. Running Locally

```powershell
# Optional: set Battle.net credentials for live local harvesting (otherwise simulates blocks)
$env:BLIZZARD_CLIENT_ID="your_client_id"
$env:BLIZZARD_CLIENT_SECRET="your_client_secret"
$env:BLIZZARD_REGION="us"

# 1. Run multi-flavor harvest (optional: $env:HARVEST_FLAVORS="forever,anniversary")
npm run harvest

# 2. Compile 90-day per-flavor builds into dist/builds/<Flavor>/MarketSyncData/
npm run compile

# 3. Package per-flavor zips (dist/MSData-<Flavor>-YYYY-MM-DD.zip)
npm run package

# 4. Run pipeline + Lua ingestion tests
npm test

# 5. Deploy matching flavor builds directly into local WoW client folders
powershell -ExecutionPolicy Bypass -File scripts/deploy_local.ps1 -Product all
```
