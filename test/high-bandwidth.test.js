'use strict';

// Core's high-bandwidth compact-block peers (BIP152, getpeerinfo's
// bip152_hb_to): the peer profiler keeps the current place per session and
// writes every change, the relay profiler stamps each observation with the
// place the peer held BEFORE the block, and the ranking reports both.

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
    DELETE FROM hb_change; DELETE FROM peer_session; DELETE FROM peer;`);
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


// As if the profiler's poll happened 20 seconds before the block: its change
// rows and its poll stamp are moved back, so neither guard applies.
function pollEarlier(ms = 20_000) {
  db.instance.prepare(`UPDATE hb_change SET at = at - ?`).run(ms);
  beat(Date.now() - ms);
}

// The peer profiler's heartbeat, carrying when it last polled Core.
function beat(lastPollAt) {
  db.instance
    .prepare(`INSERT INTO meta (key, value) VALUES ('heartbeat:peer-profiler', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify({ at: Date.now(), lastPollAt }));
}

const changes = () => db.instance.prepare(`SELECT address, hb FROM hb_change ORDER BY rowid`).all();
const sessionHb = (addr) => db.instance
  .prepare(`SELECT ps.hb_to FROM peer_session ps JOIN peer p ON p.id = ps.peer_id WHERE p.address = ? AND ps.ended_at IS NULL`)
  .get(addr)?.hb_to;

test('the place is kept per session and every change is written once', () => {
  upsertSessions([corePeer(A, { id: 1, hb: true }), corePeer(B, { id: 2, hb: false })]);
  assert.equal(sessionHb(A), 1);
  assert.equal(sessionHb(B), 0);
  assert.deepEqual(changes(), [{ address: A, hb: 1 }], 'only a held place is news on a new session');

  // Unchanged: nothing new is written.
  upsertSessions([corePeer(A, { id: 1, hb: true }), corePeer(B, { id: 2, hb: false })]);
  assert.equal(changes().length, 1);

  // B takes the place from A.
  upsertSessions([corePeer(A, { id: 1, hb: false }), corePeer(B, { id: 2, hb: true })]);
  assert.equal(sessionHb(A), 0);
  assert.equal(sessionHb(B), 1);
  assert.deepEqual(changes().slice(1), [{ address: A, hb: 0 }, { address: B, hb: 1 }]);
});

test('a peer that disconnects while holding a place loses it on record', () => {
  upsertSessions([corePeer(A, { id: 1, hb: true })]);
  upsertSessions([]);
  assert.deepEqual(changes(), [{ address: A, hb: 1 }, { address: A, hb: 0 }]);
});

test('a Core that does not report the field leaves it unknown, not "no"', () => {
  upsertSessions([corePeer(A, { id: 1 })]);
  assert.equal(sessionHb(A), null);
  assert.equal(changes().length, 0);
  // And a later poll that does report it fills it in.
  upsertSessions([corePeer(A, { id: 1, hb: true })]);
  assert.equal(sessionHb(A), 1);
});

test('a block is stamped with the place held before it, not after', () => {
  // As the peer profiler last saw it: A held a place, B did not.
  upsertSessions([corePeer(A, { id: 1, hb: true }), corePeer(B, { id: 2, hb: false })]);
  pollEarlier();
  const now = Date.now();
  // B delivered the block, and in the snapshot taken after it Core has already
  // promoted B. The stamp must still say B was NOT a high-bandwidth peer.
  relay.recordRace({
    blockHash: '00'.repeat(32),
    detectedAtMs: now,
    peers: [
      corePeer(A, { id: 1, hb: false, lastBlock: Math.floor(now / 1000) - 600 }),
      corePeer(B, { id: 2, hb: true, lastBlock: Math.floor(now / 1000) }),
    ],
  });
  const rows = db.instance
    .prepare(`SELECT p.address, o.first, o.hb FROM relay_observation o JOIN peer p ON p.id = o.peer_id ORDER BY p.address`)
    .all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { address: A, first: 0, hb: 1 },
    { address: B, first: 1, hb: 0 },
  ]);
});

test('a peer the profiler has not polled yet is stamped unknown', () => {
  upsertSessions([corePeer(A, { id: 1, hb: true })]);
  pollEarlier();
  const now = Date.now();
  relay.recordRace({
    blockHash: '01'.repeat(32),
    detectedAtMs: now,
    peers: [corePeer(A, { id: 1, hb: true }), corePeer(B, { id: 2, hb: true, lastBlock: Math.floor(now / 1000) })],
  });
  const hb = db.instance
    .prepare(`SELECT o.hb FROM relay_observation o JOIN peer p ON p.id = o.peer_id WHERE p.address = ?`)
    .get(B).hb;
  assert.equal(hb, null);
});

test('the ranking shows the place now and how many first deliveries came with it', () => {
  upsertSessions([corePeer(A, { id: 1, hb: true }), corePeer(B, { id: 2, hb: false })]);
  pollEarlier(90_000);
  const base = Date.now() - 60_000;
  // Two blocks from A while it held a place, one from B without.
  for (const [i, who] of [[0, A], [1, A], [2, B]]) {
    const at = base + i * 1000;
    relay.recordRace({
      blockHash: String(i).padStart(64, '0'),
      detectedAtMs: at,
      peers: [
        corePeer(A, { id: 1, hb: true, lastBlock: who === A ? Math.floor(at / 1000) : 1 }),
        corePeer(B, { id: 2, hb: false, lastBlock: who === B ? Math.floor(at / 1000) : 1 }),
      ],
    });
  }
  const rows = Object.fromEntries(queries.peerRanking().map((r) => [r.address, r]));
  assert.equal(rows[A].hb, true);
  assert.equal(rows[B].hb, false);
  assert.equal(rows[A].first, 2);
  assert.equal(rows[A].firstAsHb, 2);
  assert.equal(rows[A].firstHbKnown, 2);
  assert.equal(rows[B].firstAsHb, 0);
  assert.equal(rows[B].firstHbKnown, 1);
});

test('a place that changed right around the block is recorded as unknown', () => {
  // The profiler saw B gain its place a moment ago - possibly Core's reaction
  // to this very block. That must not be read as a head start.
  upsertSessions([corePeer(A, { id: 1, hb: true }), corePeer(B, { id: 2, hb: false })]);
  pollEarlier();
  upsertSessions([corePeer(A, { id: 1, hb: true }), corePeer(B, { id: 2, hb: true })]);
  const now = Date.now();
  relay.recordRace({
    blockHash: '02'.repeat(32),
    detectedAtMs: now,
    peers: [corePeer(A, { id: 1, hb: true }), corePeer(B, { id: 2, hb: true, lastBlock: Math.floor(now / 1000) })],
  });
  const hb = Object.fromEntries(db.instance
    .prepare(`SELECT p.address, o.hb FROM relay_observation o JOIN peer p ON p.id = o.peer_id`).all()
    .map((r) => [r.address, r.hb]));
  assert.equal(hb[A], 1, 'A held its place throughout');
  assert.equal(hb[B], null, 'B changed within the guard window');
});

test('when the profiler has not polled recently, every place is unknown', () => {
  upsertSessions([corePeer(A, { id: 1, hb: true })]);
  pollEarlier(5 * 60_000);
  const now = Date.now();
  relay.recordRace({
    blockHash: '03'.repeat(32),
    detectedAtMs: now,
    peers: [corePeer(A, { id: 1, hb: true, lastBlock: Math.floor(now / 1000) })],
  });
  const row = db.instance.prepare(`SELECT hb FROM relay_observation`).get();
  assert.equal(row.hb, null);
});

test('the first-delivery count with the place is read through the partial index', () => {
  const plan = db.instance
    .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM relay_observation o WHERE o.peer_id = ? AND o.first = 1 AND o.hb = 1`)
    .all(1)
    .map((r) => r.detail)
    .join(' | ');
  assert.match(plan, /idx_relay_obs_first_hb/);
});
