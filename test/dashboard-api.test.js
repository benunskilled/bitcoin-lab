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
