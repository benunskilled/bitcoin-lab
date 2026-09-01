'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-peer-profiler-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const { upsertSessions } = require('../src/peer-profiler');

test.before(() => {
  db.open();
});

test.afterEach(() => {
  db.instance.exec('DELETE FROM peer_session; DELETE FROM peer;');
});

const ADDRESS = '203.0.113.50:8333';

// One entry as Core's getpeerinfo reports it. `id` is Core's transient
// per-connection id and `conntime` its unix-second start - both change when a
// peer reconnects, which is what makes a reconnect detectable at all.
function corePeer({ id, conntimeSecondsAgo, connectionType = 'outbound-full-relay' }) {
  return {
    addr: ADDRESS,
    id,
    inbound: false,
    connection_type: connectionType,
    subver: '/Satoshi:28.1.0/',
    conntime: Math.floor((Date.now() - conntimeSecondsAgo * 1000) / 1000),
    minping: 0.02,
    pingtime: 0.03,
  };
}

function sessions() {
  return db.instance
    .prepare(
      `SELECT ps.id, ps.core_peer_id, ps.connection_type, ps.started_at, ps.ended_at
       FROM peer_session ps JOIN peer p ON p.id = ps.peer_id
       WHERE p.address = ? ORDER BY ps.id`,
    )
    .all(ADDRESS);
}

test('a peer that stays connected keeps exactly one open session', () => {
  upsertSessions([corePeer({ id: 42, conntimeSecondsAgo: 600 })]);
  const [first] = sessions();
  upsertSessions([corePeer({ id: 42, conntimeSecondsAgo: 630 })]);

  const rows = sessions();
  assert.equal(rows.length, 1, 'no second session for the same connection');
  assert.equal(rows[0].ended_at, null);
  assert.equal(rows[0].started_at, first.started_at, 'started_at must not drift on an update');
});

test('a peer that disappears from the snapshot has its session closed', () => {
  upsertSessions([corePeer({ id: 42, conntimeSecondsAgo: 600 })]);
  upsertSessions([]);

  const rows = sessions();
  assert.equal(rows.length, 1);
  assert.ok(rows[0].ended_at != null, 'the session must be closed');
});

test('REGRESSION: a reconnect between two polls starts a new session, it does not extend the old one', () => {
  // Core gives the new connection a new id and a new conntime. Matching on
  // address alone silently rewrote the original row instead: the session count
  // never moved, the downtime was counted as connected time, and the old
  // session was retroactively relabelled with the new connection type. This is
  // routine, not exotic - "Add as Manual" on a live peer deliberately
  // disconnects it so Core re-dials it as a manual connection, and every
  // rotation kick does the same, both well inside the 15s poll interval.
  upsertSessions([corePeer({ id: 42, conntimeSecondsAgo: 3600, connectionType: 'outbound-full-relay' })]);
  const [original] = sessions();

  upsertSessions([corePeer({ id: 77, conntimeSecondsAgo: 5, connectionType: 'manual' })]);

  const rows = sessions();
  assert.equal(rows.length, 2, 'the reconnect must open a second session');

  const [old, fresh] = rows;
  assert.equal(old.id, original.id);
  assert.ok(old.ended_at != null, 'the previous session must be closed');
  assert.equal(old.connection_type, 'outbound-full-relay', 'history must not be relabelled retroactively');
  assert.ok(
    old.ended_at <= fresh.started_at,
    'the old session must not overlap the new one - the gap belongs to neither',
  );

  assert.equal(fresh.ended_at, null);
  assert.equal(fresh.core_peer_id, 77);
  assert.equal(fresh.connection_type, 'manual');
});

test('a session row from before core_peer_id was recorded still reconnect-detects via conntime', () => {
  upsertSessions([corePeer({ id: 42, conntimeSecondsAgo: 3600 })]);
  db.instance.prepare('UPDATE peer_session SET core_peer_id = NULL').run();

  upsertSessions([corePeer({ id: 99, conntimeSecondsAgo: 2 })]);

  assert.equal(sessions().length, 2, 'a much newer conntime is a new session even without an id to compare');
});
