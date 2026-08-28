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

test('stratum ranking respects the block-count range filter and flags the last race winner', () => {
  // Offset past the pool used by the win%/miss test above, which already
  // recorded a win against the first pool - avoid double-counting it here.
  const [poolA, poolB] = db.instance.prepare('SELECT * FROM stratum_pool ORDER BY id LIMIT 2 OFFSET 2').all();

  const insertRace = db.instance.prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)');
  const insertObs = db.instance.prepare(
    'INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, ?, ?)',
  );

  // Older race: pool A wins.
  let raceId = insertRace.run('range-prevhash-old', Date.now() - 1000).lastInsertRowid;
  insertObs.run(raceId, poolA.id, 0, 1);
  insertObs.run(raceId, poolB.id, 50, 2);

  // Newest race overall: pool B wins.
  raceId = insertRace.run('range-prevhash-new', Date.now()).lastInsertRowid;
  insertObs.run(raceId, poolB.id, 0, 1);
  insertObs.run(raceId, poolA.id, 80, 2);

  const allTime = queries.stratumRanking('all');
  const aAllTime = allTime.find((p) => p.id === poolA.id);
  assert.equal(aAllTime.wins, 1); // still counts the old win

  const lastOne = queries.stratumRanking('1'); // last 1 race only
  const aLastOne = lastOne.find((p) => p.id === poolA.id);
  const bLastOne = lastOne.find((p) => p.id === poolB.id);
  assert.equal(aLastOne.wins, 0); // old win falls outside a 1-race window
  assert.equal(bLastOne.wins, 1);

  // wonLastRace should point at pool B regardless of which range is selected.
  assert.equal(bLastOne.wonLastRace, true);
  assert.equal(aLastOne.wonLastRace, false);
  assert.equal(allTime.find((p) => p.id === poolB.id).wonLastRace, true);
});

test('deletePool removes a pool that already has observation history without throwing', () => {
  // Reproduces the "Remove" button's 500 "internal error": stratum_pool has
  // no ON DELETE CASCADE from stratum_observation, and foreign keys are
  // enforced, so a bare DELETE on a pool that ever raced (even a manually
  // added one, like a user's own local pool, that only ever recorded a
  // miss) throws a FOREIGN KEY constraint failure.
  const insertPool = db.instance.prepare(
    `INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 0, ?)`,
  );
  const poolId = insertPool.run('Temp Local Pool', 'gobrrr-pool_ckpool_1', 3333, Date.now()).lastInsertRowid;

  const raceId = db.instance
    .prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)')
    .run('delete-pool-prevhash', Date.now()).lastInsertRowid;
  db.instance
    .prepare('INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, NULL, NULL)')
    .run(raceId, poolId);

  assert.doesNotThrow(() => queries.deletePool(poolId));

  const poolRow = db.instance.prepare('SELECT * FROM stratum_pool WHERE id = ?').get(poolId);
  const obsRows = db.instance.prepare('SELECT * FROM stratum_observation WHERE pool_id = ?').all(poolId);
  assert.equal(poolRow, undefined);
  assert.equal(obsRows.length, 0);
});

test('peer ranking sorts by first% (rate), not raw first count', () => {
  // Peer C: first in 1 of 2 eligible races (50%). Peer D: first in 2 of 10
  // (20%), but with a higher raw count. Ranking by percentage should put C
  // above D even though D has "more firsts" overall.
  const peerC = db.getOrCreatePeer('198.51.100.30:8333');
  const peerD = db.getOrCreatePeer('198.51.100.31:8333');
  const insertRace = db.instance.prepare(
    'INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, ?, ?)',
  );
  const insertObs = db.instance.prepare(
    'INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)',
  );

  let raceId = insertRace.run('sort-block-1', 200, Date.now()).lastInsertRowid;
  insertObs.run(raceId, peerC.id, 1);
  insertObs.run(raceId, peerD.id, 1);
  raceId = insertRace.run('sort-block-2', 201, Date.now()).lastInsertRowid;
  insertObs.run(raceId, peerC.id, 0);
  insertObs.run(raceId, peerD.id, 1);
  for (let i = 3; i <= 10; i += 1) {
    raceId = insertRace.run(`sort-block-${i}`, 200 + i, Date.now()).lastInsertRowid;
    insertObs.run(raceId, peerD.id, 0);
  }

  const ranking = queries.peerRanking();
  const idxC = ranking.findIndex((r) => r.address === '198.51.100.30:8333');
  const idxD = ranking.findIndex((r) => r.address === '198.51.100.31:8333');
  assert.ok(idxC < idxD, 'higher first% should rank above higher raw first count');
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

test('peer ranking uses ping as the tiebreaker when first% is tied', () => {
  const peerLowPing = db.getOrCreatePeer('198.51.100.40:8333');
  const peerHighPing = db.getOrCreatePeer('198.51.100.41:8333');
  const insertRace = db.instance.prepare(
    'INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, ?, ?)',
  );
  const insertObs = db.instance.prepare(
    'INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)',
  );
  const raceId = insertRace.run('ping-tiebreak-block', 300, Date.now()).lastInsertRowid;
  insertObs.run(raceId, peerLowPing.id, 1);
  insertObs.run(raceId, peerHighPing.id, 1);

  const insertSession = db.instance.prepare(
    `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, min_ping_ms, last_ping_ms)
     VALUES (?, ?, 'outbound', 'outbound-full-relay', '/Satoshi:27.0.0/', ?, ?, ?)`,
  );
  insertSession.run(peerLowPing.id, 4001, Date.now(), 15, 15);
  insertSession.run(peerHighPing.id, 4002, Date.now(), 220, 220);

  const ranking = queries.peerRanking();
  const idxLow = ranking.findIndex((r) => r.address === '198.51.100.40:8333');
  const idxHigh = ranking.findIndex((r) => r.address === '198.51.100.41:8333');
  assert.ok(idxLow < idxHigh, 'both peers tied at 100% first - lower ping should rank first');
});

test('stratum ranking sorts pools by win% first, avg latency as the tiebreaker', () => {
  const insertPool = db.instance.prepare(
    `INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 0, ?)`,
  );
  const poolSlow = insertPool.run('Sort Test Slow 100%', 'sort-test-slow.example', 3333, Date.now()).lastInsertRowid;
  const poolFast = insertPool.run('Sort Test Fast 100%', 'sort-test-fast.example', 3333, Date.now()).lastInsertRowid;
  const poolLowWin = insertPool.run('Sort Test Low Win%', 'sort-test-lowwin.example', 3333, Date.now()).lastInsertRowid;

  const insertRace = db.instance.prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)');
  const insertObs = db.instance.prepare(
    'INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, ?, ?)',
  );

  // poolSlow and poolFast each win their own race outright (100% win rate
  // each) but at very different latency - the tiebreaker.
  let raceId = insertRace.run('sort-test-race-1', Date.now()).lastInsertRowid;
  insertObs.run(raceId, poolSlow, 500, 1);
  raceId = insertRace.run('sort-test-race-2', Date.now()).lastInsertRowid;
  insertObs.run(raceId, poolFast, 50, 1);

  // poolLowWin wins one race and misses another - lower win% than either of
  // the above despite being present, so it should rank below both.
  raceId = insertRace.run('sort-test-race-3', Date.now()).lastInsertRowid;
  insertObs.run(raceId, poolLowWin, 200, 1);
  raceId = insertRace.run('sort-test-race-4', Date.now()).lastInsertRowid;
  insertObs.run(raceId, poolLowWin, null, null);

  const ranking = queries.stratumRanking('all');
  const idxSlow = ranking.findIndex((p) => p.id === poolSlow);
  const idxFast = ranking.findIndex((p) => p.id === poolFast);
  const idxLowWin = ranking.findIndex((p) => p.id === poolLowWin);

  assert.ok(idxFast < idxSlow, 'both pools tied at 100% win rate - lower avg latency should rank first');
  assert.ok(idxSlow < idxLowWin, 'higher win% should outrank lower win%, regardless of latency');
});

test('peer ranking flags a Docker-proxy-masked inbound IPv6 address as sourceObscured', () => {
  // Docker can only relay an inbound IPv6 connection to our IPv4-only
  // container via docker-proxy, which re-originates it from its own
  // gateway - Core's getpeerinfo then reports the peer's "addr" as that
  // gateway (default 10.21.0.1, see config.js), never the peer's real
  // address. The app should recognize and flag this rather than display a
  // meaningless local IP as if it were a real peer.
  const maskedPeer = db.getOrCreatePeer('10.21.0.1:54321');
  const realPeer = db.getOrCreatePeer('198.51.100.50:8333');

  const insertSession = db.instance.prepare(
    `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, min_ping_ms, last_ping_ms)
     VALUES (?, ?, 'inbound', 'inbound', '/Satoshi:27.0.0/', ?, 30, 30)`,
  );
  insertSession.run(maskedPeer.id, 5001, Date.now());
  insertSession.run(realPeer.id, 5002, Date.now());

  const ranking = queries.peerRanking();
  const masked = ranking.find((r) => r.address === '10.21.0.1:54321');
  const real = ranking.find((r) => r.address === '198.51.100.50:8333');

  assert.equal(masked.sourceObscured, true);
  assert.equal(real.sourceObscured, false);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
