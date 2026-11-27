/**
 * Uploads each Forever data pack zip to its CurseForge project.
 *
 * Reads scripts/curseforge-packs.json. A pack is uploaded only when its project ID and the
 * manifest's gameVersionIds are filled in. Anything else is skipped with a message, so the
 * workflow can run before every project exists.
 *
 * Usage: node scripts/upload-packs.js YYYY-MM-DD
 * Needs CF_API_TOKEN in the environment when at least one project is registered.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'curseforge-packs.json'), 'utf8'));
const DIST_DIR = process.env.MARKETSYNC_BUILD_DIR || path.join(__dirname, '..', 'dist');
const dateStr = process.argv[2] || new Date().toISOString().slice(0, 10);

async function uploadPack(project, zipPath, gameVersionIds, token) {
  const form = new FormData();
  form.append('metadata', JSON.stringify({
    displayName: `${project.displayName} ${dateStr}`,
    gameVersions: gameVersionIds,
    releaseType: 'release',
    changelog: `Automated data refresh ${dateStr}.`,
    changelogType: 'markdown',
  }));
  form.append('file', new Blob([fs.readFileSync(zipPath)]), path.basename(zipPath));

  const response = await fetch(`https://wow.curseforge.com/api/projects/${project.curseforgeProjectId}/upload-file`, {
    method: 'POST',
    headers: { 'x-api-token': token },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${project.pack}: upload failed with HTTP ${response.status}: ${text}`);
  return text;
}

// Forever matches the MarketSync TOC interface 16001, which is game version "1.60.1" on CurseForge.
// The daily release job matches Forever the same way (name plus gameVersionTypeID 88568).
const FOREVER_VERSION_NAME = '1.60.1';
const FOREVER_VERSION_TYPE_ID = 88568;

async function resolveForeverVersionIds(token) {
  const response = await fetch('https://wow.curseforge.com/api/game/wow/versions', {
    headers: { 'x-api-token': token },
  });
  if (!response.ok) throw new Error(`version lookup failed with HTTP ${response.status}`);
  const versions = await response.json();
  return versions
    .filter((v) => v.name === FOREVER_VERSION_NAME && v.gameVersionTypeID === FOREVER_VERSION_TYPE_ID)
    .map((v) => v.id);
}

async function main() {
  const token = process.env.CURSEFORGE_TOKEN || process.env.CF_API_TOKEN;
  let gameVersionIds = MANIFEST.gameVersionIds;
  if ((!Array.isArray(gameVersionIds) || gameVersionIds.length === 0) && token) {
    gameVersionIds = await resolveForeverVersionIds(token);
    console.log(`resolved Forever game versions: ${gameVersionIds.join(', ') || 'none'}`);
  }
  const ready = Array.isArray(gameVersionIds) && gameVersionIds.length > 0;

  // Every pack gets a status line, whether it uploads or not, so a skip is never silent.
  const report = [];
  for (const project of MANIFEST.projects) {
    const zipPath = path.join(DIST_DIR, `${project.pack}-${dateStr}.zip`);
    const row = { pack: project.pack, project: project.curseforgeProjectId, uploaded: false, reason: '', blocking: false };
    if (!fs.existsSync(zipPath)) {
      row.reason = 'no archive for this date';
    } else if (!project.curseforgeProjectId) {
      row.reason = 'no CurseForge project ID in curseforge-packs.json';
    } else if (!ready) {
      row.reason = 'no game version IDs (gameVersionIds null and lookup found none)';
      row.blocking = true;
    } else if (!token) {
      row.reason = 'no CurseForge token (CURSEFORGE_TOKEN is not set)';
      row.blocking = true;
    } else {
      await uploadPack(project, zipPath, gameVersionIds, token);
      row.uploaded = true;
    }
    report.push(row);
    const line = row.uploaded ? 'UPLOADED' : `SKIPPED (${row.reason})`;
    console.log(`${project.pack} -> project ${row.project ?? 'none'}: ${line}`);
  }

  const uploadedCount = report.filter((r) => r.uploaded).length;
  console.log(`summary: ${uploadedCount} uploaded, ${report.length - uploadedCount} skipped of ${report.length}`);

  // A pack with an archive and a project ID that could not upload fails the run.
  // Missing archives or project IDs are reported above and do not fail it.
  const blocked = report.filter((r) => r.blocking && r.project);
  if (blocked.length > 0) {
    throw new Error(`not uploaded despite a project ID: ${blocked.map((r) => r.pack).join(', ')}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
