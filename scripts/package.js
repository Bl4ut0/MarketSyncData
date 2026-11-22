/**
 * MarketSync DataSync - Release Packager
 * 
 * Packages the MarketSyncData addon folder into a clean distribution .zip
 * ready for CurseForge, GitHub Releases, or manual installation.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const ADDON_DIR = path.join(ROOT_DIR, 'MarketSyncData');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUTPUT_ZIP = path.join(DIST_DIR, 'MarketSyncData.zip');

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

function packageAddon() {
  console.log(`[MarketSyncData Packager] Packaging addon from ${ADDON_DIR}...`);

  // Verify TOC and Lua files exist
  const tocFile = path.join(ADDON_DIR, 'MarketSyncData.toc');
  const coreFile = path.join(ADDON_DIR, 'Core.lua');
  const dataFile = path.join(ADDON_DIR, 'MarketSyncData.lua');

  if (!fs.existsSync(tocFile) || !fs.existsSync(coreFile) || !fs.existsSync(dataFile)) {
    throw new Error(`Missing core addon files in ${ADDON_DIR}. Cannot package.`);
  }

  // Remove old zip if present
  if (fs.existsSync(OUTPUT_ZIP)) {
    fs.unlinkSync(OUTPUT_ZIP);
  }

  // Cross-platform compression (PowerShell on Windows, zip on Linux/macOS)
  const isWindows = process.platform === 'win32';
  try {
    if (isWindows) {
      // Use PowerShell Compress-Archive
      const psCmd = `powershell -NoProfile -Command "Compress-Archive -Path '${ADDON_DIR}' -DestinationPath '${OUTPUT_ZIP}' -Force"`;
      execSync(psCmd, { stdio: 'inherit' });
    } else {
      // Linux / macOS runner
      const zipCmd = `cd "${ROOT_DIR}" && zip -r "${OUTPUT_ZIP}" "MarketSyncData"`;
      execSync(zipCmd, { stdio: 'inherit' });
    }

    const zipSizeKB = Math.round(fs.statSync(OUTPUT_ZIP).size / 1024);
    console.log(`[MarketSyncData Packager] Successfully built ${OUTPUT_ZIP} (${zipSizeKB} KB).`);
    return OUTPUT_ZIP;
  } catch (err) {
    console.error(`[Packager Error] Failed to create zip: ${err.message}`);
    throw err;
  }
}

if (require.main === module) {
  packageAddon();
}

module.exports = { packageAddon };
