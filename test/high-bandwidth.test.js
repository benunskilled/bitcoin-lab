'use strict';

// Core's high-bandwidth compact-block peers (BIP152, getpeerinfo's
// bip152_hb_to): the peer profiler keeps the place each session holds now, and
// the ranking reports it. No history of changes is kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-hb-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const queries = require('../src/lib/queries');
const { upsertSessions } = require('../src/peer-profiler');
const relay = require('../src/relay-profiler');

test.before(() => {
  db.open();
});

test.afterEach(() => {
  db.instance.exec(`DELETE FROM relay_observation; DELETE FROM relay_race; DELETE FROM peer_relay_stats;
    DELETE FROM peer_session; DELETE FROM peer;`);
});

const A = '203.0.113.71:8333';
const B = '203.0.113.72:8333';

function corePeer(addr, { id, hb, lastBlock } = {}) {
  const p = {
    addr,
    id,
    inbound: false,
    connection_type: 'outbound-full-relay',
    subver: '/Satoshi:31.0.0/',
    conntime: Math.floor(Date.now() / 1000) - 600,
    minping: 0.02,
    pingtime: 0.03,
  };
  if (hb !== undefined) p.bip152_hb_to = hb;
  if (lastBlock !== undefined) p.last_block = lastBlock;
  return p;
}


const sessionHb = (addr) => db.instance
  .prepare(`SELECT ps.hb_to FROM peer_session ps JOIN peer p ON p.id = ps.peer_id WHERE p.address = ? AND ps.ended_at IS NULL`)
  .get(addr)?.hb_to;

test('the place is kept per session, as Core reports it now', () => {
  upsertSessions([corePeer(A, { id: 1, hb: true }), corePeer(B, { id: 2, hb: false })]);
  assert.equal(sessionHb(A), 1);
  assert.equal(sessionHb(B), 0);

  upsertSessions([corePeer(A, { id: 1, hb: false }), corePeer(B, { id: 2, hb: true })]);
  assert.equal(sessionHb(A), 0);
  assert.equal(sessionHb(B), 1);
});

test('no history of changes is kept', () => {
  const tables = db.instance.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name);
  assert.ok(!tables.includes('hb_change'));
  const cols = db.instance.prepare(`SELECT name FROM pragma_table_info('relay_observation')`).all().map((r) => r.name);
  assert.ok(!cols.includes('hb'));
});

test('a Core that does not report the field leaves it unknown, not "no"', () => {
  upsertSessions([corePeer(A, { id: 1 })]);
  assert.equal(sessionHb(A), null);
  upsertSessions([corePeer(A, { id: 1, hb: true })]);
  assert.equal(sessionHb(A), 1);
});

test('the ranking reports the place now', () => {
  upsertSessions([corePeer(A, { id: 1, hb: true }), corePeer(B, { id: 2, hb: false })]);
  const now = Date.now();
  relay.recordRace({
    blockHash: '00'.repeat(32),
    detectedAtMs: now,
    peers: [
      corePeer(A, { id: 1, hb: true, lastBlock: Math.floor(now / 1000) - 600 }),
      corePeer(B, { id: 2, hb: false, lastBlock: Math.floor(now / 1000) }),
    ],
  });
  const rows = Object.fromEntries(queries.peerRanking().map((r) => [r.address, r]));
  assert.equal(rows[A].hb, true);
  assert.equal(rows[B].hb, false);
  assert.equal(rows[B].first, 1);
});

test('an install from before this change loses the history and keeps the rest', () => {
  const d = db.instance;
  d.exec(`ALTER TABLE relay_observation ADD COLUMN hb INTEGER;
    CREATE INDEX idx_relay_obs_first_hb ON relay_observation(peer_id, hb) WHERE first = 1;
    CREATE TABLE hb_change (at INTEGER NOT NULL, address TEXT NOT NULL, hb INTEGER NOT NULL);`);
  upsertSessions([corePeer(A, { id: 1, hb: true })]);
  d.prepare(`INSERT INTO relay_race (block_hash, detected_at) VALUES ('ff', 1)`).run();
  const raceId = d.prepare(`SELECT id FROM relay_race`).get().id;
  const peerId = d.prepare(`SELECT id FROM peer WHERE address = ?`).get(A).id;
  d.prepare(`INSERT INTO relay_observation (race_id, peer_id, eligible, first, hb) VALUES (?, ?, 1, 1, 1)`).run(raceId, peerId);

  d.prepare(`DELETE FROM meta WHERE key = ?`).run('migration:drop_hb_history_v2_0_0');
  db.runMigrations();

  const cols = d.prepare(`SELECT name FROM pragma_table_info('relay_observation')`).all().map((r) => r.name);
  assert.ok(!cols.includes('hb'));
  assert.equal(d.prepare(`SELECT name FROM sqlite_master WHERE name = 'idx_relay_obs_first_hb'`).get(), undefined);
  assert.equal(d.prepare(`SELECT name FROM sqlite_master WHERE name = 'hb_change'`).get(), undefined);
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM relay_observation WHERE first = 1`).get().n, 1);
  assert.equal(sessionHb(A), 1, 'the place held now is kept');
});
