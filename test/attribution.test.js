'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-attribution-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const blocks = require('../src/lib/queries/blocks');
const relay = require('../src/relay-profiler');

test.before(() => db.open());
test.beforeEach(() => {
  db.instance.prepare('DELETE FROM relay_observation').run();
  db.instance.prepare('DELETE FROM relay_race').run();
});

// A peer as getpeerinfo reports it: last_block is unix SECONDS.
function peer(addr, lastBlockMs) {
  return { addr, last_block: Math.floor(lastBlockMs / 1000) };
}

// Record `count` blocks ten minutes apart. `skewMs` is what Core's clock is
// wrong by: negative means Core is behind this app, which is the case that
// credits nobody.
function recordBlocks(count, skewMs, { startAt = Date.UTC(2026, 0, 1), pad = 'a' } = {}) {
  for (let i = 0; i < count; i += 1) {
    const detectedAtMs = startAt + i * 600_000;
    relay.recordRace({
      blockHash: String(i).padStart(64, pad),
      detectedAtMs,
      peers: [
        // The one that delivered it: its last_block IS this block, as Core's
        // clock sees it.
        peer('198.51.100.1:8333', detectedAtMs + skewMs),
        // Two that did not - their last_block is the previous block.
        peer('198.51.100.2:8333', detectedAtMs + skewMs - 600_000),
        peer('198.51.100.3:8333', detectedAtMs + skewMs - 600_000),
      ],
    });
  }
}

test('the window and the diagnosis agree on what "close enough" means', () => {
  // The profiler matches against its own window; the diagnosis decides whether
  // a miss is the clock's fault using the same number. They live in different
  // files on purpose - see blocks.js - so this is what stops them drifting.
  assert.equal(blocks.ATTRIBUTION_WINDOW_MS, relay.FIRST_WINDOW_MS);
});

test('with the clocks agreeing, one peer is credited per block and nothing is reported', () => {
  recordBlocks(20, 0);
  const rows = db.instance.prepare('SELECT first_count AS fc, nearest_delta_ms AS d FROM relay_race').all();
  assert.equal(rows.length, 20);
  assert.ok(rows.every((r) => r.fc === 1), 'exactly one peer credited for every block');
  assert.ok(rows.every((r) => Math.abs(r.d) < 1000), 'and the nearest last_block is within a second');

  const health = blocks.attributionHealth();
  assert.equal(health.ok, true);
  assert.equal(health.reason, null);
});

test('a five-second clock difference credits nobody, and is named as the cause', () => {
  // The whole point. Everything else about this node looks healthy: blocks
  // arrive, peers are recorded, the counter climbs. First % just never moves.
  recordBlocks(20, -5000);

  const rows = db.instance.prepare('SELECT first_count AS fc FROM relay_race').all();
  assert.ok(rows.every((r) => r.fc === 0), 'not one peer is credited');

  const health = blocks.attributionHealth();
  assert.equal(health.ok, false);
  assert.equal(health.reason, 'clock');
  assert.equal(health.blocks, 3, 'the diagnosis reads the last three, not everything');
  assert.ok(health.skewMs < -4000 && health.skewMs > -6000, `skew reported as ${health.skewMs}`);
});

test('the sign says which way round it is', () => {
  recordBlocks(20, 5000);
  const health = blocks.attributionHealth();
  assert.equal(health.reason, 'clock');
  assert.ok(health.skewMs > 4000, 'Core ahead reads positive');
});

test('a run of misses with the clocks fine is reported without blaming them', () => {
  // Peers whose last_block is old - nobody delivered anything recently. That
  // is a fault, but not this one, and telling somebody to check a clock that
  // is correct costs them an afternoon.
  const startAt = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 20; i += 1) {
    const detectedAtMs = startAt + i * 600_000;
    relay.recordRace({
      blockHash: String(i).padStart(64, 'b'),
      detectedAtMs,
      // Inside the matching window but past the one-second allowance for a
      // last_block in the future, so nobody is credited - and 2 seconds is not
      // a clock-sized discrepancy.
      peers: [peer('198.51.100.9:8333', detectedAtMs + 2000)],
    });
  }
  const health = blocks.attributionHealth();
  assert.equal(health.ok, false);
  assert.equal(health.reason, 'unknown');
  assert.equal(health.skewMs, null, 'no number is put on a cause that has not been established');
});

test('too few blocks is not a verdict', () => {
  // A fresh install. Nothing here is evidence of anything yet.
  recordBlocks(2, -5000);
  const health = blocks.attributionHealth();
  assert.equal(health.ok, true, 'two blocks cannot condemn anything');
  assert.equal(health.blocks, 2);
});

test('three is enough, and it is the third that decides', () => {
  // Three because across 2,206 blocks on a live node the number with nobody
  // credited was zero. Two would survive the arithmetic too and is still the
  // wrong number: the arithmetic assumes misses are independent, and the
  // things that cause them hit adjacent blocks.
  recordBlocks(2, -5000);
  assert.equal(blocks.attributionHealth().ok, true, 'two is not yet a verdict');
  recordBlocks(3, -5000, { startAt: Date.UTC(2026, 0, 3), pad: 'e' });
  assert.equal(blocks.attributionHealth().ok, false, 'three is');
});

test('one credited block in the sample is enough to stay quiet', () => {
  recordBlocks(19, -5000);
  recordBlocks(1, 0, { startAt: Date.UTC(2026, 0, 2), pad: 'd' });
  assert.equal(blocks.attributionHealth().ok, true, 'attribution is evidently working sometimes');
});

test('rows written before this existed are ignored rather than counted as failures', () => {
  // What every existing install looks like the moment it updates: thousands of
  // races with no first_count at all. Read as zeroes they would raise the
  // alarm on a node that is working perfectly.
  db.instance
    .prepare(`INSERT INTO relay_race (block_hash, detected_at, first_count, nearest_delta_ms) VALUES (?, ?, NULL, NULL)`)
    .run('c'.repeat(64), Date.now());
  const health = blocks.attributionHealth();
  assert.equal(health.blocks, 0);
  assert.equal(health.ok, true);
});

test('nearestLastBlockDeltaMs ignores peers with no usable last_block', () => {
  const now = Date.UTC(2026, 0, 1);
  const delta = relay.nearestLastBlockDeltaMs(
    [
      { addr: 'a', last_block: 0 },
      { addr: 'b' },
      { addr: 'c', last_block: null },
      { addr: 'd', last_block: Math.floor((now - 900) / 1000) },
    ],
    now,
  );
  assert.equal(delta, -1000, 'the second-resolution floor, not the raw 900ms');
  assert.equal(relay.nearestLastBlockDeltaMs([{ addr: 'a' }], now), null, 'nothing usable is null, not zero');
});
