/**
 * MarketSync DataSync - Multi-Flavor Release Packager
 * 
 * Packages each game flavor's 90-day MarketSyncData build into a dated .zip archive:
 *   - dist/MSData-Forever-YYYY-MM-DD.zip
 *   - dist/MSData-Anniversary-YYYY-MM-DD.zip
 *   - dist/MSData-ClassicEra-YYYY-MM-DD.zip
 *   - dist/MSData-Classic-YYYY-MM-DD.zip
 *   - dist/MSData-Retail-YYYY-MM-DD.zip
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { FLAVOR_CONFIG } = require('./compile');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const BUILDS_DIR = path.join(DIST_DIR, 'builds');

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

function zipDirectory(sourceAddonDir, outputZipPath) {
  if (fs.existsSync(outputZipPath)) {
    fs.unlinkSync(outputZipPath);
  }

  const isWindows = process.platform === 'win32';
  if (isWindows) {
    const psCmd = `powershell -NoProfile -Command "Compress-Archive -Path '${sourceAddonDir}' -DestinationPath '${outputZipPath}' -Force"`;
    execSync(psCmd, { stdio: 'inherit' });
  } else {
    const parentDir = path.dirname(sourceAddonDir);
    const folderName = path.basename(sourceAddonDir);
    const zipCmd = `cd "${parentDir}" && zip -r "${outputZipPath}" "${folderName}"`;
    execSync(zipCmd, { stdio: 'inherit' });
  }
}

function packageAll(dateStr = new Date().toISOString().slice(0, 10)) {
  const outputs = [];
  for (const cfg of Object.values(FLAVOR_CONFIG)) {
    const buildAddonDir = path.join(BUILDS_DIR, cfg.label, 'MarketSyncData');
    if (!fs.existsSync(buildAddonDir)) {
      console.warn(`[Packager] Build directory missing for ${cfg.label}, skipping.`);
      continue;
    }

    const outputZip = path.join(DIST_DIR, `MSData-${cfg.label}-${dateStr}.zip`);
    zipDirectory(buildAddonDir, outputZip);
    const sizeKB = Math.round(fs.statSync(outputZip).size / 1024);
    console.log(`[Packager] Built ${outputZip} (${sizeKB} KB)`);
    outputs.push(outputZip);
  }

  return outputs;
}

if (require.main === module) {
  const argDate = process.argv[2];
  packageAll(argDate);
}

module.exports = { packageAll };
