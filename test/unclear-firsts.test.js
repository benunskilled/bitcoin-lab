'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-unclear-'));
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
/**
 * One block with `eligible` peers, `firsts` of them credited, and the number
 * of peers that matched stored as first_count (null = recorded before
 * first_count existed).
 */
function seedBlock(firsts, { eligible = 4, firstCount = firsts } = {}) {
  n += 1;
  const race = db.instance
    .prepare('INSERT INTO relay_race (block_hash, block_height, detected_at, first_count) VALUES (?, ?, ?, ?)')
    .run(String(n).padStart(64, '0'), 900000 + n, 1_700_000_000_000 + n, firstCount);
  const insert = db.instance.prepare(
    'INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)',
  );
  for (let i = 0; i < eligible; i += 1) {
    const peer = db.getOrCreatePeer(`10.0.0.${i}:8333`);
    insert.run(race.lastInsertRowid, peer.id, i < firsts ? 1 : 0);
  }
}

// A fresh install has nothing to say yet, and "0 in 0" is worse than nothing.
test('no blocks recorded means no number at all', () => {
  assert.equal(blocks.unclearFirsts(), null);
});

test('a block credited to one peer is clear', () => {
  seedBlock(1);
  seedBlock(1);
  assert.deepEqual(blocks.unclearFirsts(), { races: 2, unclear: 0 });
});

// Since this version: two matches, nobody credited, first_count says how many.
test('a block where two peers matched is unclear, though nobody was credited', () => {
  seedBlock(1);
  seedBlock(0, { firstCount: 2 });
  seedBlock(0, { firstCount: 3 });
  assert.deepEqual(blocks.unclearFirsts(), { races: 3, unclear: 2 });
});

// Recorded before first_count existed: both peers kept the First, and that
// doubled credit is the only trace.
test('an old block credited twice without first_count still counts as unclear', () => {
  seedBlock(2, { firstCount: null });
  seedBlock(1, { firstCount: null });
  assert.deepEqual(blocks.unclearFirsts(), { races: 2, unclear: 1 });
});

// Nobody credited and nobody matched is a different fault with its own
// warning (attributionHealth), not an unclear block.
test('a block nobody matched is a block, not an unclear one', () => {
  seedBlock(0);
  seedBlock(0, { firstCount: 2 });
  assert.deepEqual(blocks.unclearFirsts(), { races: 2, unclear: 1 });
});

test('the count is worked out once per block, not once per poll', () => {
  seedBlock(0, { firstCount: 2 });
  const first = blocks.unclearFirsts();
  assert.deepEqual(first, { races: 1, unclear: 1 });
  // The same object, which is what says the two counts did not run again.
  assert.equal(blocks.unclearFirsts(), first);

  seedBlock(1);
  assert.deepEqual(blocks.unclearFirsts(), { races: 2, unclear: 1 }, 'and a block is what makes it count again');
});
