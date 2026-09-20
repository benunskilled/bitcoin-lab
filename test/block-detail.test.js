'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-blockdetail-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const blocks = require('../src/lib/queries/blocks');
const prevhash = require('../src/lib/prevhash');

const HASH = 'a'.repeat(8) + 'b'.repeat(8) + 'c'.repeat(8) + 'd'.repeat(8)
  + '1'.repeat(8) + '2'.repeat(8) + '3'.repeat(8) + '4'.repeat(8);

test.before(() => db.open());
test.beforeEach(() => {
  for (const t of ['stratum_observation', 'stratum_race', 'stratum_pool', 'relay_observation', 'relay_race']) {
    db.instance.prepare(`DELETE FROM ${t}`).run();
  }
});

function seedBlock({ hash = HASH, height = 967724, pool = 'Foundry USA' } = {}) {
  const race = db.instance
    .prepare(
      `INSERT INTO relay_race (block_hash, block_height, detected_at, pool_name, pool_tag, pool_source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(hash, height, 1_700_000_000_000, pool, 'Foundry USA Pool', 'address');
  const first = db.getOrCreatePeer('1.2.3.4:8333');
  const other = db.getOrCreatePeer('[2001:db8::1]:8333');
  db.instance
    .prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)')
    .run(race.lastInsertRowid, first.id, 1);
  db.instance
    .prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)')
    .run(race.lastInsertRowid, other.id, 0);
  return race.lastInsertRowid;
}

function seedRace(prevhashHex) {
  const own = db.instance
    .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 0, 0)`)
    .run('My pool', 'gobrrr-pool_ckpool_1', 3333);
  const public1 = db.instance
    .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 1, 0)`)
    .run('Public A', 'a.example', 3333);
  const quiet = db.instance
    .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 1, 0)`)
    .run('Quiet one', 'b.example', 3333);
  const race = db.instance
    .prepare(`INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)`)
    .run(prevhashHex, 1_700_000_000_000);
  const obs = db.instance.prepare(
    `INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, ?, ?)`,
  );
  obs.run(race.lastInsertRowid, public1.lastInsertRowid, 0, 1);
  obs.run(race.lastInsertRowid, own.lastInsertRowid, 412.5, 2);
  obs.run(race.lastInsertRowid, quiet.lastInsertRowid, null, null);
}

test('the three roles are separate, and each can be missing on its own', () => {
  seedBlock();
  const d = blocks.blockDetail();
  assert.equal(d.blockHeight, 967724);
  assert.equal(d.pool, 'Foundry');                       // mined it
  assert.deepEqual(d.firstPeers.map((p) => p.address), ['1.2.3.4:8333']); // delivered it
  assert.equal(d.eligible, 2);
  assert.equal(d.stratum, null);                         // nobody raced for it
});

// Stratum sends the same hash with the bytes inside each word reversed. The
// race and the block still have to find each other.
test('the stratum race is found through any encoding of the hash', () => {
  for (const encoding of prevhash.encodings(HASH)) {
    db.instance.prepare('DELETE FROM stratum_observation').run();
    db.instance.prepare('DELETE FROM stratum_race').run();
    db.instance.prepare('DELETE FROM stratum_pool').run();
    db.instance.prepare('DELETE FROM relay_observation').run();
    db.instance.prepare('DELETE FROM relay_race').run();
    seedBlock();
    seedRace(encoding);

    const d = blocks.blockDetail();
    assert.ok(d.stratum, `no race found for encoding ${encoding}`);
    assert.equal(d.stratum.entries.length, 3);
    assert.deepEqual(d.stratum.entries.map((e) => e.label), ['Public A', 'My pool', 'Quiet one']);
    assert.equal(d.stratum.entries[0].latencyMs, 0);
    assert.equal(d.stratum.entries[1].own, true, 'a pool the owner added is marked as his');
    assert.equal(d.stratum.entries[1].latencyMs, 412.5);
    // The pool that said nothing stays in the list rather than disappearing.
    assert.equal(d.stratum.entries[2].miss, true);
    assert.equal(d.stratum.entries[2].rank, null);
  }
});

test('a race for a different block is not attached to this one', () => {
  seedBlock();
  seedRace('f'.repeat(64));
  assert.equal(blocks.blockDetail().stratum, null);
});

test('more than one peer can be credited, and both are shown', () => {
  const raceId = seedBlock();
  const second = db.getOrCreatePeer('5.6.7.8:8333');
  db.instance
    .prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, 1)')
    .run(raceId, second.id);
  const d = blocks.blockDetail();
  assert.equal(d.firstPeers.length, 2, 'no winner is invented when Core credited two');
});
