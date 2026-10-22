'use strict';

// Core's high-bandwidth compact-block peers (BIP152, getpeerinfo's
// bip152_hb_to, and bip152_hb_from for the other way round): the peer profiler
// keeps the place each session holds now, and the ranking reports it. No
// history of changes is kept.

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

function corePeer(addr, { id, hb, hbFrom, lastBlock } = {}) {
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
  if (hbFrom !== undefined) p.bip152_hb_from = hbFrom;
  if (lastBlock !== undefined) p.last_block = lastBlock;
  return p;
}


const sessionHbFrom = (addr) => db.instance
  .prepare(`SELECT ps.hb_from FROM peer_session ps JOIN peer p ON p.id = ps.peer_id WHERE p.address = ? AND ps.ended_at IS NULL`)
  .get(addr)?.hb_from;

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

test('an install from 1.26.0 gains the column and keeps its open sessions', () => {
  const d = db.instance;
  upsertSessions([corePeer(A, { id: 1 })]);
  // As 1.26.0 left it: no hb_to, and the migration not yet run.
  d.exec(`ALTER TABLE peer_session DROP COLUMN hb_to`);
  d.prepare(`DELETE FROM meta WHERE key = ?`).run('migration:bip152_hb_v2_0_0');

  db.runMigrations();

  const cols = d.prepare(`SELECT name FROM pragma_table_info('peer_session')`).all().map((r) => r.name);
  assert.ok(cols.includes('hb_to'));
  assert.equal(sessionHb(A), null, 'the open session survives, its place not known yet');
  upsertSessions([corePeer(A, { id: 1, hb: true })]);
  assert.equal(sessionHb(A), 1);
  assert.equal(Object.fromEntries(queries.peerRanking().map((r) => [r.address, r]))[A].hb, true);
});

// bip152_hb_from, the other way round: the peer has picked this node.
test('the place a peer gives this node is kept apart from the one it holds', () => {
  upsertSessions([corePeer(A, { id: 1, hb: true, hbFrom: false }), corePeer(B, { id: 2, hb: false, hbFrom: true })]);
  assert.equal(sessionHb(A), 1);
  assert.equal(sessionHbFrom(A), 0);
  assert.equal(sessionHb(B), 0);
  assert.equal(sessionHbFrom(B), 1);
  // Only the place now: a peer that drops this node is written as no longer.
  upsertSessions([corePeer(A, { id: 1, hb: true, hbFrom: true }), corePeer(B, { id: 2, hb: false, hbFrom: false })]);
  assert.equal(sessionHbFrom(A), 1);
  assert.equal(sessionHbFrom(B), 0);
  const rows = Object.fromEntries(queries.peerRanking().map((r) => [r.address, r]));
  assert.equal(rows[A].hbFrom, true);
  assert.equal(rows[B].hbFrom, false);
});

test('a Core that does not report hb_from leaves it unknown, and the ranking says no', () => {
  upsertSessions([corePeer(A, { id: 1 })]);
  assert.equal(sessionHbFrom(A), null);
  assert.equal(Object.fromEntries(queries.peerRanking().map((r) => [r.address, r]))[A].hbFrom, false);
});

test('an install from 2.0.3 gains hb_from and keeps its open sessions', () => {
  const d = db.instance;
  upsertSessions([corePeer(A, { id: 1, hb: true })]);
  d.exec(`ALTER TABLE peer_session DROP COLUMN hb_from`);
  d.prepare(`DELETE FROM meta WHERE key = ?`).run('migration:bip152_hb_from_v2_0_4');

  db.runMigrations();

  const cols = d.prepare(`SELECT name FROM pragma_table_info('peer_session')`).all().map((r) => r.name);
  assert.ok(cols.includes('hb_from'));
  assert.equal(sessionHb(A), 1, 'the open session keeps what it had');
  assert.equal(sessionHbFrom(A), null);
  upsertSessions([corePeer(A, { id: 1, hb: true, hbFrom: true })]);
  assert.equal(sessionHbFrom(A), 1);
});
