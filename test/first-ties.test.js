'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-firstties-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const blocks = require('../src/lib/queries/blocks');

test.before(() => db.open());
test.beforeEach(() => {
  for (const t of ['relay_observation', 'relay_race']) db.instance.prepare(`DELETE FROM ${t}`).run();
});

let n = 0;
/** One block, with `firsts` of its `eligible` peers credited. */
function seedBlock(firsts, eligible = 4) {
  n += 1;
  const race = db.instance
    .prepare('INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, ?, ?)')
    .run(String(n).padStart(64, '0'), 900000 + n, 1_700_000_000_000 + n);
  const insert = db.instance.prepare(
    'INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)',
  );
  for (let i = 0; i < eligible; i += 1) {
    const peer = db.getOrCreatePeer(`10.0.0.${i}:8333`);
    insert.run(race.lastInsertRowid, peer.id, i < firsts ? 1 : 0);
  }
}

// A fresh install has nothing to say about its own resolution, and "0 in 0"
// is worse than nothing.
test('no blocks recorded means no number at all', () => {
  assert.equal(blocks.firstTies(), null);
});

test('a block credited to one peer is not a tie', () => {
  seedBlock(1);
  seedBlock(1);
  assert.deepEqual(blocks.firstTies(), { races: 2, ties: 0 });
});

// The case this exists for: Core reports last_block in whole seconds, so two
// peers that hand the block over inside one second are both credited.
test('a block credited to two peers counts once, not twice', () => {
  seedBlock(1);
  seedBlock(2);
  seedBlock(3);
  assert.deepEqual(blocks.firstTies(), { races: 3, ties: 2 });
});

// A block nobody was credited for is a different fault with its own warning
// (attributionHealth). It is not a tie and must not inflate the denominator's
// counterpart.
test('a block with nobody credited is counted as a block, not as a tie', () => {
  seedBlock(0);
  seedBlock(2);
  assert.deepEqual(blocks.firstTies(), { races: 2, ties: 1 });
});

// The query reads the partial index over the First rows. If that index were
// dropped or its WHERE clause changed, the answer would still have to be the
// same - so assert the plan uses it, which is what keeps this affordable on a
// status poll.
test('the count is served by the partial index on the First rows', () => {
  seedBlock(2);
  const plan = db.instance
    .prepare(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM (
         SELECT race_id FROM relay_observation WHERE first = 1
          GROUP BY race_id HAVING COUNT(*) > 1
       )`,
    )
    .all()
    .map((r) => r.detail)
    .join(' ');
  assert.match(plan, /idx_relay_obs_first/);
});
