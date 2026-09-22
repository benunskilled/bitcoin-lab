'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-route-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

// A stand-in for Core's RPC, started before rpc.js reads the config.
let reply = () => ({ status: 200, body: '{"result":{},"error":null,"id":1}' });
const core = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const { status, body } = reply();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
});

const db = require('../src/lib/db');
const blocks = require('../src/lib/queries/blocks');
const relay = require('../src/relay-profiler');
const prevhash = require('../src/lib/prevhash');

let rpc;
test.before(async () => {
  await new Promise((r) => core.listen(0, '127.0.0.1', r));
  process.env.BITCOIN_RPC_HOST = '127.0.0.1';
  process.env.BITCOIN_RPC_PORT = String(core.address().port);
  delete require.cache[require.resolve('../src/lib/config')];
  delete require.cache[require.resolve('../src/lib/rpc')];
  rpc = require('../src/lib/rpc');
  db.open();
});
test.after(() => { rpc.agent.destroy(); core.close(); });

test.beforeEach(() => {
  for (const t of ['stratum_observation', 'stratum_race', 'stratum_pool', 'relay_observation', 'relay_race']) {
    db.instance.prepare(`DELETE FROM ${t}`).run();
  }
});

// ---- the delivering peer's ping -------------------------------------------

test('the ping is the lowest one Core measured to a credited peer', () => {
  const at = 1_700_000_000_000;
  const peers = [
    { addr: '1.1.1.1:8333', last_block: at / 1000, minping: 0.040, pingtime: 0.090 },
    { addr: '2.2.2.2:8333', last_block: at / 1000, minping: 0.025, pingtime: 0.030 },
    { addr: '3.3.3.3:8333', last_block: at / 1000 - 600, minping: 0.001 }, // not credited
  ];
  assert.equal(relay.firstPeerPingMs(peers, at), 25);
});

test('no credited peer, no ping - rather than someone else\'s', () => {
  const at = 1_700_000_000_000;
  assert.equal(relay.firstPeerPingMs([{ addr: 'x:1', last_block: at / 1000 - 600, minping: 0.01 }], at), null);
});

test('recording a block keeps the delivering peer\'s ping with it', () => {
  const at = 1_700_000_000_000;
  const id = relay.recordRace({
    blockHash: 'ab'.repeat(32),
    detectedAtMs: at,
    peers: [{ addr: '1.1.1.1:8333', last_block: at / 1000, minping: 0.098 }],
  });
  const row = db.instance.prepare('SELECT first_ping_ms AS p FROM relay_race WHERE id = ?').get(id);
  assert.equal(row.p, 98);
});

// ---- timing a reply without keeping it ------------------------------------

test('a large reply is timed to its last byte and not kept', async () => {
  const big = '{"result":{"transactions":["' + 'a'.repeat(3_000_000) + '"]},"error":null,"id":1}';
  reply = () => ({ status: 200, body: big });
  const got = await rpc.timeCall('getblocktemplate', [{ rules: ['segwit'] }]);
  assert.equal(got.bytes, Buffer.byteLength(big));
  assert.ok(got.ms >= 0);
  assert.equal(Object.keys(got).sort().join(','), 'bytes,ms');
});

// An error is a short reply, and it must not pass for a very fast template.
test('an RPC error is an error, not a fast answer', async () => {
  reply = () => ({ status: 500, body: '{"result":null,"error":{"code":-10,"message":"Bitcoin is downloading blocks..."},"id":1}' });
  await assert.rejects(rpc.timeCall('getblocktemplate', []), /downloading blocks/);
});

// ---- the typical block ----------------------------------------------------

let n = 0;
function seedBlock({ core, ping, template, own }) {
  n += 1;
  const hash = n.toString(16).padStart(64, '0');
  const created = 1_700_000_000_000 + n * 600_000;
  db.instance
    .prepare(`INSERT INTO relay_race (block_hash, detected_at, template_ms, first_ping_ms) VALUES (?, ?, ?, ?)`)
    .run(hash, created + core, template, ping);
  const pools = db.instance.prepare('SELECT id, is_default FROM stratum_pool').all();
  const race = db.instance
    .prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)')
    .run(prevhash.encodings(hash)[3], created); // word order reversed, as seen on a real node
  for (const p of pools) {
    db.instance
      .prepare('INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, ?, ?)')
      .run(race.lastInsertRowid, p.id, p.is_default ? 0 : own, p.is_default ? 1 : 2);
  }
}

test('the typical route is the median of every stop, each counted from its own first job', () => {
  db.instance.prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES ('Public', 'a', 1, 1, 1, 0)`).run();
  db.instance.prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES ('GoBrrr', 'b', 1, 1, 0, 0)`).run();
  seedBlock({ core: 100, ping: 40, template: 80, own: 300 });
  seedBlock({ core: 200, ping: 60, template: 90, own: 400 });
  seedBlock({ core: 300, ping: 80, template: 70, own: 500 });

  const m = blocks.routeMedian();
  assert.equal(m.blocks, 3);
  assert.deepEqual(m.core, { ms: 200, n: 3 });
  assert.deepEqual(m.peer, { ms: 140, n: 3 });     // 60, 140, 220
  assert.deepEqual(m.template, { ms: 290, n: 3 }); // 180, 290, 370
  assert.deepEqual(m.own, { ms: 400, n: 3 });
  assert.equal(m.ownLabel, 'GoBrrr');
});

// Blocks from before template timing still count for the stops they have.
test('an older block without template timing still counts for its other stops', () => {
  db.instance.prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES ('Public', 'a', 1, 1, 1, 0)`).run();
  db.instance.prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES ('GoBrrr', 'b', 1, 1, 0, 0)`).run();
  seedBlock({ core: 100, ping: null, template: null, own: 300 });
  seedBlock({ core: 200, ping: 50, template: 90, own: 400 });

  const m = blocks.routeMedian();
  assert.equal(m.core.n, 2);
  assert.equal(m.template.n, 1);
  assert.equal(m.peer.n, 1);
});

test('no race recorded at all, no typical route', () => {
  db.instance.prepare(`INSERT INTO relay_race (block_hash, detected_at) VALUES (?, ?)`).run('cd'.repeat(32), 1);
  assert.equal(blocks.routeMedian(), null);
});

// ---- who has ever delivered ------------------------------------------------

test('the addresses that ever delivered first, and only those', () => {
  const at = 1_700_000_000_000;
  relay.recordRace({
    blockHash: 'e1'.repeat(32), detectedAtMs: at,
    peers: [
      { addr: '1.1.1.1:8333', last_block: at / 1000, minping: 0.02 },
      { addr: '2.2.2.2:8333', last_block: at / 1000 - 900, minping: 0.02 },
    ],
  });
  relay.recordRace({
    blockHash: 'e2'.repeat(32), detectedAtMs: at + 600_000,
    peers: [
      { addr: '2.2.2.2:8333', last_block: (at + 600_000) / 1000, minping: 0.02 },
      { addr: '3.3.3.3:8333', last_block: at / 1000, minping: 0.02 },
    ],
  });
  assert.deepEqual(blocks.deliveredEver(), ['1.1.1.1:8333', '2.2.2.2:8333']);
});
