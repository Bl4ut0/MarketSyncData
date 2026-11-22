# Setting Up Battle.net API & GitHub Automation

## 1. Obtain Battle.net Developer Credentials

1. Go to the [Battle.net Developer Portal](https://develop.battle.net/access/clients).
2. Log in with your Battle.net account.
3. Click **Create Client**.
   - Client Name: `MarketSyncData Harvester`
   - Redirect URL: `https://localhost` (not used for client_credentials)
4. Copy your **Client ID** and **Client Secret**.

---

## 2. Configure GitHub Secrets

In your GitHub repository for `MarketSyncData`:
1. Navigate to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret** and add:
   - `BLIZZARD_CLIENT_ID`: Your Battle.net Client ID.
   - `BLIZZARD_CLIENT_SECRET`: Your Battle.net Client Secret.
3. *(Optional for CurseForge Auto-Publishing)*:
   - `CURSEFORGE_TOKEN`: An API token generated from your CurseForge author profile.
   - `CURSEFORGE_PROJECT_ID`: The numeric project ID of `MarketSyncData` on CurseForge.

---

## 3. Running Locally

You can test and run the pipeline manually on your local system:

```bash
# Set your environment variables in PowerShell:
$env:BLIZZARD_CLIENT_ID="your_client_id"
$env:BLIZZARD_CLIENT_SECRET="your_client_secret"
$env:BLIZZARD_REGION="us"

# 1. Run the hourly harvest
npm run harvest

# 2. Compile today's blocks into MarketSyncData.lua
npm run compile

# 3. Package the addon zip
npm run package

# 4. Run verification tests
npm test
```
