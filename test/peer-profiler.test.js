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

// --- what a poll is allowed to write ----------------------------------------
//
// Every open session used to be rewritten on every 15s poll - around 200 rows
// on a well-connected node, near enough 100MB of WAL a day - almost all of it
// to persist a ping reading that had moved by a fraction of a millisecond.

const totalChanges = () => db.instance.prepare('SELECT total_changes() AS n').get().n;

function ping(peer, { min, last }) {
  return { ...peer, minping: min / 1000, pingtime: last / 1000 };
}

test('a poll that learns nothing writes nothing', () => {
  const peer = ping(corePeer({ id: 11, conntimeSecondsAgo: 300 }), { min: 20, last: 30 });
  upsertSessions([peer]);

  const before = totalChanges();
  upsertSessions([peer]);
  assert.equal(totalChanges(), before, 'an identical snapshot must not touch the row');

  // Nor does the ping wandering by the width of the measurement - a round trip
  // that reads 30ms and then 31ms is the same connection, and nothing in the
  // app renders last_ping_ms at all.
  upsertSessions([ping(peer, { min: 20, last: 31.4 })]);
  assert.equal(totalChanges(), before, 'jitter is not news');
});

test('a poll that learns something still writes it', () => {
  const peer = ping(corePeer({ id: 12, conntimeSecondsAgo: 300 }), { min: 20, last: 30 });
  upsertSessions([peer]);

  const stored = () => db.instance.prepare('SELECT min_ping_ms AS min, last_ping_ms AS last, connection_type AS type FROM peer_session').get();

  // A ping that really moved.
  let before = totalChanges();
  upsertSessions([ping(peer, { min: 20, last: 120 })]);
  assert.ok(totalChanges() > before, 'a real change in latency is recorded');
  assert.equal(stored().last, 120);

  // Anything that is not a number at all: Core relabelling the connection.
  before = totalChanges();
  upsertSessions([ping({ ...peer, connection_type: 'manual' }, { min: 20, last: 120 })]);
  assert.ok(totalChanges() > before);
  assert.equal(stored().type, 'manual');
});

test('the minimum ping is a minimum - no threshold and no poll may lose it', () => {
  const peer = ping(corePeer({ id: 13, conntimeSecondsAgo: 300 }), { min: 40, last: 40 });
  upsertSessions([peer]);
  const stored = () => db.instance.prepare('SELECT min_ping_ms AS min, last_ping_ms AS last FROM peer_session').get();

  // A new low by less than the last_ping threshold is still the whole point of
  // the column, so it is written even though nothing else moved.
  const before = totalChanges();
  upsertSessions([ping(peer, { min: 38, last: 40 })]);
  assert.ok(totalChanges() > before, 'a new minimum is always worth a write');
  assert.equal(stored().min, 38);

  // A later poll reporting a higher minimum cannot raise it back.
  upsertSessions([ping(peer, { min: 95, last: 95 })]);
  assert.equal(stored().min, 38, 'the lowest reading this session ever saw is the one that stands');

  // And a poll where Core reports no ping at all must not erase either value,
  // even though the connection_type change forces the row to be written.
  const noPing = { ...corePeer({ id: 13, conntimeSecondsAgo: 300, connectionType: 'manual' }) };
  delete noPing.minping;
  delete noPing.pingtime;
  upsertSessions([noPing]);
  assert.deepEqual(stored(), { min: 38, last: 95 }, 'a missing reading is not a reading of nothing');
});

// --- what a peer offers, and whether Core knows its chain -------------------
//
// Recorded so the question "can this peer deliver a block at all?" can be
// answered from data later. Nothing reads these yet, which is exactly why
// they need a test: a column nobody reads is a column nobody notices breaking.

function flags() {
  return db.instance
    .prepare(
      `SELECT ps.services, ps.relay_txes, ps.synced_headers
       FROM peer_session ps JOIN peer p ON p.id = ps.peer_id
       WHERE p.address = ? ORDER BY ps.id`,
    )
    .all(ADDRESS);
}

test('a session records the services, the relay flag and the header height', () => {
  upsertSessions([{
    ...corePeer({ id: 7, conntimeSecondsAgo: 60 }),
    servicesnames: ['NETWORK', 'WITNESS'],
    relaytxes: true,
    synced_headers: 967308,
  }]);

  assert.deepEqual(flags(), [{ services: 'NETWORK,WITNESS', relay_txes: 1, synced_headers: 967308 }]);
});

test('a peer that advertises nothing is recorded as nothing, not as unknown', () => {
  // The distinction is the whole point: '' is "it told us it offers nothing",
  // NULL is "Core did not say". Folding one into the other would lose the
  // only signal that separates a stripped-down connection from an old row.
  upsertSessions([{
    ...corePeer({ id: 8, conntimeSecondsAgo: 60 }),
    servicesnames: [],
    relaytxes: false,
    synced_headers: -1,
  }]);

  assert.deepEqual(flags(), [{ services: '', relay_txes: 0, synced_headers: -1 }]);
});

test('a poll without the fields keeps what an earlier poll recorded', () => {
  upsertSessions([{
    ...corePeer({ id: 9, conntimeSecondsAgo: 60 }),
    servicesnames: ['NETWORK'],
    relaytxes: true,
    synced_headers: 900000,
  }]);

  // Same connection, but Core reports none of the three this time.
  upsertSessions([corePeer({ id: 9, conntimeSecondsAgo: 90 })]);
  assert.deepEqual(flags(), [{ services: 'NETWORK', relay_txes: 1, synced_headers: 900000 }],
    'a missing field must not erase a recorded one');

  // And a value that IS reported overwrites, because the chain moves on.
  upsertSessions([{ ...corePeer({ id: 9, conntimeSecondsAgo: 120 }), synced_headers: 900010 }]);
  assert.equal(flags()[0].synced_headers, 900010);
});
