const fs = require('fs');
const path = require('path');

const STATIC_NAMESPACES = {
  forever: 'static-forever',
  anniversary: 'static-classicann',
  classicEra: 'static-classic1x',
  classic: 'static-classic',
  retail: 'static',
};
const QUALITIES = ['POOR', 'COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ARTIFACT', 'HEIRLOOM'];
const RANGE_SIZE = 1000;
const MAX_RANGES_PER_HARVEST = 120;
const MAX_ITEM_REQUESTS_PER_HARVEST = 2000;

function englishName(value) {
  return typeof value === 'string' ? value : value?.en_US ?? value?.en_GB;
}

function compactItem(data) {
  const name = englishName(data?.name);
  const itemClass = data?.item_class?.id;
  const itemSubclass = data?.item_subclass?.id;
  if (!name || !Number.isInteger(itemClass) || !Number.isInteger(itemSubclass)) return null;
  const quality = QUALITIES.indexOf(data.quality?.type);
  return {
    name,
    itemClass,
    itemSubclass,
    className: englishName(data.item_class.name),
    subclassName: englishName(data.item_subclass.name),
    ...(quality >= 0 ? { quality } : {}),
    ...(Number.isInteger(data.level) ? { itemLevel: data.level } : {}),
    ...(Number.isInteger(data.required_level) ? { reqLevel: data.required_level } : {}),
  };
}

function observedItemIds(partitions) {
  const counts = new Map();
  for (const factions of Object.values(partitions)) {
    for (const entries of Object.values(factions)) {
      for (const [key, entry] of Object.entries(entries)) {
        const id = Number(key.split(':', 1)[0]);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        counts.set(id, (counts.get(id) ?? 0) + entry.listings);
      }
    }
  }
  return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a - b);
}

async function runBatches(values, fn) {
  for (let index = 0; index < values.length; index += 15) {
    await Promise.all(values.slice(index, index + 15).map(fn));
  }
}

async function updateItemCatalog({ client, flavor, region, partitions, datasetsDir, now }) {
  const namespace = STATIC_NAMESPACES[flavor];
  const observed = observedItemIds(partitions);
  if (!namespace || !observed.length) return;

  const directory = path.join(datasetsDir, flavor);
  const output = path.join(directory, 'catalog.json');
  const previous = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : {};
  const items = { ...previous.items };
  const missing = { ...previous.missing };
  const today = now.toISOString().slice(0, 10);
  const unresolved = observed.filter((id) => !items[id] && missing[id] !== today);
  if (!unresolved.length) return;

  const wanted = new Set(unresolved);
  const countsBefore = Object.keys(items).length;
  const origin = `https://${region}.api.blizzard.com`;
  const namespaceQuery = `namespace=${namespace}-${region}`;
  const ranges = [...new Set(unresolved.map((id) => Math.floor((id - 1) / RANGE_SIZE) * RANGE_SIZE + 1))]
    .slice(0, MAX_RANGES_PER_HARVEST);

  async function searchRange(start) {
    const url = new URL('/data/wow/search/item', origin);
    url.search = namespaceQuery;
    url.searchParams.set('id', `[${start},${start + RANGE_SIZE - 1}]`);
    url.searchParams.set('orderby', 'id');
    url.searchParams.set('_pageSize', String(RANGE_SIZE));
    url.searchParams.set('_page', '1');
    const result = await client.requestHref(url.href);
    if (!Array.isArray(result?.results)) throw new Error('Item search response has no results array');
    for (const { data } of result.results) {
      if (!wanted.has(data?.id)) continue;
      const item = compactItem(data);
      if (item) {
        items[data.id] = item;
        delete missing[data.id];
      }
    }
  }

  try {
    // Some game editions expose individual item data before enabling item search.
    await searchRange(ranges[0]);
    await runBatches(ranges.slice(1), async (start) => {
      try { await searchRange(start); } catch {}
    });
  } catch (error) {
    const reason = Number.isInteger(error?.statusCode) ? `HTTP ${error.statusCode}` : 'request failed';
    console.warn(`[Catalog] ${flavor} item search unavailable (${reason}); trying individual item records.`);
  }

  await runBatches(unresolved.filter((id) => !items[id]).slice(0, MAX_ITEM_REQUESTS_PER_HARVEST), async (id) => {
    try {
      const item = compactItem(await client.requestHref(`${origin}/data/wow/item/${id}?${namespaceQuery}`));
      if (item) items[id] = item;
      else missing[id] = today;
    } catch (error) {
      if (error?.statusCode === 404) missing[id] = today;
    }
  });

  const resolved = observed.filter((id) => items[id]).length;
  console.log(`[Catalog] ${flavor}: ${resolved}/${observed.length} observed IDs have Blizzard item metadata (+${Object.keys(items).length - countsBefore} this run).`);
  if (Object.keys(items).length === countsBefore && JSON.stringify(missing) === JSON.stringify(previous.missing ?? {})) return;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ version: 1, flavor, items, missing }) + '\n', 'utf8');
}

module.exports = { compactItem, updateItemCatalog };
