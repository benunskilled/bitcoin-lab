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

test.beforeEach(() => {
  race.finalizeAllRaces();
  race.openRaces.clear();
  db.instance.prepare('DELETE FROM stratum_observation').run();
  db.instance.prepare('DELETE FROM stratum_race').run();
});

test('the first pool to report a prevhash defines 0ms and rank 1', () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  const t0 = hr();
  race.handleNotify(a, prevhash(1), t0);
  race.handleNotify(b, prevhash(1), t0 + 2_000_000n); // +2ms
  race.finalizeRace(prevhash(1));

  const rows = observationsFor(prevhash(1));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].latencyMs, 0);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].latencyMs, 2);
  assert.equal(rows[1].rank, 2);
});

test('a pool that never reports is scored as a miss when the race is finalized', () => {
  const [a, b, c] = [fakePool(1, 'A'), fakePool(2, 'B'), fakePool(3, 'C')];
  watchPools(a, b, c);

  race.handleNotify(a, prevhash(2), hr());
  race.finalizeRace(prevhash(2));

  const rows = observationsFor(prevhash(2));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].latencyMs, 0);
  assert.equal(rows[1].latencyMs, null, 'B never reported');
  assert.equal(rows[2].latencyMs, null, 'C never reported');
});

test('REGRESSION: a lagging pool re-sending the previous prevhash must not end the live race', () => {
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
  race.finalizeRace(OLD);

  // New block: A is first.
  race.handleNotify(a, NEW, hr());
  assert.equal(race.openRaces.size, 1);

  // B is still broadcasting jobs for the OLD block.
  race.handleNotify(b, OLD, hr());
  assert.equal(race.openRaces.size, 1, 'the live race must still be open');

  // B and C then report the new block normally.
  race.handleNotify(b, NEW, hr());
  race.handleNotify(c, NEW, hr());
  race.finalizeRace(NEW);

  const rows = observationsFor(NEW);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.notEqual(row.latencyMs, null, `pool ${row.poolId} must not be scored as a miss`);
  }
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);

  // ...and the stale notify must not have altered the finished race either.
  assert.equal(observationsFor(OLD).filter((r) => r.latencyMs === null).length, 0);
});

test('two genuinely different prevhashes can be in flight at once', () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  race.handleNotify(a, prevhash(20), hr());
  race.handleNotify(b, prevhash(21), hr());
  assert.equal(race.openRaces.size, 2);

  race.finalizeAllRaces();
  assert.equal(race.openRaces.size, 0);
  assert.equal(observationsFor(prevhash(20)).length, 2);
  assert.equal(observationsFor(prevhash(21)).length, 2);
});

test('only a pool first report counts, repeats are ignored', () => {
  const a = fakePool(1, 'A');
  watchPools(a);

  const t0 = hr();
  race.handleNotify(a, prevhash(30), t0);
  race.handleNotify(a, prevhash(30), t0 + 5_000_000n); // job refresh, same prevhash
  race.finalizeRace(prevhash(30));

  const rows = observationsFor(prevhash(30));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].latencyMs, 0, 'the later refresh must not overwrite the first timing');
});

test('a late report still corrects its own miss row', () => {
  const [a, b] = [fakePool(1, 'A'), fakePool(2, 'B')];
  watchPools(a, b);

  const t0 = hr();
  race.handleNotify(a, prevhash(40), t0);
  race.finalizeRace(prevhash(40)); // B is recorded as a miss here

  // B's notify arrives after the race closed: it reopens nothing, but the
  // upsert must replace its own miss rather than being dropped.
  race.handleNotify(b, prevhash(40), t0 + 9_000_000n);

  const rows = observationsFor(prevhash(40));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].latencyMs, null, 'a report for an already-closed race is not timeable and stays a miss');
});

test('REGRESSION: an invalid pool port disables that pool instead of crashing the service', () => {
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
