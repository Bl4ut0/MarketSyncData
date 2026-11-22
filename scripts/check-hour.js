const fs = require('node:fs');
const path = require('node:path');

const now = new Date().toISOString();
const date = now.slice(0, 10);
const hour = now.slice(11, 13);
const editions = ['forever', 'anniversary', 'classicEra', 'classic', 'retail'];
const complete = editions.every((edition) => {
  const file = path.join(__dirname, '../datasets', edition, date, hour + '-00.json');
  try {
    const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
    return capture.stats?.status === 'live' && capture.stats.totalItems > 0 &&
      !Object.values(capture.markets ?? {}).some((houses) =>
        Object.values(houses).some((market) => market.status === 'unavailable' || market.status === 'partial'));
  } catch {
    return false;
  }
});

process.exitCode = complete ? 0 : 1;
