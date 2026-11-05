'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-gzip-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
process.env.PEERMAP_HEALTH_URL = 'off';

const db = require('../src/lib/db');
const { server } = require('../src/dashboard-server');

let port;

test.before(async () => {
  db.open();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(() => {
  server.close();
});

// fetch unpacks on its own, so this looks at the raw bytes.
function get(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('text answers are packed for a browser that takes gzip', async () => {
  for (const pathname of ['/', '/app.js', '/style.css']) {
    const res = await get(pathname, { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers['content-encoding'], 'gzip', pathname);
    assert.equal(Number(res.headers['content-length']), res.body.length, pathname);
    const plain = await get(pathname);
    assert.equal(plain.headers['content-encoding'], undefined, `${pathname} unpacked without gzip`);
    assert.deepEqual(zlib.gunzipSync(res.body), plain.body, `${pathname} unpacks to the same bytes`);
  }
});

test('a small answer stays plain: packing it would not pay', async () => {
  const res = await get('/api/peers/ranking', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.status, 200);
  assert.ok(res.body.length < 1024, 'an empty database gives a short ranking');
  assert.equal(res.headers['content-encoding'], undefined);
  assert.ok(Array.isArray(JSON.parse(res.body)));
});

test('the event stream is never packed', async () => {
  await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      assert.equal(res.headers['content-encoding'], undefined);
      res.destroy();
      resolve();
    }).on('error', reject);
  });
});
