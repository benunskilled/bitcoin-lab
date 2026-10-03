'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-csrf-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
process.env.PEERMAP_HEALTH_URL = 'off';

const db = require('../src/lib/db');
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

function rotationEnabled() {
  const row = db.instance.prepare(`SELECT value FROM meta WHERE key = 'peer_rotation_enabled'`).get();
  return row ? row.value : null;
}

// What a page on another site can send without asking first: an HTML form
// with enctype="text/plain" posts `name=value`, and a name of
// `{"enabled":true,"x":"` with a value of `"}` makes the body valid JSON.
test('a text/plain POST - what a form on another site sends - changes nothing', async () => {
  const res = await fetch(`${baseUrl}/api/rotation/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"enabled":true,"x":"="}',
  });
  assert.equal(res.status, 415);
  assert.equal(rotationEnabled(), null, 'the switch must not have been touched');
});

test('a write without any Content-Type is refused as well', async () => {
  const res = await fetch(`${baseUrl}/api/reset`, { method: 'POST', body: '{"scope":"pools"}' });
  // fetch labels a string body text/plain on its own; either way it is not JSON.
  assert.equal(res.status, 415);
});

test('a JSON write the browser marks as coming from another site is refused', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const res = await fetch(`${baseUrl}/api/rotation/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': site },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 403, `Sec-Fetch-Site: ${site}`);
  }
  assert.equal(rotationEnabled(), null);
});

test('without Sec-Fetch-Site, a foreign Origin is refused', async () => {
  const res = await fetch(`${baseUrl}/api/rotation/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 403);
  assert.equal(rotationEnabled(), null);
});

test('the dashboard itself still gets through: same origin, JSON', async () => {
  const host = new URL(baseUrl).host;
  const res = await fetch(`${baseUrl}/api/rotation/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Sec-Fetch-Site': 'same-origin', Origin: `http://${host}` },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(rotationEnabled(), '1');
});

test('behind a proxy that rewrites Host, the forwarded host is accepted as the origin', async () => {
  const res = await fetch(`${baseUrl}/api/rotation/toggle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://umbrel.local:8790',
      'X-Forwarded-Host': 'umbrel.local:8790',
    },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(res.status, 200);
  assert.equal(rotationEnabled(), '0');
});

test('a DELETE from the dashboard, which carries no body, still works', async () => {
  db.instance
    .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES ('X', 'x.example', 1, 1, 0, 0)`)
    .run();
  const id = db.instance.prepare(`SELECT id FROM stratum_pool WHERE host = 'x.example'`).get().id;
  const res = await fetch(`${baseUrl}/api/pools/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(res.status, 200);
});

test('reads stay open: a GET needs no header at all', async () => {
  const res = await fetch(`${baseUrl}/api/rotation`);
  assert.equal(res.status, 200);
});
