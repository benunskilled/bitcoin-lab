'use strict';

// The maximum age of an /api/events stream.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-sse-age-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
// No neighbour in a test: 'off' skips the check entirely, so /api/status does
// not spend a DNS lookup on a container name that only exists on Umbrel.
process.env.PEERMAP_HEALTH_URL = 'off';
// Streams end after 1.5s here instead of ten minutes. A file of its own, so
// the other stream tests (the cap fills 32 slots) are not raced by it.
process.env.SSE_MAX_AGE_MS = '1500';

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

test('GET /api/events ends a stream after its maximum age, so a slot a lost tab held is freed', async () => {
  // Behind Umbrel's proxy a closed tab can leave its stream open here; ending
  // it from this side is the only thing that gives the slot back.
  const started = Date.now();
  const ended = await new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/events`, (res) => {
      assert.equal(res.statusCode, 200);
      res.resume();
      res.on('end', () => resolve(Date.now() - started));
    });
    req.on('error', reject);
    setTimeout(() => {
      req.destroy();
      reject(new Error('stream was not ended by the server within 5s'));
    }, 5000).unref();
  });
  assert.ok(ended >= 1400, `ended after ${ended}ms, before its maximum age`);
});
