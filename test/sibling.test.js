'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const sibling = require('../src/lib/sibling');

test.beforeEach(() => sibling.reset());
test.after(() => { delete process.env.PEERMAP_HEALTH_URL; });

test('a neighbour that answers 200 counts as installed, and is asked once', async () => {
  let calls = 0;
  const srv = http.createServer((req, res) => { calls += 1; res.writeHead(200); res.end('ok\n'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERMAP_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;

  assert.equal(await sibling.isInstalled(), true);
  // The dashboard polls every twenty seconds; an app is not installed twice a
  // minute, so the answer is kept.
  assert.equal(await sibling.isInstalled(), true);
  assert.equal(calls, 1, 'the second call must come from the cache');

  await new Promise((r) => srv.close(r));
});

test('a neighbour that is not there is silent, not an error', async () => {
  // Port 1 on loopback: nothing listens, the connection is refused at once.
  process.env.PEERMAP_HEALTH_URL = 'http://127.0.0.1:1/api/health';
  assert.equal(await sibling.isInstalled(), false);
});

test('a neighbour that answers something other than 200 does not count', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(503); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERMAP_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;

  assert.equal(await sibling.isInstalled(), false);
  await new Promise((r) => srv.close(r));
});

test('"off" switches the check off without asking anything', async () => {
  process.env.PEERMAP_HEALTH_URL = 'off';
  assert.equal(await sibling.isInstalled(), false);
});

test('two callers at once share one request', async () => {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls += 1;
    setTimeout(() => { res.writeHead(200); res.end('ok\n'); }, 30);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERMAP_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;

  const [a, b] = await Promise.all([sibling.isInstalled(), sibling.isInstalled()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(calls, 1, 'a second caller must join the request in flight');

  await new Promise((r) => srv.close(r));
});
