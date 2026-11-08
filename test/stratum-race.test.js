'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-race-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const race = require('../src/stratum-race');
const toggle = require('../src/lib/stratum-race-toggle');

const hr = () => process.hrtime.bigint();
const prevhash = (n) => String(n).padStart(64, '0');

function fakePool(id, label) {
  return { id, label, host: 'pool.example', port: 3333 };
}

function watchPools(...pools) {
  race.active.clear();
  for (const pool of pools) race.active.set(pool.id, { conn: { stop() {} }, pool });
}

function observationsFor(hash) {
  return db.instance
    .prepare(
      `SELECT o.pool_id AS poolId, o.latency_ms AS latencyMs, o.rank
       FROM stratum_observation o JOIN stratum_race r ON r.id = o.race_id
       WHERE r.prevhash = ? ORDER BY o.pool_id`,
    )
    .all(hash);
}

test.before(() => {
  db.open();
});

test.beforeEach(async () => {
  // The race is a switch now and an absent flag means off, so every test that
  // exercises the worker has to turn it on first - exactly like a real install
  // does once, from the dashboard.
  toggle.setEnabled(true);
  race.setVerifier(async () => true);
  await race.finalizeAllRaces();
  race.openRaces.clear();
  db.instance.prepare('DELETE FROM stratum_observation').run();
  db.instance.prepare('DELETE FROM stratum_race').run();
});

test('the first pool to report a prevhash defines 0ms and rank 1', async () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  const t0 = hr();
  race.handleNotify(a, prevhash(1), t0);
  race.handleNotify(b, prevhash(1), t0 + 2_000_000n); // +2ms
  await race.finalizeRace(prevhash(1));

  const rows = observationsFor(prevhash(1));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].latencyMs, 0);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].latencyMs, 2);
  assert.equal(rows[1].rank, 2);
});

// The race's zero is laid next to the moment Core announced the block, so it
// has to be the moment the first job ARRIVED. It used to be stamped once the
// line had been parsed and handed over - a step later - which made the stretch
// from Core to the owner's pool look longer than it was.
test('the race starts at the arrival of the first job, not when it was processed', async () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  const arrivedAt = Date.now() - 5_000; // well before this line runs
  race.handleNotify(a, prevhash(9), hr(), arrivedAt);
  race.handleNotify(b, prevhash(9), hr(), arrivedAt + 40);
  await race.finalizeRace(prevhash(9));

  const row = db.instance.prepare('SELECT created_at AS createdAt FROM stratum_race WHERE prevhash = ?').get(prevhash(9));
  assert.equal(row.createdAt, arrivedAt);
});

test('a pool that never reports is scored as a miss when the race is finalized', async () => {
  const [a, b, c] = [fakePool(1, 'A'), fakePool(2, 'B'), fakePool(3, 'C')];
  watchPools(a, b, c);

  race.handleNotify(a, prevhash(2), hr());
  await race.finalizeRace(prevhash(2));

  const rows = observationsFor(prevhash(2));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].latencyMs, 0);
  assert.equal(rows[1].latencyMs, null, 'B never reported');
  assert.equal(rows[2].latencyMs, null, 'C never reported');
});

test('REGRESSION: a lagging pool re-sending the previous prevhash must not end the live race', async () => {
  // v1.11.1 called finalizeCurrentRace() before checking whether the incoming
  // prevhash was stale, so a pool that was one block behind closed the race
  // for the block everyone else was still reporting - and every pool that had
  // not yet reported was written down as a miss. That did not merely add
  // noise: it inflated Win % for the quickest pool and Miss for all others,
  // biasing the exact two figures the feature produces.
  const [a, b, c] = [fakePool(1, 'A'), fakePool(2, 'B'), fakePool(3, 'C')];
  watchPools(a, b, c);

  const OLD = prevhash(10);
  const NEW = prevhash(11);

  // A completed race for the previous block.
  race.handleNotify(a, OLD, hr());
  race.handleNotify(b, OLD, hr());
  race.handleNotify(c, OLD, hr());
  await race.finalizeRace(OLD);

  // New block: A is first.
  race.handleNotify(a, NEW, hr());
  assert.equal(race.openRaces.size, 1);

  // B is still broadcasting jobs for the OLD block.
  race.handleNotify(b, OLD, hr());
  assert.equal(race.openRaces.size, 1, 'the live race must still be open');

  // B and C then report the new block normally.
  race.handleNotify(b, NEW, hr());
  race.handleNotify(c, NEW, hr());
  await race.finalizeRace(NEW);

  const rows = observationsFor(NEW);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.notEqual(row.latencyMs, null, `pool ${row.poolId} must not be scored as a miss`);
  }
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);

  // ...and the stale notify must not have altered the finished race either.
  assert.equal(observationsFor(OLD).filter((r) => r.latencyMs === null).length, 0);
});

test('two genuinely different prevhashes can be in flight at once', async () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  race.handleNotify(a, prevhash(20), hr());
  race.handleNotify(b, prevhash(21), hr());
  assert.equal(race.openRaces.size, 2);

  await race.finalizeAllRaces();
  assert.equal(race.openRaces.size, 0);
  assert.equal(observationsFor(prevhash(20)).length, 2);
  assert.equal(observationsFor(prevhash(21)).length, 2);
});

test('only a pool first report counts, repeats are ignored', async () => {
  const a = fakePool(1, 'A');
  watchPools(a);

  const t0 = hr();
  race.handleNotify(a, prevhash(30), t0);
  race.handleNotify(a, prevhash(30), t0 + 5_000_000n); // job refresh, same prevhash
  await race.finalizeRace(prevhash(30));

  const rows = observationsFor(prevhash(30));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].latencyMs, 0, 'the later refresh must not overwrite the first timing');
});

test('a report for an already-closed race stays a miss', async () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  const t0 = hr();
  race.handleNotify(a, prevhash(40), t0);
  await race.finalizeRace(prevhash(40)); // B is recorded as a miss here

  // B's notify arrives after the race closed. rememberPrevhash() has already
  // marked this prevhash as seen, so handleNotify takes the stale-prevhash
  // early return (added for the lagging-pool regression below) and never
  // reaches the upsert at all. The miss therefore stands - which is right: a
  // report that arrives after the race is over cannot be timed against it.
  //
  // The test used to be named "a late report still corrects its own miss row"
  // while asserting the opposite, which left a reader believing corrections
  // happen. They do not, and the DO UPDATE branch in the upsert is
  // consequently unreachable from this path - see db.js's note on it.
  race.handleNotify(b, prevhash(40), t0 + 9_000_000n);

  const rows = observationsFor(prevhash(40));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].latencyMs, null, 'a report for an already-closed race is not timeable and stays a miss');
});

test('REGRESSION: an invalid pool port disables that pool instead of crashing the service', async () => {
  // net.connect() throws ERR_SOCKET_BAD_PORT synchronously, and
  // syncConnections() runs on a timer - so before v1.12.0 one malformed row
  // killed this process on every tick, including immediately after every
  // restart, which no restart policy could recover from.
  db.instance.prepare('UPDATE stratum_pool SET enabled = 0').run();
  race.active.clear();
  db.instance
    .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 0, ?)`)
    .run('Typo Pool', 'pool.example', 333333, Date.now());

  assert.doesNotThrow(() => race.syncConnections());
  assert.equal(race.active.size, 0, 'no connection is attempted for an invalid pool');

  const row = db.instance.prepare(`SELECT enabled FROM stratum_pool WHERE label = 'Typo Pool'`).get();
  assert.equal(row.enabled, 0, 'the bad pool is disabled so it cannot be retried on every tick');

  db.instance.prepare(`DELETE FROM stratum_pool WHERE label = 'Typo Pool'`).run();
});

test('switched off, the worker drops every connection and starts none', async () => {
  // Fake connection objects, never real sockets: syncConnections() with the
  // switch ON would dial, and a unit test must not open a TCP connection to
  // anything.
  watchPools(fakePool(1, 'A'), fakePool(2, 'B'));
  toggle.setEnabled(false);

  race.syncConnections();
  assert.equal(race.active.size, 0, 'switched off it drops every connection');

  db.instance
    .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 0, ?)`)
    .run('Late Pool', 'pool.example', 3333, Date.now());
  race.syncConnections();
  assert.equal(race.active.size, 0, 'a pool added while it is off is not connected either');

  db.instance.prepare(`DELETE FROM stratum_pool WHERE label = 'Late Pool'`).run();
});

test('switching off abandons an open race instead of charging everyone a miss', async () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  const t0 = hr();
  race.handleNotify(a, prevhash(70), t0);
  assert.equal(race.openRaces.size, 1);

  race.shutDownRace();

  assert.equal(race.openRaces.size, 0, 'the open race is gone');
  const rows = observationsFor(prevhash(70));
  assert.equal(rows.length, 1, 'only the pool that really reported has a row');
  assert.ok(rows[0].latencyMs != null, 'and it is a real result, not a miss charged to the other pool');
});

test('shutting the process down abandons an open race instead of charging everyone a miss', async () => {
  // The separate path from the one above: not the user switching the feature
  // off, but SIGTERM - a container restart or an app update. It used to run
  // finalizeAllRaces(), so a restart inside the race window charged a miss to
  // every pool that had not answered yet, which is a fact about the restart
  // and not about the pool.
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  race.handleNotify(a, prevhash(71), hr());
  assert.equal(race.openRaces.size, 1);

  race.handleProcessShutdown();

  assert.equal(race.openRaces.size, 0, 'the open race is gone');
  const rows = observationsFor(prevhash(71));
  assert.equal(rows.length, 1, 'only the pool that really reported has a row');
  assert.ok(rows[0].latencyMs != null, 'and B is not charged a miss for a restart it had no part in');
});

test('a race that really timed out still charges a miss', async () => {
  // The other half of the same rule, so the fix above cannot quietly become
  // "never record a miss again". A pool that had its eight seconds and said
  // nothing is a fact about the pool, and that one counts.
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  race.handleNotify(a, prevhash(72), hr());
  await race.finalizeRace(prevhash(72));

  const rows = observationsFor(prevhash(72));
  assert.equal(rows.length, 2, 'both pools have a row');
  assert.equal(rows.find((r) => r.poolId === 2).latencyMs, null, 'and the silent one is a miss');
});

test('applyToggle acts only when the switch has actually moved', async () => {
  // Every pool disabled, so switching on has nothing to dial.
  db.instance.prepare('UPDATE stratum_pool SET enabled = 0').run();

  toggle.setEnabled(false);
  race.applyToggle();
  assert.equal(race.active.size, 0);

  toggle.setEnabled(true);
  race.applyToggle();

  // Stand in for connections the worker is holding. If an unchanged switch
  // re-ran the sync, these would be dropped - which in production means every
  // pool's socket torn down and rebuilt every thirty seconds.
  watchPools(fakePool(1, 'A'));
  race.applyToggle();
  assert.equal(race.active.size, 1, 'an unchanged switch is left alone');
});

// --- the job a pool sends the moment you connect ----------------------------
//
// A pool broadcasts whatever job it is currently on as soon as a subscriber
// authorizes. That notify answers "what is current?", not "what just
// happened?", and its arrival is timed from our own TCP handshake. Racing it
// measured connect order and presented the result as which pool heard about a
// block first - and charged a miss to any pool whose handshake took longer
// than the race timeout.

test('the first job after connect opens no race - it is the job the pool was already on', async () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  // Cold start: both pools hand over the current job within milliseconds of
  // their handshakes, in whatever order those completed.
  race.handleNotify(a, prevhash(80), hr(), Date.now(), true);
  race.handleNotify(b, prevhash(80), hr(), Date.now(), true);

  assert.equal(race.openRaces.size, 0, 'nothing was announced, so nothing is raced');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_race').get().n, 0, 'and no race row is opened');
  assert.equal(observationsFor(prevhash(80)).length, 0, 'nobody is timed and nobody is charged a miss');

  // The hash is remembered all the same: it is old news, and a third pool
  // connecting later must not be able to open a race for it either.
  race.handleNotify(fakePool(3, 'C'), prevhash(80), hr());
  assert.equal(race.openRaces.size, 0, 'a prevhash seen on connect is already spent');
});

test('the first real block after a cold start is raced normally', async () => {
  // The other half of the rule, so it cannot quietly become "never race
  // anything". Once the connections are up, a job is news and is timed.
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  race.handleNotify(a, prevhash(81), hr(), Date.now(), true);
  race.handleNotify(b, prevhash(81), hr(), Date.now(), true);

  const t0 = hr();
  race.handleNotify(a, prevhash(82), t0);
  race.handleNotify(b, prevhash(82), t0 + 3_000_000n); // +3ms
  await race.finalizeRace(prevhash(82));

  const rows = observationsFor(prevhash(82));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.latencyMs), [0, 3]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
});

test('a pool that finishes connecting mid-race is neither timed nor charged a miss', async () => {
  // It plainly has the job - it just cannot be timed on it, because what its
  // arrival measures is our socket. A miss would blame the pool for that.
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  const t0 = hr();
  race.handleNotify(a, prevhash(83), t0);
  race.handleNotify(b, prevhash(83), t0 + 40_000_000n, Date.now(), true);
  await race.finalizeRace(prevhash(83));

  const rows = observationsFor(prevhash(83));
  assert.equal(rows.length, 1, 'only the pool that could be timed has a row');
  assert.equal(rows[0].poolId, 1);
  assert.equal(rows[0].latencyMs, 0);
});

test('a flood of made-up prevhashes cannot open unlimited races', async () => {
  // The client only lets a well-formed 64-hex prevhash through, so this is the
  // second guard, for hashes that are shaped right and still invented. Without
  // it each one is a stratum_race row, an open race and a timer.
  const a = fakePool(1, 'A');
  watchPools(a);

  for (let i = 0; i < 40; i += 1) {
    race.handleNotify(a, prevhash(1000 + i), hr());
  }

  assert.equal(race.openRaces.size, 10, 'the cap holds');
  await race.finalizeAllRaces();
  const opened = db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_race').get().n;
  assert.equal(opened, 10, 'and nothing past it reached the database');
});

// An outside review held another connection's write lock for one second while
// two pools sent their jobs 21 ms apart, and the race stored 1,033 ms: the
// write inside the first pool's handler stood the event loop still, and the
// second pool's data event was stamped when it came back. Nothing may touch
// the database while a race is open.
test('an open race writes nothing, so a locked database cannot delay a timestamp', async () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);
  const Database = require('better-sqlite3');
  const other = new Database(process.env.SQLITE_PATH);
  other.prepare('BEGIN IMMEDIATE').run();
  const before = db.instance.pragma('busy_timeout', { simple: true });
  db.instance.pragma('busy_timeout = 1000');
  try {
    const t0 = hr();
    const start = Date.now();
    race.handleNotify(a, prevhash(77), t0);
    race.handleNotify(b, prevhash(77), t0 + 21_000_000n);
    assert.ok(Date.now() - start < 200, 'neither notify waited for the lock');
  } finally {
    other.prepare('COMMIT').run();
    other.close();
    db.instance.pragma(`busy_timeout = ${before}`);
  }
  await race.finalizeRace(prevhash(77));
  const rows = observationsFor(prevhash(77));
  assert.deepEqual(rows.map((r) => r.latencyMs), [0, 21]);
});

// Switching the race off mid-race charges nobody a miss, but what really did
// report is kept - it was measured on a connection that was listening.
test('an abandoned race keeps its reports and records no misses', async () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);
  race.handleNotify(a, prevhash(78), hr());
  race.abandonOpenRaces();
  const rows = observationsFor(prevhash(78));
  assert.deepEqual(rows.map((r) => [r.poolId, r.latencyMs]), [[1, 0]]);
});

test('the same prevhash in another spelling joins the race instead of opening a second one', async () => {
  const [a, b, c] = [fakePool(1, 'A'), fakePool(2, 'B'), fakePool(3, 'C')];
  watchPools(a, b, c);
  const hash = 'ab'.repeat(4) + '12345678' + '0'.repeat(48);
  const { encodings } = require('../src/lib/prevhash');
  const otherOrder = encodings(hash).find((e) => e !== hash);

  const t0 = hr();
  race.handleNotify(a, hash, t0);
  race.handleNotify(b, hash.toUpperCase(), t0 + 1_000_000n);
  race.handleNotify(c, otherOrder, t0 + 3_000_000n);
  await race.finalizeAllRaces();

  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_race').get().n, 1, 'one block, one race');
  const rows = db.instance
    .prepare('SELECT pool_id AS poolId, latency_ms AS latencyMs, rank FROM stratum_observation ORDER BY pool_id')
    .all();
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.latencyMs), [0, 1, 3]);
});

// Found by an outside review: one pool sending a made-up hash that is shaped
// right came first in its own race, and every other pool was charged a miss.
test('a race for a block Core does not know is not recorded, and nobody is charged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);
  let asked = 0;
  race.setVerifier(async () => { asked += 1; return false; });

  race.handleNotify(a, prevhash(91), hr());
  await race.finalizeRace(prevhash(91));
  for (const ms of race.VERIFY_RETRY_MS) {
    t.mock.timers.tick(ms);
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(asked, 1 + race.VERIFY_RETRY_MS.length, 'asked again before giving up');
  assert.deepEqual(observationsFor(prevhash(91)), []);
});

test('a block Core learns of a little later is recorded on the next try', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);
  let known = false;
  race.setVerifier(async () => known);

  race.handleNotify(a, prevhash(92), hr());
  await race.finalizeRace(prevhash(92));
  assert.deepEqual(observationsFor(prevhash(92)), [], 'not yet');
  known = true;
  t.mock.timers.tick(race.VERIFY_RETRY_MS[0]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(observationsFor(prevhash(92)).map((r) => [r.poolId, r.latencyMs]), [[1, 0], [2, null]]);
});

// From a release review: a race checked again is written minutes later, and
// the misses went to whoever was enabled by then.
test('a pool added while a race waits for Core is not charged for it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [a, b, c] = [fakePool(1, 'A'), fakePool(2, 'B'), fakePool(3, 'C')];
  watchPools(a, b);
  let known = false;
  race.setVerifier(async () => known);

  race.handleNotify(a, prevhash(95), hr());
  await race.finalizeRace(prevhash(95));
  race.active.set(c.id, { conn: { stop() {} }, pool: c });
  known = true;
  t.mock.timers.tick(race.VERIFY_RETRY_MS[0]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(observationsFor(prevhash(95)).map((r) => [r.poolId, r.latencyMs]), [[1, 0], [2, null]]);
});

test('a race waiting for Core is written without misses when the worker stops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);
  race.setVerifier(async () => false);

  race.handleNotify(a, prevhash(96), hr());
  await race.finalizeRace(prevhash(96));
  assert.equal(race.pendingRaces.size, 1);
  race.abandonOpenRaces();
  assert.equal(race.pendingRaces.size, 0);
  assert.deepEqual(observationsFor(prevhash(96)).map((r) => [r.poolId, r.latencyMs]), [[1, 0]]);
});

test('when Core cannot be asked at all, the race is recorded unchecked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = fakePool(1, 'A');
  watchPools(a);
  race.setVerifier(async () => null);

  race.handleNotify(a, prevhash(93), hr());
  await race.finalizeRace(prevhash(93));
  for (const ms of race.VERIFY_RETRY_MS) {
    t.mock.timers.tick(ms);
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(observationsFor(prevhash(93)).length, 1);
});

test('blockKnown tries every spelling and tells "no such block" from "Core did not answer"', async (t) => {
  const rpc = require('../src/lib/rpc');
  const real = '00000000000000000001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7';
  t.mock.method(rpc, 'getBlockHeader', async (h) => {
    if (h === real) return { hash: real };
    throw new Error('RPC getblockheader failed: Block not found (code -5)');
  });
  const { encodings } = require('../src/lib/prevhash');
  assert.equal(await race.blockKnown(encodings(real)[3]), true);
  assert.equal(await race.blockKnown(prevhash(94)), false);
  rpc.getBlockHeader.mock.mockImplementation(async () => { throw new Error('RPC getblockheader: timed out after 10000ms'); });
  assert.equal(await race.blockKnown(prevhash(94)), null);
});
