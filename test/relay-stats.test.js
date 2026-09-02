'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-rollup-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const queries = require('../src/lib/queries');

test.before(() => {
  db.open();
});

function aggregateFromRawRows() {
  return db.instance
    .prepare(
      `SELECT peer_id AS peerId, COUNT(*) AS eligible, COALESCE(SUM(first), 0) AS first
       FROM relay_observation GROUP BY peer_id ORDER BY peer_id`,
    )
    .all();
}

function rollupRows() {
  return db.instance
    .prepare(`SELECT peer_id AS peerId, eligible, first FROM peer_relay_stats ORDER BY peer_id`)
    .all();
}

function assertRollupMatchesRawRows(context) {
  assert.deepEqual(rollupRows(), aggregateFromRawRows(), `rollup drifted from relay_observation: ${context}`);
}

test('the rollup tracks inserts into relay_observation exactly', () => {
  // peerRanking() reads peer_relay_stats instead of aggregating the (never
  // pruned, permanently growing) relay_observation table on every request. A
  // summary that can silently drift from its source is worse than no summary,
  // so it is maintained by triggers on the table itself - this asserts the
  // invariant rather than trusting any particular caller to remember.
  const a = db.getOrCreatePeer('198.51.100.1:8333');
  const b = db.getOrCreatePeer('198.51.100.2:8333');
  // peerRanking() reports the peers that are connected or manual, so the
  // fixture needs the open session any peer with relay history really has.
  const openSession = db.instance.prepare(
    'INSERT INTO peer_session (peer_id, direction, connection_type, started_at) VALUES (?, ?, ?, ?)',
  );
  openSession.run(a.id, 'outbound', 'outbound-full-relay', Date.now() - 3600000);
  openSession.run(b.id, 'outbound', 'outbound-full-relay', Date.now() - 3600000);
  const insertRace = db.instance.prepare('INSERT INTO relay_race (block_hash, detected_at) VALUES (?, ?)');
  const insertObs = db.instance.prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)');

  for (let i = 0; i < 12; i++) {
    const raceId = insertRace.run(`rollup-block-${i}`, Date.now()).lastInsertRowid;
    insertObs.run(raceId, a.id, i < 9 ? 1 : 0);
    insertObs.run(raceId, b.id, 0);
  }

  assertRollupMatchesRawRows('after inserts');
  const ranking = queries.peerRanking();
  const rowA = ranking.find((p) => p.address === '198.51.100.1:8333');
  assert.equal(rowA.eligible, 12);
  assert.equal(rowA.first, 9);
  assert.equal(rowA.firstPct, 75);
});

test('the rollup follows deletes and updates too', () => {
  const raceId = db.instance.prepare('SELECT id FROM relay_race ORDER BY id LIMIT 1').get().id;
  db.instance.prepare('UPDATE relay_observation SET first = 0 WHERE race_id = ?').run(raceId);
  assertRollupMatchesRawRows('after update');
  db.instance.prepare('DELETE FROM relay_observation WHERE race_id = ?').run(raceId);
  assertRollupMatchesRawRows('after delete');
});

test('rebuildRelayStats restores the invariant from the raw rows alone', () => {
  db.instance.prepare('UPDATE peer_relay_stats SET eligible = 999, first = 999').run();
  db.rebuildRelayStats();
  assertRollupMatchesRawRows('after rebuild');
});

test('the one-time migrations really do not run twice', () => {
  // This used to assert a hardcoded list of migration flag names, which is a
  // test of the list, not of the guard: with `if (done) return` removed from
  // migrate(), it stayed green. What hangs on that guard is not academic -
  // stratum_history_reset_v1_12_0 does DELETE FROM stratum_observation, so a
  // regression there would wipe the user's entire race history on every single
  // container restart, silently, with this test still passing.
  //
  // So: put data in the way of each destructive migration, re-run them, and
  // assert the data is still there.
  const poolId = db.instance
    .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at)
              VALUES ('Migration Guard', 'guard.example', 3333, 1, 0, ?)`)
    .run(Date.now()).lastInsertRowid;
  const raceId = db.instance
    .prepare(`INSERT INTO stratum_race (prevhash, created_at) VALUES ('migration-guard-race', ?)`)
    .run(Date.now()).lastInsertRowid;
  db.instance
    .prepare(`INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, 42, 1)`)
    .run(raceId, poolId);

  const flagsBefore = db.instance
    .prepare("SELECT key, value FROM meta WHERE key LIKE 'migration:%' ORDER BY key").all();
  assert.ok(flagsBefore.length > 0, 'migrations must record that they ran at all');

  db.runMigrations();

  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_race WHERE prevhash = ?').get('migration-guard-race').n,
    1,
    'a second migration pass must not clear the stratum history',
  );
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_observation WHERE race_id = ?').get(raceId).n,
    1,
  );
  assert.deepEqual(
    db.instance.prepare("SELECT key, value FROM meta WHERE key LIKE 'migration:%' ORDER BY key").all(),
    flagsBefore,
    'and must not re-stamp the flags either - the timestamps are the evidence it ran once',
  );

  // This file shares one database across its tests, and the percentile tests
  // below aggregate over every stratum row present. Leave the fixture as found.
  db.instance.prepare('DELETE FROM stratum_observation WHERE race_id = ?').run(raceId);
  db.instance.prepare('DELETE FROM stratum_race WHERE id = ?').run(raceId);
  db.instance.prepare('DELETE FROM stratum_pool WHERE id = ?').run(poolId);
});

test('median and P90 match the previous implementation on every range', () => {
  // The percentile computation moved out of JavaScript. It has to pick exactly
  // the same sample as before, so the previous implementation is the oracle.
  function previousPercentile(sortedAsc, p) {
    if (!sortedAsc.length) return null;
    return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length))];
  }

  const insertRace = db.instance.prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)');
  const insertObs = db.instance.prepare('INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, ?, ?)');
  const poolIds = db.instance.prepare('SELECT id FROM stratum_pool ORDER BY id').all().map((r) => r.id);
  const byPool = new Map(poolIds.map((id) => [id, []]));

  let seed = 7;
  const nextLatency = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.round((seed % 90000) / 100) / 10;
  };

  const raceIds = [];
  for (let r = 0; r < 40; r++) {
    const raceId = insertRace.run(`pct-${r}`, Date.now() - (40 - r) * 1000).lastInsertRowid;
    raceIds.push(raceId);
    poolIds.forEach((poolId, index) => {
      // A different miss pattern per pool, so sample counts differ and the
      // rounding edges of the percentile index actually get exercised.
      if ((r + index) % 5 === 0) {
        insertObs.run(raceId, poolId, null, null);
        return;
      }
      const latency = nextLatency();
      byPool.get(poolId).push({ raceId, latency });
      insertObs.run(raceId, poolId, latency, index + 1);
    });
  }

  for (const range of ['10', '100', 'all']) {
    const limit = range === 'all' ? raceIds.length : Number(range);
    const inRange = new Set(raceIds.slice(-limit));
    for (const pool of queries.stratumRanking(range)) {
      const samples = (byPool.get(pool.id) || [])
        .filter((s) => range === 'all' || inRange.has(s.raceId))
        .map((s) => s.latency)
        .sort((x, y) => x - y);
      assert.equal(pool.medianMs, previousPercentile(samples, 0.5), `median mismatch for pool ${pool.id}, range ${range}`);
      assert.equal(pool.p90Ms, previousPercentile(samples, 0.9), `p90 mismatch for pool ${pool.id}, range ${range}`);
    }
  }
});

test('deleting a pool also removes races it was the only participant in', () => {
  // Those races have no observations left, but still occupied slots in the
  // "last N races" windows - so the range selector quietly showed fewer data
  // points than it claimed.
  const poolId = db.instance
    .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES ('Solo Only', 'solo.example', 3333, 1, 0, ?)`)
    .run(Date.now()).lastInsertRowid;
  const raceId = db.instance.prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)').run('lonely-race', Date.now()).lastInsertRowid;
  db.instance.prepare('INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, 0, 1)').run(raceId, poolId);

  queries.deletePool(poolId);

  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_race WHERE id = ?').get(raceId).n, 0);
  const orphans = db.instance
    .prepare('SELECT COUNT(*) AS n FROM stratum_race WHERE id NOT IN (SELECT DISTINCT race_id FROM stratum_observation)')
    .get().n;
  assert.equal(orphans, 0, 'no race may be left without observations');
});

test('offlineTrustedPeers reports only trusted peers with no open session', () => {
  const now = Date.now();
  const online = db.getOrCreatePeer('203.0.113.10:8333');
  const offline = db.getOrCreatePeer('203.0.113.11:8333');
  const neverSeen = '203.0.113.12:8333';
  const trust = db.instance.prepare('INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)');
  trust.run('203.0.113.10:8333', 'still up', now);
  trust.run('203.0.113.11:8333', 'dropped', now);
  trust.run(neverSeen, 'never connected', now);

  const session = db.instance.prepare(
    'INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at) VALUES (?, ?, ?, ?, ?)',
  );
  session.run(online.id, 'outbound', 'manual', now - 60000, null);
  session.run(offline.id, 'outbound', 'manual', now - 7200000, now - 3600000);

  const result = queries.offlineTrustedPeers();
  const addresses = result.map((r) => r.address).sort();
  assert.deepEqual(addresses, ['203.0.113.11:8333', '203.0.113.12:8333']);

  const dropped = result.find((r) => r.address === '203.0.113.11:8333');
  assert.ok(dropped.offlineSinceMs >= 3600000, 'reports how long it has been gone');
  const never = result.find((r) => r.address === neverSeen);
  assert.equal(never.offlineSinceMs, null, 'a peer that never connected has no offline duration');
});
