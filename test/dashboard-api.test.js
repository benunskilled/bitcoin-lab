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
