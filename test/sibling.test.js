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

test('a miss is asked again after thirty seconds, a hit only after five minutes', async (t) => {
  // Updated together, Peer Map may still be starting when the dashboard asks.
  let up = false;
  let calls = 0;
  const srv = http.createServer((req, res) => { calls += 1; res.writeHead(up ? 200 : 503); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERMAP_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

  assert.equal(await sibling.isInstalled(), false);
  up = true;
  t.mock.timers.tick(20_000);
  assert.equal(await sibling.isInstalled(), false, 'within thirty seconds the miss is kept');
  t.mock.timers.tick(11_000);
  assert.equal(await sibling.isInstalled(), true, 'after thirty seconds it is asked again');
  t.mock.timers.tick(60_000);
  assert.equal(await sibling.isInstalled(), true);
  assert.equal(calls, 2, 'a hit is kept for five minutes');

  await new Promise((r) => srv.close(r));
});

test("Peer Map's marks are read without waiting, and only the two the ranking shows", async () => {
  let peerCalls = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.writeHead(200); return res.end('ok\n'); }
    peerCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ peers: [
      { addr: '198.51.100.1:8333', kind: 'Disguised', tell: 'no wtxidrelay' },
      { addr: '198.51.100.2:8333', kind: 'Pool node', pool: 'AtlasPool' },
      { addr: '198.51.100.3:8333', kind: 'Node (Core)' },
      { addr: '198.51.100.4:8333', kind: 'Wallet' },
    ] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERMAP_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;

  assert.equal(await sibling.isInstalled(), true);
  assert.equal(sibling.peerKinds().size, 0, 'the first call starts the fetch and does not wait for it');
  for (let i = 0; i < 50 && sibling.peerKinds().size === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  const marks = sibling.peerKinds();
  assert.deepEqual([...marks.keys()].sort(), ['198.51.100.1:8333', '198.51.100.2:8333']);
  assert.deepEqual(marks.get('198.51.100.1:8333'), { kind: 'Disguised', why: 'no wtxidrelay' });
  assert.deepEqual(marks.get('198.51.100.2:8333'), { kind: 'Pool node', pool: 'AtlasPool' });
  assert.equal(peerCalls, 1, 'within a minute Peer Map is asked once');

  await new Promise((r) => srv.close(r));
});

test('without Peer Map there are no marks, and its list is not asked for', async () => {
  let peerCalls = 0;
  const srv = http.createServer((req, res) => {
    if (req.url !== '/api/health') peerCalls += 1;
    res.writeHead(503); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.PEERMAP_HEALTH_URL = `http://127.0.0.1:${srv.address().port}/api/health`;

  assert.equal(await sibling.isInstalled(), false);
  assert.equal(sibling.peerKinds().size, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(peerCalls, 0);
  process.env.PEERMAP_HEALTH_URL = 'off';
  assert.equal(sibling.peerKinds().size, 0);

  await new Promise((r) => srv.close(r));
});
