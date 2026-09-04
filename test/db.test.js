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

// A peer can only ever be eligible for a block while it is connected, so a
// fixture that gives a peer relay history needs the session that goes with
// it. peerRanking() reports the peers that are connected now or are manual,
// not every address the node has ever seen (see queries.js) - a peer with
// observations but no session at all is a state production cannot produce.
function openSession(peerId, { direction = 'outbound', connectionType = 'outbound-full-relay' } = {}) {
  db.instance
    .prepare('INSERT INTO peer_session (peer_id, direction, connection_type, started_at) VALUES (?, ?, ?, ?)')
    .run(peerId, direction, connectionType, Date.now() - 3600000);
}

test('seeds the default stratum pool list exactly once', () => {
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_pool').get().n, 8);

  // Counting after a single open() proves nothing: the seed uses INSERT OR
  // IGNORE against a unique (host, port), so the count would be 8 with or
  // without the pools_seeded guard. What the guard is actually for is the
  // first boot, where all four processes race open() and the loser used to die
  // on a meta primary-key conflict. So: seed again, and assert both that
  // nothing is duplicated AND that a user's own edits survive it.
  db.instance.prepare(`UPDATE stratum_pool SET enabled = 0 WHERE label = 'AtlasPool'`).run();
  db.instance.prepare(`DELETE FROM stratum_pool WHERE label = 'Parasite Pool'`).run();

  db.seedDefaultPools();

  assert.equal(
    db.instance.prepare(`SELECT COUNT(*) AS n FROM stratum_pool WHERE label = 'Parasite Pool'`).get().n,
    0,
    'a default pool the user deleted must stay deleted - re-seeding must not resurrect it',
  );
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_pool').get().n, 7, 'and nothing is duplicated');
  assert.equal(
    db.instance.prepare(`SELECT enabled FROM stratum_pool WHERE label = 'AtlasPool'`).get().enabled,
    0,
    'nor undo what the user changed about one they kept',
  );

  // Leave the fixture as found for the tests that follow.
  db.instance
    .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES ('Parasite Pool','parasite.wtf',42069,1,1,?)`)
    .run(Date.now());
  db.instance.prepare(`UPDATE stratum_pool SET enabled = 1 WHERE label = 'AtlasPool'`).run();
});

test('getOrCreatePeer is idempotent by address', () => {
  const a = db.getOrCreatePeer('203.0.113.5:8333');
  const b = db.getOrCreatePeer('203.0.113.5:8333');
  assert.equal(a.id, b.id);
});

test('relay race first/eligible aggregation matches inserted observations', () => {
  const peerA = db.getOrCreatePeer('198.51.100.1:8333');
  const peerB = db.getOrCreatePeer('198.51.100.2:8333');
  openSession(peerA.id);
  openSession(peerB.id);

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
  openSession(peerC.id);
  openSession(peerD.id);
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
  // The low-ping peer deliberately sorts LAST alphabetically. The final
  // ORDER BY term is p.address ASC, so with the fixture the other way round
  // (as it was) this test passed with both ping clauses deleted from the
  // query - the address tiebreaker alone produced the asserted order.
  const peerLowPing = db.getOrCreatePeer('198.51.100.41:8333');
  const peerHighPing = db.getOrCreatePeer('198.51.100.40:8333');
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
  const idxLow = ranking.findIndex((r) => r.address === '198.51.100.41:8333');
  const idxHigh = ranking.findIndex((r) => r.address === '198.51.100.40:8333');
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

test('peer ranking computes offlineSinceMs for a trusted peer that dropped and has not reconnected', () => {
  const address = '203.0.113.77:8333';
  db.instance
    .prepare(`INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)`)
    .run(address, 'Offline Test Peer', Date.now());
  const peer = db.getOrCreatePeer(address);

  const endedAt = Date.now() - 45 * 60 * 1000; // dropped 45 minutes ago
  db.instance
    .prepare(
      `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, ended_at, min_ping_ms, last_ping_ms)
       VALUES (?, ?, 'outbound', 'manual', '/Satoshi:27.0.0/', ?, ?, 20, 20)`,
    )
    .run(peer.id, 6001, endedAt - 60 * 60 * 1000, endedAt);

  const ranking = queries.peerRanking();
  const row = ranking.find((r) => r.address === address);

  assert.equal(row.trusted, true);
  assert.equal(row.live, false);
  assert.ok(
    row.offlineSinceMs != null && row.offlineSinceMs >= 44 * 60 * 1000,
    'offlineSinceMs should reflect time since the most recent session ended',
  );
});

test('peer ranking leaves offlineSinceMs null for a trusted peer that has never connected', () => {
  const address = '203.0.113.78:8333';
  db.instance
    .prepare(`INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)`)
    .run(address, 'Never Connected Test Peer', Date.now());
  db.getOrCreatePeer(address);

  const ranking = queries.peerRanking();
  const row = ranking.find((r) => r.address === address);

  assert.equal(row.trusted, true);
  assert.equal(row.live, false);
  assert.equal(row.offlineSinceMs, null);
});

test('peer ranking flags a same-host Umbrel app (e.g. electrs) as localUmbrelPeer, not an external peer', () => {
  // Every Umbrel app container shares the same internal Docker network
  // (10.21.0.0/16 by convention) - a peer connecting from inside that range
  // that ISN'T the specific docker-proxy gateway address is a sibling app
  // container (electrs, mempool's indexer, ...) talking to Core's P2P port
  // directly, not a real external peer. Matches the user's own real-world
  // example address/subver.
  const electrsPeer = db.getOrCreatePeer('10.21.21.10:53400');
  const externalPeer = db.getOrCreatePeer('198.51.100.60:8333');

  const insertSession = db.instance.prepare(
    `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, min_ping_ms, last_ping_ms)
     VALUES (?, ?, 'inbound', 'inbound', ?, ?, 5, 5)`,
  );
  insertSession.run(electrsPeer.id, 7001, '/electrs:0.11.1/', Date.now());
  insertSession.run(externalPeer.id, 7002, '/Satoshi:27.0.0/', Date.now());

  const ranking = queries.peerRanking();
  const electrsRow = ranking.find((r) => r.address === '10.21.21.10:53400');
  const externalRow = ranking.find((r) => r.address === '198.51.100.60:8333');

  assert.equal(electrsRow.localUmbrelPeer, true);
  assert.equal(electrsRow.localAppName, 'electrs');
  assert.equal(externalRow.localUmbrelPeer, false);
  assert.equal(externalRow.localAppName, null);
});

test('peer ranking treats the docker-proxy masked gateway as sourceObscured, not localUmbrelPeer', () => {
  // The masked gateway address (10.21.0.1) also falls inside the internal
  // network CIDR, but it means something different: it's Core's own view of
  // a real EXTERNAL peer whose true address Docker's relay hid, not a local
  // sibling app. sourceObscured must take precedence so the UI shows the
  // "address hidden by Docker" explanation, not a bogus "Local Umbrel app".
  const maskedPeer = db.getOrCreatePeer('10.21.0.1:41234');
  db.instance
    .prepare(
      `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, min_ping_ms, last_ping_ms)
       VALUES (?, ?, 'inbound', 'inbound', '/Satoshi:27.0.0/', ?, 30, 30)`,
    )
    .run(maskedPeer.id, 7003, Date.now());

  const ranking = queries.peerRanking();
  const row = ranking.find((r) => r.address === '10.21.0.1:41234');

  assert.equal(row.sourceObscured, true);
  assert.equal(row.localUmbrelPeer, false);
});

test('pruneOldData keeps peers with relay history and trusted peers forever, only ages out feelers and stale stratum history', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Comfortably outside every retention window, including the 365-day one
  // the stratum history uses - it is the fixture for "ancient".
  const veryOldTs = Date.now() - 400 * DAY_MS;
  const staleFeelerTs = Date.now() - 20 * DAY_MS; // outside the default 14-day feeler window
  const freshFeelerTs = Date.now() - 2 * DAY_MS; // inside the default 14-day feeler window

  // Has relay_observation history, even ancient - must never be pruned:
  // neither the peer row, nor its session, nor the relay_race/observation
  // themselves (which are never time-pruned at all - that IS the app).
  const rankedAddress = '198.51.100.90:8333';
  const rankedPeer = db.getOrCreatePeer(rankedAddress);
  const oldRaceId = db.instance
    .prepare('INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, ?, ?)')
    .run('prune-ranked-block', 900, veryOldTs).lastInsertRowid;
  db.instance
    .prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, 1)')
    .run(oldRaceId, rankedPeer.id);
  db.instance
    .prepare(
      `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, ended_at, min_ping_ms, last_ping_ms)
       VALUES (?, ?, 'inbound', 'inbound', '/Satoshi:27.0.0/', ?, ?, 10, 10)`,
    )
    .run(rankedPeer.id, 8001, veryOldTs - 3600_000, veryOldTs);

  // No relay history at all, not trusted, closed session older than the
  // feeler window - a pure "feeler" that should be fully pruned, peer row
  // included, once its session goes with it.
  const feelerAddress = '198.51.100.91:8333';
  const feelerPeer = db.getOrCreatePeer(feelerAddress);
  db.instance
    .prepare(
      `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, ended_at, min_ping_ms, last_ping_ms)
       VALUES (?, ?, 'inbound', 'inbound', '/Satoshi:27.0.0/', ?, ?, 10, 10)`,
    )
    .run(feelerPeer.id, 8002, staleFeelerTs - 3600_000, staleFeelerTs);

  // Same as above but its closed session is still inside the feeler
  // window - too young to prune yet.
  const freshFeelerAddress = '198.51.100.92:8333';
  const freshFeelerPeer = db.getOrCreatePeer(freshFeelerAddress);
  db.instance
    .prepare(
      `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, ended_at, min_ping_ms, last_ping_ms)
       VALUES (?, ?, 'inbound', 'inbound', '/Satoshi:27.0.0/', ?, ?, 10, 10)`,
    )
    .run(freshFeelerPeer.id, 8003, freshFeelerTs - 3600_000, freshFeelerTs);

  // Trusted, no relay history, only an ancient closed session - peer row
  // AND session must both survive: trusted peers are never touched here,
  // regardless of relay history or age.
  const trustedAddress = '198.51.100.93:8333';
  db.instance
    .prepare(`INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)`)
    .run(trustedAddress, 'Prune Test Trusted', veryOldTs);
  const trustedPeer = db.getOrCreatePeer(trustedAddress);
  db.instance
    .prepare(
      `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, ended_at, min_ping_ms, last_ping_ms)
       VALUES (?, ?, 'outbound', 'manual', '/Satoshi:27.0.0/', ?, ?, 10, 10)`,
    )
    .run(trustedPeer.id, 8004, veryOldTs - 3600_000, veryOldTs);

  // A feeler whose session is old but still LIVE (ended_at IS NULL) must
  // never be touched, no matter how long ago it started.
  const longLivedAddress = '198.51.100.94:8333';
  const longLivedPeer = db.getOrCreatePeer(longLivedAddress);
  db.instance
    .prepare(
      `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, min_ping_ms, last_ping_ms)
       VALUES (?, ?, 'outbound', 'outbound-full-relay', '/Satoshi:27.0.0/', ?, 10, 10)`,
    )
    .run(longLivedPeer.id, 8005, veryOldTs);

  // Old stratum race/observation - this history still ages out on its own
  // (much longer, default one-year) schedule, unaffected by the peer changes.
  const oldStratumPool = db.instance.prepare('SELECT id FROM stratum_pool LIMIT 1').get();
  const oldStratumRaceId = db.instance
    .prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)')
    .run('prune-old-prevhash', veryOldTs).lastInsertRowid;
  db.instance
    .prepare('INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, 100, 1)')
    .run(oldStratumRaceId, oldStratumPool.id);

  const result = queries.pruneOldData();
  assert.equal(result.stratumRacesDeleted, 1);
  assert.ok(result.feelerSessionsDeleted >= 1, 'the stale feeler session should be pruned');
  // >=1 rather than an exact count: earlier tests in this shared DB may
  // have left their own history-less peer rows behind, which are
  // legitimately orphaned too and correctly swept up alongside feelerAddress.
  assert.ok(result.peersDeleted >= 1, 'the stale feeler peer should be dropped');

  // Ranked peer (has relay history): everything survives, however old.
  assert.ok(db.instance.prepare('SELECT * FROM peer WHERE address = ?').get(rankedAddress));
  assert.ok(db.instance.prepare('SELECT * FROM relay_race WHERE block_hash = ?').get('prune-ranked-block'));
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM peer_session WHERE peer_id = ?').get(rankedPeer.id).n,
    1,
  );

  // Stale feeler: fully gone.
  assert.equal(db.instance.prepare('SELECT * FROM peer WHERE address = ?').get(feelerAddress), undefined);

  // Fresh feeler: still inside its retention window, untouched.
  assert.ok(db.instance.prepare('SELECT * FROM peer WHERE address = ?').get(freshFeelerAddress));
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM peer_session WHERE peer_id = ?').get(freshFeelerPeer.id).n,
    1,
  );

  // Trusted peer: peer row AND its ancient session both survive.
  assert.ok(db.instance.prepare('SELECT * FROM peer WHERE address = ?').get(trustedAddress));
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM peer_session WHERE peer_id = ?').get(trustedPeer.id).n,
    1,
  );

  // Old stratum race: pruned on its own (much longer) schedule.
  assert.equal(db.instance.prepare('SELECT * FROM stratum_race WHERE prevhash = ?').get('prune-old-prevhash'), undefined);

  // Still-live old session survives untouched.
  const liveSession = db.instance.prepare('SELECT * FROM peer_session WHERE peer_id = ?').get(longLivedPeer.id);
  assert.ok(liveSession);
  assert.equal(liveSession.ended_at, null);
});

// Note: this asserts the SQL clause's own semantics, not a path through
// stratum-race.js - the scenario it describes can no longer arise there (see
// the scope note on that upsert). Kept because the clause is kept, and because
// "never overwrites a real result" is the half of it that must not regress.
test('the stratum_observation upsert corrects a miss but never overwrites a real result', () => {
  // Exercises the exact SQL pattern stratum-race.js's handleNotify() uses -
  // reproduces the bug this was written to fix: if a real mining.notify's
  // write was delayed (e.g. by DB lock contention with the retention
  // prune/vacuum) past the race timeout, finalizeCurrentRace() may have
  // already recorded a miss (NULL latency) for that (race, pool) pair. The
  // late-but-genuine report should still overwrite that miss rather than
  // being silently dropped by a plain INSERT OR IGNORE.
  const pool = db.instance.prepare('SELECT id FROM stratum_pool LIMIT 1').get();
  const raceId = db.instance
    .prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)')
    .run('upsert-test-prevhash', Date.now()).lastInsertRowid;

  const upsert = db.instance.prepare(
    `INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(race_id, pool_id) DO UPDATE SET latency_ms = excluded.latency_ms, rank = excluded.rank
     WHERE stratum_observation.latency_ms IS NULL`,
  );

  // finalizeCurrentRace() recorded a miss first (this is the OR IGNORE path
  // it actually uses - a plain miss insert, never upserted over).
  db.instance
    .prepare(`INSERT OR IGNORE INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, NULL, NULL)`)
    .run(raceId, pool.id);

  // The late-but-real report arrives afterward and should correct it.
  upsert.run(raceId, pool.id, 4321, 1);
  let row = db.instance.prepare('SELECT * FROM stratum_observation WHERE race_id = ? AND pool_id = ?').get(raceId, pool.id);
  assert.equal(row.latency_ms, 4321);
  assert.equal(row.rank, 1);

  // A second, later "report" for the same (race, pool) - should never
  // happen in practice (reportedPoolIds guards against it in-process), but
  // the SQL itself must still never clobber an already-recorded real value.
  upsert.run(raceId, pool.id, 9999, 2);
  row = db.instance.prepare('SELECT * FROM stratum_observation WHERE race_id = ? AND pool_id = ?').get(raceId, pool.id);
  assert.equal(row.latency_ms, 4321, 'an already-recorded real result must never be overwritten');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('liveSummary counts each connection under exactly one heading', () => {
  // This feeds the header stat grid, the "N peers connected" pill and the
  // Umbrel widget's Live Peers tile, and had no test at all: deleting the
  // inbound/outbound/manual accumulators left the whole suite green.
  db.instance.exec('DELETE FROM peer_session');
  const mk = (address, direction, connectionType) => {
    const peer = db.getOrCreatePeer(address);
    db.instance
      .prepare(`INSERT INTO peer_session (peer_id, direction, connection_type, started_at) VALUES (?, ?, ?, ?)`)
      .run(peer.id, direction, connectionType, Date.now() - 60000);
  };
  mk('192.0.2.210:8333', 'inbound', 'inbound');
  mk('192.0.2.211:8333', 'inbound', 'inbound');
  mk('192.0.2.212:8333', 'outbound', 'outbound-full-relay');
  mk('192.0.2.213:8333', 'outbound', 'block-relay-only');
  mk('192.0.2.214:8333', 'outbound', 'manual');

  const s = queries.liveSummary();
  assert.equal(s.total, 5);
  assert.equal(s.inbound, 2);
  assert.equal(s.outbound, 3, 'manual connections are outbound too - Core dialled them');
  assert.equal(s.manual, 1);
  assert.equal(s.outboundFullRelay, 1);
  assert.equal(s.blockRelayOnly, 1);
  assert.equal(s.inbound + s.outbound, s.total, 'every connection is one or the other, never both or neither');
});

test('weakestTrustedPeer breaks a tie towards the peer that is not even connected', () => {
  // The documented tiebreak had no coverage: deleting it left the suite green,
  // and eviction then depended on array order in all three callers.
  const live = { address: 'a:8333', firstPct: 5, live: true };
  const offline = { address: 'b:8333', firstPct: 5, live: false };
  assert.equal(queries.weakestTrustedPeer([live, offline]).address, 'b:8333');
  assert.equal(queries.weakestTrustedPeer([offline, live]).address, 'b:8333', 'and not by input order');

  // But being offline must never outweigh a genuinely better record - that is
  // what the performance-scaled grace period is for, not this.
  const strongOffline = { address: 'c:8333', firstPct: 30, live: false };
  const weakLive = { address: 'd:8333', firstPct: 1, live: true };
  assert.equal(queries.weakestTrustedPeer([strongOffline, weakLive]).address, 'd:8333');

  // No record at all sorts below 0%.
  assert.equal(
    queries.weakestTrustedPeer([{ address: 'e:8333', firstPct: 0, live: true }, { address: 'f:8333', firstPct: null, live: true }]).address,
    'f:8333',
  );
  assert.equal(queries.weakestTrustedPeer([]), null);
});

test('Tor, I2P and CJDNS peers are ranked but flagged as impossible to keep', () => {
  // All three are real peers that genuinely deliver blocks - they must appear
  // in the ranking and earn First % like anyone else. What they cannot do is
  // be promoted: this container dials plain TCP and has no route to any of
  // these networks. The flag is what lets the dashboard say so instead of
  // offering a button that always fails.
  const cases = [
    ['vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion:8333', 'Tor'],
    ['ukeu3k5oycgaauneqgtnvselmt4yemvoilkln7jpvamvfx7dnkdq.b32.i2p:0', 'I2P'],
    ['[fc32:17ea:e415:c3bf:9808:149d:b5a2:c9aa]:8333', 'CJDNS'],
  ];
  for (const [address] of cases) {
    const peer = db.getOrCreatePeer(address);
    db.instance
      .prepare(`INSERT INTO peer_session (peer_id, direction, connection_type, started_at) VALUES (?, 'inbound', 'inbound', ?)`)
      .run(peer.id, Date.now() - 60000);
  }
  const ranking = queries.peerRanking();
  for (const [address, network] of cases) {
    const row = ranking.find((r) => r.address === address);
    assert.ok(row, `${network} peers must still be ranked - they do deliver blocks`);
    assert.equal(row.privateNetwork, network);
  }

  // An ordinary peer must not be caught by any of those patterns - fc00::/8 in
  // particular sits next to perfectly normal IPv6.
  const plain = db.getOrCreatePeer('[2001:db8::5]:8333');
  db.instance
    .prepare(`INSERT INTO peer_session (peer_id, direction, connection_type, started_at) VALUES (?, 'outbound', 'outbound-full-relay', ?)`)
    .run(plain.id, Date.now() - 60000);
  assert.equal(queries.peerRanking().find((r) => r.address === '[2001:db8::5]:8333').privateNetwork, null);
});


test('resetPeerData clears the measurement history but keeps the manual peers', () => {
  const kept = '203.0.113.177:8333';
  db.instance.prepare('INSERT OR REPLACE INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)').run(kept, 'hard-won', Date.now());
  const keptPeer = db.getOrCreatePeer(kept);
  const stranger = db.getOrCreatePeer('198.51.100.77:8333');
  const raceId = db.instance
    .prepare('INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, NULL, ?)')
    .run('reset-test-hash', Date.now()).lastInsertRowid;
  db.instance.prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, 1)').run(raceId, keptPeer.id);
  db.instance.prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, 0)').run(raceId, stranger.id);
  db.instance.prepare('INSERT INTO parked_peer (address, first_pct, eligible, parked_at, probe_failures) VALUES (?, 5, 100, ?, 0)').run('198.51.100.9:8333', Date.now());

  const result = db.resetPeerData();

  assert.ok(result.keptManualPeers >= 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(kept).n, 1, 'the manual set is the whole point');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM relay_race').get().n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM relay_observation').get().n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM peer_relay_stats').get().n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer').get().n, 0);
  // The manual peer gets an empty peer row back, so it appears in the ranking
  // at once rather than only when Core next reconnects it.
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM peer WHERE address = ?').get(kept).n, 1);
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM peer WHERE address NOT IN (SELECT address FROM trusted_peer)').get().n,
    0,
    'and nobody but the manual peers survives',
  );
});

test('resetPeerData leaves the delete trigger in place, so the rollup stays maintained afterwards', () => {
  // It is dropped for the duration - firing it once per row is pointless when
  // the rollup is being cleared anyway, and ruinous at a hundred thousand rows.
  // If it were not restored, every later prune would silently stop decrementing
  // and the ranking would drift upwards forever.
  db.resetPeerData();

  const present = db.instance
    .prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'trigger' AND name = 'trg_relay_observation_delete'")
    .get().n;
  assert.equal(present, 1);

  const peer = db.getOrCreatePeer('203.0.113.200:8333');
  const raceId = db.instance
    .prepare('INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, NULL, ?)')
    .run('trigger-check-hash', Date.now()).lastInsertRowid;
  db.instance.prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, 1)').run(raceId, peer.id);
  assert.equal(db.instance.prepare('SELECT eligible AS e FROM peer_relay_stats WHERE peer_id = ?').get(peer.id).e, 1);

  db.instance.prepare('DELETE FROM relay_observation WHERE race_id = ?').run(raceId);
  assert.equal(db.instance.prepare('SELECT eligible AS e FROM peer_relay_stats WHERE peer_id = ?').get(peer.id).e, 0, 'the trigger still counts down');
});

test('resetPoolHistory clears the races but keeps the configured pools', () => {
  const pool = db.instance.prepare('SELECT id FROM stratum_pool LIMIT 1').get();
  const poolsBefore = db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_pool').get().n;
  const raceId = db.instance
    .prepare('INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)')
    .run('reset-pool-prevhash', Date.now()).lastInsertRowid;
  db.instance.prepare('INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, 42, 1)').run(raceId, pool.id);

  db.resetPoolHistory();

  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_race').get().n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_observation').get().n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM stratum_pool').get().n, poolsBefore, 'the pool list is configuration, not history');
});

test('resetting peer data clears the promotion record with everything else', () => {
  db.instance.prepare(`INSERT OR IGNORE INTO promoted_peer (ip, first_promoted_at) VALUES (?, ?)`).run('203.0.113.99', Date.now());
  assert.equal(db.instance.prepare(`SELECT COUNT(*) AS n FROM promoted_peer`).get().n, 1);

  db.resetPeerData();

  // The funnel's other three numbers come from the tables this reset empties,
  // so a surviving "kept" count would read as a contradiction rather than as
  // history worth keeping.
  assert.equal(db.instance.prepare(`SELECT COUNT(*) AS n FROM promoted_peer`).get().n, 0);
});

test('the promotion record is charged to the peer data group', () => {
  assert.ok(db.PEER_DATA_TABLES.includes('promoted_peer'),
    'otherwise its bytes belong to no group and the storage panel quietly under-reports');
});

test('the backfill counts peers that were kept before the record existed', () => {
  // An installed node: manual peers and a parked one, none of them in
  // promoted_peer because the table did not exist when they were kept.
  db.instance.prepare(`DELETE FROM promoted_peer`).run();
  db.instance.prepare(`DELETE FROM trusted_peer`).run();
  db.instance.prepare(`DELETE FROM parked_peer`).run();
  const now = Date.now();
  db.instance.prepare(`INSERT OR REPLACE INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)`).run('203.0.113.41:8333', null, now);
  db.instance.prepare(`INSERT OR REPLACE INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)`).run('[2001:db8::5]:8333', null, now);
  db.instance.prepare(`INSERT OR REPLACE INTO parked_peer (address, first_pct, eligible, parked_at, probe_failures) VALUES (?, ?, ?, ?, 0)`).run('198.51.100.41:8333', 3.2, 400, now);
  // Same host as the first manual peer, under the port an inbound peer dials
  // from: must not become a second row.
  db.instance.prepare(`INSERT OR REPLACE INTO parked_peer (address, first_pct, eligible, parked_at, probe_failures) VALUES (?, ?, ?, ?, 0)`).run('203.0.113.41:51234', 1.0, 200, now);

  db.instance.prepare(`DELETE FROM meta WHERE key = ?`).run('migration:promoted_peer_backfill_v1_15_10');
  db.runMigrations();

  const ips = db.instance.prepare(`SELECT ip FROM promoted_peer ORDER BY ip`).all().map(r => r.ip);
  assert.deepEqual(ips, ['198.51.100.41', '203.0.113.41', '[2001:db8::5]']);
});
