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

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
