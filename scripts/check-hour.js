const fs = require('node:fs');
const path = require('node:path');

const editions = ['forever', 'anniversary', 'classicEra', 'classic', 'retail'];
const reportPath = path.join(process.env.DATASETS_DIR || path.join(__dirname, '../datasets'), 'harvest-status.json');

function complete(edition) {
  if (edition?.status === 'available') return true;
  const checkedHouses = Object.values(edition?.markets ?? {}).flatMap(Object.values);
  const errors = [...(edition?.errors ?? []), ...checkedHouses.flatMap(house => house.errors ?? [])];
  // A confirmed missing endpoint is checked again in the next hour. Retry other failures.
  return errors.length > 0 && errors.every(error => error.httpStatus === 404);
}

try {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const currentHour = new Date().toISOString().slice(0, 13);
  process.exitCode = report.checkedAt?.slice(0, 13) === currentHour &&
    editions.every(edition => complete(report.editions?.[edition])) ? 0 : 1;
} catch {
  process.exitCode = 1;
}
