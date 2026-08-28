'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point at a throwaway SQLite file before any app module is required, so
// config.js/db.js pick it up at module-load time.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-test-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;

const db = require('../src/lib/db');
const queries = require('../src/lib/queries');

test.before(() => {
  db.open();
});

test('seeds the default stratum pool list exactly once', () => {
  const rows = db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_pool').get();
  assert.equal(rows.n, 8);
});

test('getOrCreatePeer is idempotent by address', () => {
  const a = db.getOrCreatePeer('203.0.113.5:8333');
  const b = db.getOrCreatePeer('203.0.113.5:8333');
  assert.equal(a.id, b.id);
});

test('relay race first/eligible aggregation matches inserted observations', () => {
  const peerA = db.getOrCreatePeer('198.51.100.1:8333');
  const peerB = db.getOrCreatePeer('198.51.100.2:8333');

  const insertRace = db.instance.prepare(
    'INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, ?, ?)',
  );
  const insertObs = db.instance.prepare(
    'INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)',
  );

  // Race 1: peer A is first, both eligible.
  let raceId = insertRace.run('blockhash1', 100, Date.now()).lastInsertRowid;
  insertObs.run(raceId, peerA.id, 1);
  insertObs.run(raceId, peerB.id, 0);

  // Race 2: peer B is first, both eligible.
  raceId = insertRace.run('blockhash2', 101, Date.now()).lastInsertRowid;
  insertObs.run(raceId, peerA.id, 0);
  insertObs.run(raceId, peerB.id, 1);

  const ranking = queries.peerRanking();
  const a = ranking.find((r) => r.address === '198.51.100.1:8333');
  const b = ranking.find((r) => r.address === '198.51.100.2:8333');

  assert.equal(a.eligible, 2);
  assert.equal(a.first, 1);
  assert.equal(a.firstPct, 50);
  assert.equal(b.eligible, 2);
  assert.equal(b.first, 1);
});

test('latestBlock returns the newest race and its first-peer(s)', () => {
  const result = queries.latestBlock();
  assert.equal(result.blockHash, 'blockhash2');
  assert.equal(result.blockHeight, 101);
  assert.deepEqual(result.firstPeers.map((p) => p.address), ['198.51.100.2:8333']);
});

test('stratum ranking computes win% and treats NULL latency as a miss', () => {
  const pool = db.instance.prepare('SELECT * FROM stratum_pool LIMIT 1').get();

  const insertRace = db.instance.prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)');
  const insertObs = db.instance.prepare(
    'INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, ?, ?)',
  );

  let raceId = insertRace.run('prevhash-a', Date.now()).lastInsertRowid;
  insertObs.run(raceId, pool.id, 0, 1); // won this race

  raceId = insertRace.run('prevhash-b', Date.now()).lastInsertRowid;
  insertObs.run(raceId, pool.id, null, null); // missed this race

  const ranking = queries.stratumRanking();
  const row = ranking.find((p) => p.id === pool.id);

  assert.equal(row.seen, 2);
  assert.equal(row.misses, 1);
  assert.equal(row.wins, 1);
  assert.equal(row.winPct, 50);
});

test('stratum ranking respects the time-range filter and flags the last race winner', () => {
  // Offset past the pool used by the win%/miss test above, which already
  // recorded a win against the first pool - avoid double-counting it here.
  const [poolA, poolB] = db.instance.prepare('SELECT * FROM stratum_pool ORDER BY id LIMIT 2 OFFSET 2').all();

  const insertRace = db.instance.prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)');
  const insertObs = db.instance.prepare(
    'INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, ?, ?)',
  );

  const now = Date.now();
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;

  // Old race (outside a 1h window): pool A wins.
  let raceId = insertRace.run('range-prevhash-old', twoHoursAgo).lastInsertRowid;
  insertObs.run(raceId, poolA.id, 0, 1);
  insertObs.run(raceId, poolB.id, 50, 2);

  // Recent race (inside a 1h window, and the newest race overall): pool B wins.
  raceId = insertRace.run('range-prevhash-new', now).lastInsertRowid;
  insertObs.run(raceId, poolB.id, 0, 1);
  insertObs.run(raceId, poolA.id, 80, 2);

  const allTime = queries.stratumRanking('all');
  const aAllTime = allTime.find((p) => p.id === poolA.id);
  assert.equal(aAllTime.wins, 1); // still counts the old win

  const lastHour = queries.stratumRanking('1h');
  const aLastHour = lastHour.find((p) => p.id === poolA.id);
  const bLastHour = lastHour.find((p) => p.id === poolB.id);
  assert.equal(aLastHour.wins, 0); // old win falls outside the window
  assert.equal(bLastHour.wins, 1);

  // wonLastRace should point at pool B regardless of which range is selected.
  assert.equal(bLastHour.wonLastRace, true);
  assert.equal(aLastHour.wonLastRace, false);
  assert.equal(allTime.find((p) => p.id === poolB.id).wonLastRace, true);
});

test('a live peer Core reports as connection_type "manual" is treated as trusted even without a trusted_peer row', () => {
  // Simulates a peer addnode'd outside this app (bitcoin-cli, bitcoin.conf,
  // or added before trusted_peer existed) - Core says "manual", but we
  // never wrote a trusted_peer row for it.
  const peer = db.getOrCreatePeer('203.0.113.99:8333');
  db.instance
    .prepare(
      `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, min_ping_ms, last_ping_ms)
       VALUES (?, ?, 'outbound', 'manual', '/Satoshi:27.0.0/', ?, 20, 20)`,
    )
    .run(peer.id, 999, Date.now());

  const ranking = queries.peerRanking();
  const row = ranking.find((r) => r.address === '203.0.113.99:8333');

  assert.equal(row.trusted, true);
  assert.equal(row.status, 'MANUAL LIVE');
  // connectionStatus stays the raw Core connection type - used by the
  // Outbound panel, which this peer should no longer even appear in once
  // the frontend filters on `trusted`.
  assert.equal(row.connectionStatus, 'MANUAL');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
