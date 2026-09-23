'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-api-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
// No neighbour in a test: 'off' skips the check entirely, so /api/status does
// not spend a DNS lookup on a container name that only exists on Umbrel.
process.env.PEERMAP_HEALTH_URL = 'off';

const db = require('../src/lib/db');
const health = require('../src/lib/health');
const { server } = require('../src/dashboard-server');

let baseUrl;

test.before(async () => {
  db.open();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
});

async function api(pathname, options = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

test('POST /api/pools rejects a port that would crash the stratum service', async () => {
  // The HTML input has min/max attributes, but the API is reachable directly
  // and a stored out-of-range port used to put stratum-race into a restart
  // loop nothing could clear. Rejection has to happen here, not in the form.
  for (const port of [333333, 0, -1, 65536, 'abc']) {
    const { status, body } = await api('/api/pools', {
      method: 'POST',
      body: JSON.stringify({ label: 'Typo', host: 'pool.example', port }),
    });
    assert.equal(status, 400, `port ${port} must be rejected`);
    assert.match(body.error, /port|required/);
  }
  const stored = db.instance.prepare(`SELECT COUNT(*) AS n FROM stratum_pool WHERE label = 'Typo'`).get().n;
  assert.equal(stored, 0, 'nothing invalid may reach the database');
});

test('POST /api/pools rejects a malformed host and accepts a good one', async () => {
  const bad = await api('/api/pools', {
    method: 'POST',
    body: JSON.stringify({ label: 'Bad', host: 'http://pool.example/x', port: 3333 }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /host/);

  const good = await api('/api/pools', {
    method: 'POST',
    body: JSON.stringify({ label: '  Good Pool  ', host: ' pool.example ', port: '3333' }),
  });
  assert.equal(good.status, 200);
  const row = db.instance.prepare(`SELECT label, host, port FROM stratum_pool WHERE host = 'pool.example'`).get();
  assert.deepEqual(row, { label: 'Good Pool', host: 'pool.example', port: 3333 });
});

test('GET /api/health reports this process and every background service', async () => {
  const { status, body } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.services).sort(), ['peer-profiler', 'relay-profiler', 'stratum-race']);
  // Nothing has written a heartbeat yet, so all three must read as not ok -
  // exactly the state that used to be invisible from anywhere.
  assert.equal(body.allServicesOk, false);
  for (const service of Object.values(body.services)) assert.equal(service.ok, false);

  health.write(db, 'peer-profiler');
  const after = await api('/api/health');
  assert.equal(after.body.services['peer-profiler'].ok, true);
  assert.equal(after.body.services['relay-profiler'].ok, false);
});

test('a stale heartbeat is reported as unhealthy', async () => {
  db.instance
    .prepare(`INSERT INTO meta (key, value) VALUES ('heartbeat:stratum-race', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify({ at: Date.now() - 10 * 60 * 1000 }));
  const { body } = await api('/api/health');
  assert.equal(body.services['stratum-race'].ok, false);
  assert.ok(body.services['stratum-race'].ageMs > 120000);
});

test('GET /api/events streams the current block immediately and stays open', async () => {
  const raceId = db.instance
    .prepare('INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, ?, ?)')
    .run('00000000000000000000feedface', 912345, Date.now()).lastInsertRowid;
  assert.ok(raceId);

  const received = await new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/events`, (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('event: block')) {
          req.destroy();
          resolve(buffer);
        }
      });
    });
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
    setTimeout(() => {
      req.destroy();
      reject(new Error('no block event within 3s'));
    }, 3000).unref();
  });

  const payload = JSON.parse(received.slice(received.indexOf('data: ') + 6, received.indexOf('\n\n', received.indexOf('data: '))));
  assert.equal(payload.blockHeight, 912345);
  assert.equal(payload.blockHash, '00000000000000000000feedface');
});

test('an unknown API route is a 404, not a crash', async () => {
  const { status, body } = await api('/api/nope');
  assert.equal(status, 404);
  assert.equal(body.error, 'not found');
});

// --- Routes the frontend depends on and nothing tested ----------------------
//
// Twelve of sixteen API routes had no test at all, including the one behind
// the Test button and every "400 address required" guard the dashboard relies
// on. These cover the contract each route actually promises its caller.

test('GET /api/status reports the peer counts and the manual cap', async () => {
  const { status, body } = await api('/api/status');
  assert.equal(status, 200);
  assert.equal(typeof body.network, 'string');
  assert.equal(typeof body.live.total, 'number');
  assert.equal(typeof body.live.inbound, 'number');
  assert.equal(typeof body.live.outbound, 'number');
  // The frontend sizes the Manual Peers panel from this; without it the empty
  // slot rows silently fall back to a hardcoded 8.
  assert.equal(typeof body.maxManualPeers, 'number');
});

test('GET /api/peers/ranking answers with an array the tables can render', async () => {
  const { status, body } = await api('/api/peers/ranking');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('the peer routes say what is missing rather than failing obscurely', async () => {
  for (const route of ['/api/peers/untrust', '/api/peers/add-manual', '/api/peers/disconnect']) {
    // eslint-disable-next-line no-await-in-loop
    const { status, body } = await api(route, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(status, 400, `${route} must reject a body with no address`);
    assert.match(body.error, /address/i);
  }
});

test('POST /api/peers/probe answers without touching anything', async () => {
  const before = db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n;
  const { status, body } = await api('/api/peers/probe', {
    method: 'POST',
    body: JSON.stringify({ host: 'not a host at all !!' }),
  });
  assert.equal(status, 422, 'unreachable is an answer, not a server error');
  assert.match(body.error, /invalid host/i);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, before, 'probing is never an action');
});

test('a malformed body is the callers mistake, not a 500', async () => {
  const res = await fetch(`${baseUrl}/api/peers/untrust`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400, 'answering 500 sends whoever is debugging this to the wrong place');
});

test('GET /api/rotation carries the toggle, the log and the parked peers', async () => {
  const { status, body } = await api('/api/rotation');
  assert.equal(status, 200);
  assert.equal(typeof body.enabled, 'boolean');
  assert.ok(Array.isArray(body.log));
  assert.ok(Array.isArray(body.parked), 'the Parked table has no other source');
});

test('POST /api/rotation/toggle round-trips, and GET agrees afterwards', async () => {
  const on = await api('/api/rotation/toggle', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.equal((await api('/api/rotation')).body.enabled, true);

  const off = await api('/api/rotation/toggle', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal(off.body.enabled, false);
  assert.equal((await api('/api/rotation')).body.enabled, false, 'the dashboard reads this back on every poll');
});

test('PATCH /api/pools/:id will not disable a pool because the body was empty', async () => {
  const created = await api('/api/pools', {
    method: 'POST',
    body: JSON.stringify({ label: 'Patch Guard', host: 'patch.example', port: 3333 }),
  });
  assert.equal(created.status, 200);
  const id = db.instance.prepare(`SELECT id FROM stratum_pool WHERE label = 'Patch Guard'`).get().id;

  // This used to answer 200 and set enabled = 0.
  const empty = await api(`/api/pools/${id}`, { method: 'PATCH', body: JSON.stringify({}) });
  assert.equal(empty.status, 400);
  assert.equal(
    db.instance.prepare('SELECT enabled FROM stratum_pool WHERE id = ?').get(id).enabled,
    1,
    'the pool must still be enabled',
  );

  const real = await api(`/api/pools/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
  assert.equal(real.status, 200);
  assert.equal(db.instance.prepare('SELECT enabled FROM stratum_pool WHERE id = ?').get(id).enabled, 0);

  assert.equal((await api('/api/pools/999999', { method: 'PATCH', body: JSON.stringify({ enabled: true }) })).status, 404);
  assert.equal((await api(`/api/pools/${id}`, { method: 'DELETE' })).status, 200);
});

test('GET /api/widget/stats gives Umbrel four tiles it can render', async () => {
  const { status, body } = await api('/api/widget/stats');
  assert.equal(status, 200);
  assert.equal(body.type, 'four-stats');
  assert.equal(body.items.length, 4, 'the four-stats widget type requires exactly four');
  for (const item of body.items) {
    assert.equal(typeof item.title, 'string');
    assert.equal(typeof item.text, 'string', 'a missing value renders as an empty tile on the home screen');
  }
});

test('serveStatic refuses to walk out of the public directory', async () => {
  for (const attempt of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${baseUrl}${attempt}`);
    assert.ok(res.status === 404 || res.status === 403, `${attempt} must not be served`);
  }
  assert.equal((await fetch(`${baseUrl}/favicon.svg`)).status, 200, 'but real assets still serve');
});

// --- security headers -------------------------------------------------------
//
// The same four on every response, and the CSP the same string Peer Map serves
// (its main.go) - the two apps show one node's peers in two windows, so a rule
// that holds in one and not the other is a rule nobody can reason about.

const EXPECTED_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'";

function assertSecured(res, what) {
  assert.equal(res.headers.get('content-security-policy'), EXPECTED_CSP, `${what} must carry the CSP`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${what} must refuse sniffing`);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', `${what} must not be framable`);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${what} must not leak a referrer`);
  // A self-hosted dashboard has no business being readable by another origin,
  // and adding CORS here would hand back exactly what the CSP above refuses.
  assert.equal(res.headers.get('access-control-allow-origin'), null, `${what} must not be CORS-open`);
}

test('every response carries the security headers, page and API alike', async () => {
  assertSecured(await fetch(`${baseUrl}/`), 'the page');
  assertSecured(await fetch(`${baseUrl}/app.js`), 'a static asset');
  assertSecured(await fetch(`${baseUrl}/api/status`), 'an API reply');
  assertSecured(await fetch(`${baseUrl}/api/nope`), 'a 404');
  assertSecured(await fetch(`${baseUrl}/nope.html`), 'a missing file');
  assertSecured(await fetch(`${baseUrl}/../package.json`), 'a refused path');
});

// The policy is only worth serving if the page it is served with satisfies it.
// 'unsafe-inline' is not in that string, so a single inline handler or style
// attribute would silently stop half the dashboard working - and it would work
// perfectly in the developer's browser until the header was added.
test('the frontend satisfies the policy it is served with', async () => {
  const html = await (await fetch(`${baseUrl}/`)).text();
  const js = await (await fetch(`${baseUrl}/app.js`)).text();

  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, 'an inline <script> would need unsafe-inline');
  assert.equal(/<style[\s>]/i.test(html), false, 'an inline <style> block would need unsafe-inline');
  assert.equal(/\son[a-z]+\s*=\s*["']/i.test(html), false, 'an inline event handler would need unsafe-inline');
  assert.equal(/\sstyle\s*=\s*["']/i.test(html), false, 'a style="" attribute would need unsafe-inline');
  // Same three, written from JavaScript into innerHTML - the CSP does not care
  // which file the string came from.
  assert.equal(/<script|<style[\s>]|\sstyle="/i.test(js), false, 'app.js must not inject inline script or style either');
  // connect-src 'self': every request the page makes has to be same-origin.
  // The cross-origin knock on Peer Map's port is gone; /api/status answers
  // that question from the server, which can actually see the container.
  assert.equal(/fetch\(\s*(url|`\$\{location\.protocol\})/.test(js), false, 'a cross-origin fetch would be blocked');
});

// --- typed fields on the write endpoints ------------------------------------

test('a non-string address is refused with 422 rather than acted on', async () => {
  // A number here is not a bad address, it is a different instruction: Core's
  // disconnectnode takes either an address or a numeric peer id and picks by
  // JSON type, so this used to disconnect whatever session Core happened to
  // call peer 3 - one nobody selected and the page may never have shown.
  for (const route of ['/api/peers/untrust', '/api/peers/keep', '/api/peers/disconnect', '/api/peers/add-manual']) {
    for (const address of [3, true, { host: '1.2.3.4' }, ['1.2.3.4:8333'], '   ']) {
      // eslint-disable-next-line no-await-in-loop
      const { status, body } = await api(route, { method: 'POST', body: JSON.stringify({ address }) });
      assert.equal(status, 422, `${route} must refuse ${JSON.stringify(address)}`);
      assert.match(body.error, /address must be a string/, 'and say what it wanted instead');
    }
  }
});

test('a real trusted peer is still removable, and a missing address still says so', async () => {
  // The guard must reject the type, not the route: the string path is what the
  // dashboard's Remove button uses on every manual peer.
  db.instance
    .prepare(`INSERT INTO trusted_peer (address, created_at) VALUES (?, ?)`)
    .run('203.0.113.77:8333', Date.now());
  const { status } = await api('/api/peers/untrust', {
    method: 'POST',
    body: JSON.stringify({ address: '203.0.113.77:8333' }),
  });
  assert.equal(status, 200);
  assert.equal(db.instance.prepare(`SELECT COUNT(*) AS n FROM trusted_peer WHERE address = '203.0.113.77:8333'`).get().n, 0);

  const missing = await api('/api/peers/untrust', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missing.status, 400, 'left out is still 400 - a different mistake from sent wrong');
});

// --- the range on /api/pools ------------------------------------------------

test('a huge range is capped instead of compiling a statement SQLite refuses', async () => {
  // "last N races" becomes one bound parameter per race, and SQLite will not
  // compile a statement with more than 32,766 of them. Number(range) was taken
  // as given, so the size of that list was the caller's to choose and grew with
  // the history on its own: past the limit the panel stopped answering at all.
  const rows = [];
  for (let i = 0; i < 33_000; i += 1) rows.push(i.toString(16).padStart(64, '0'));
  const insert = db.instance.prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, 1)');
  db.instance.transaction((all) => { for (const h of all) insert.run(h); })(rows);

  try {
    const { status, body } = await api('/api/pools?range=100000');
    assert.equal(status, 200, 'a range past the limit must still answer');
    assert.ok(Array.isArray(body));
    // And the ordinary windows are untouched by the cap.
    assert.equal((await api('/api/pools?range=10')).status, 200);
    assert.equal((await api('/api/pools?range=all')).status, 200, 'all-time binds no parameters at all');
  } finally {
    db.instance.prepare('DELETE FROM stratum_race').run();
  }
});

// --- how many event streams may be open -------------------------------------

test('the event stream is capped, and says so politely past the limit', async () => {
  // Each stream is a response held open for as long as its tab plus a
  // keepalive timer; nothing bounded the number, so a page anyone on the LAN
  // can open in a loop was enough to exhaust this process's descriptors.
  const open = [];
  const connect = () => new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/events`, (res) => {
      res.resume();
      resolve({ req, status: res.statusCode });
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
  });

  try {
    for (let i = 0; i < 32; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const c = await connect();
      open.push(c.req);
      assert.equal(c.status, 200, `stream ${i + 1} is within the limit`);
    }
    const refused = await connect();
    open.push(refused.req);
    assert.equal(refused.status, 503, 'the 33rd is refused');
  } finally {
    for (const req of open) req.destroy();
  }

  // And the limit is a limit, not a latch: closing a tab frees its slot.
  await new Promise((r) => setTimeout(r, 200));
  const again = await connect();
  again.req.destroy();
  assert.equal(again.status, 200, 'a freed slot is usable again');
});

// The neighbour's endpoint. Peer Map polls this to mark the peer that
// delivered the last block, so it must answer before any block has ever been
// seen, and it must not hand out anything beyond the block itself.
test('GET /api/blocks/latest serves the neighbour', async () => {
  db.instance.prepare('DELETE FROM relay_observation').run();
  db.instance.prepare('DELETE FROM relay_race').run();

  const empty = await api('/api/blocks/latest');
  assert.equal(empty.status, 200);
  assert.equal(empty.body, null);

  const peer = db.getOrCreatePeer('1.2.3.4:8333');
  const race = db.instance
    .prepare(
      `INSERT INTO relay_race (block_hash, block_height, detected_at, pool_name, pool_tag, pool_source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('00beef', 967724, 1_700_000_000_000, 'Foundry USA', 'Foundry USA Pool', 'address');
  db.instance
    .prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, 1)')
    .run(race.lastInsertRowid, peer.id);

  const { status, body } = await api('/api/blocks/latest');
  assert.equal(status, 200);
  assert.equal(body.height, 967724);
  assert.equal(body.pool, 'Foundry');
  assert.equal(body.poolName, 'Foundry USA');
  assert.equal(body.poolSource, 'address');
  assert.deepEqual(body.firstPeers, ['1.2.3.4:8333']);
  // Addresses, not the owner's own labels for them.
  assert.equal('trustedLabel' in body, false);
});
