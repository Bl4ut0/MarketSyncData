const host = 'https://us.api.blizzard.com';
const prefix = '/data/wow';
const clientId = process.env.BLIZZARD_CLIENT_ID;
const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;

async function authenticate() {
  if (!clientId || !clientSecret) throw new Error('Blizzard OAuth credentials are required.');
  const response = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64') },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Blizzard OAuth HTTP ' + response.status);
  const { access_token: token } = await response.json();
  if (!token) throw new Error('Blizzard OAuth returned no access token.');
  return token;
}

function target(path, namespace) {
  const url = new URL(path, host);
  if (url.origin !== host || !url.pathname.startsWith(prefix + '/')) throw new Error('Unexpected Blizzard API URL.');
  if (namespace) url.searchParams.set('namespace', namespace);
  url.searchParams.set('locale', 'en_US');
  url.searchParams.sort();
  return url.href;
}

async function get(token, url) {
  try {
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { http: response.status };
    }
    return { http: response.status, data: await response.json() };
  } catch (error) {
    return { error: error.name };
  }
}

function describe(response) {
  const auctions = response.data?.auctions;
  return {
    http: response.http,
    error: response.error,
    rows: Array.isArray(auctions) ? auctions.length : null,
    withQuantity: Array.isArray(auctions) ? auctions.filter(row => Number.isSafeInteger(row.quantity) && row.quantity > 0).length : null,
    units: Array.isArray(auctions) ? auctions.reduce((sum, row) => sum + (Number.isSafeInteger(row.quantity) && row.quantity > 0 ? row.quantity : 0), 0) : null,
    keys: response.data && Object.keys(response.data),
  };
}

function log(event, data) {
  console.log(event + ' ' + JSON.stringify(data));
}

function connectedId(link) {
  return String(link?.href || link?.key?.href || '').match(/connected-realm\/(\d+)/)?.[1];
}

async function auditRealm(token, version, namespace, ref, factionHouses) {
  const id = connectedId(ref);
  if (!id) return;
  const realmPath = prefix + '/connected-realm/' + id;
  const metadata = await get(token, target(realmPath, namespace));
  const realm = metadata.data?.realms?.[0]?.slug ?? 'cr' + id;

  if (!factionHouses) {
    const combined = await get(token, target(realmPath + '/auctions', namespace));
    log('COMBINED', { version, realm, id, ...describe(combined) });
    return;
  }

  const index = await get(token, target(realmPath + '/auctions/index', namespace));
  const houses = Array.isArray(index.data?.auctions) ? index.data.auctions : [];
  log('HOUSE_INDEX', { version, realm, id, http: index.http, houses: houses.length, error: index.error });
  let anyData = false;
  for (const house of houses) {
    const path = realmPath + '/auctions/' + house.id;
    const candidates = [];
    if (house.key?.href || house.href) {
      try {
        candidates.push(['advertised', target(house.key?.href ?? house.href)]);
      } catch {
        log('UNEXPECTED_HREF', { version, realm, id, houseId: house.id });
      }
    }
    const canonical = target(path, namespace);
    if (!candidates.some(([, url]) => url === canonical)) candidates.push(['canonical', canonical]);
    for (const [route, url] of candidates) {
      const response = await get(token, url);
      const status = describe(response);
      log('HOUSE', { version, realm, id, houseId: house.id, house: house.name, route, ...status });
      if (status.rows !== null) {
        anyData ||= status.rows > 0;
        break;
      }
    }
  }
  if (!anyData && ['whitemane', 'mankrik', 'dreamscythe', 'nightslayer', 'maladath'].includes(realm)) {
    const alternatives = [realmPath + '/auctions/', realmPath + '/auctions'];
    if (metadata.data?.auctions?.href) {
      try {
        alternatives.push(target(metadata.data.auctions.href));
      } catch {
        log('UNEXPECTED_REALM_HREF', { version, realm, id });
      }
    }
    for (const url of new Set(alternatives.map(path => target(path, namespace)))) {
      const response = await get(token, url);
      log('REALM_AUCTIONS', { version, realm, id, path: new URL(url).pathname, ...describe(response) });
    }
  }
}

async function main() {
  const token = await authenticate();
  for (const [version, namespace, factionHouses] of [
    ['classicEra', 'dynamic-classic1x-us', true],
    ['anniversary', 'dynamic-classicann-us', true],
    ['classic', 'dynamic-classic-us', false],
  ]) {
    const index = await get(token, target(prefix + '/connected-realm/index', namespace));
    const realms = index.data?.connected_realms ?? [];
    log('REALM_INDEX', { version, namespace, http: index.http, realms: realms.length, error: index.error });
    for (let cursor = 0; cursor < realms.length; cursor += 4) {
      await Promise.all(realms.slice(cursor, cursor + 4).map(ref => auditRealm(token, version, namespace, ref, factionHouses)));
    }
  }
  for (const [version, path, namespace] of [
    ['retail', '/auctions/commodities', 'dynamic-us'],
    ['forever-auctions', '/ruleset/1/auctions/110', 'dynamic-forever-us'],
    ['forever-commodities', '/ruleset/1/auctions/110/commodities', 'dynamic-forever-us'],
  ]) {
    log('CONTROL', { version, ...describe(await get(token, target(prefix + path, namespace))) });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
