'use strict';

// A node catching up after being offline fetches the missing blocks from many
// peers at once; those hashblocks are not races and must not be scored.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-catchup-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const rpc = require('../src/lib/rpc');
const relay = require('../src/relay-profiler');

const now = Date.UTC(2026, 9, 2, 12);
const peers = [
  { addr: '198.51.100.1:8333', last_block: Math.floor(now / 1000) },
  { addr: '198.51.100.2:8333', last_block: Math.floor(now / 1000) },
];

let chain;
let header = { confirmations: 1 };
test.before(() => {
  db.open();
  rpc.getPeerInfo = async () => peers;
  rpc.getBlockchainInfo = async () => chain;
  rpc.timeCall = async () => ({ count: 0 });
  rpc.getBlockHeader = async () => header;
  rpc.getBlock = async () => { throw new Error('not in this test'); };
});
test.beforeEach(() => {
  db.instance.prepare('DELETE FROM relay_observation').run();
  db.instance.prepare('DELETE FROM relay_race').run();
});

const races = () => db.instance.prepare('SELECT COUNT(*) AS n FROM relay_race').get().n;
// Ten minutes apart, like real blocks - a block seconds after a skipped one counts as the tail of the catch-up.
const block = (i, atMs = now + i * 600_000) => ({ blockHash: String(i).padStart(64, 'c'), detectedAtMs: atMs, t0: process.hrtime.bigint() });

test('isCatchingUp: headers ahead of blocks, or initial block download', () => {
  assert.equal(relay.isCatchingUp({ blocks: 900, headers: 905, initialblockdownload: false }), true);
  assert.equal(relay.isCatchingUp({ blocks: 900, headers: 900, initialblockdownload: true }), true);
  assert.equal(relay.isCatchingUp({ blocks: 900, headers: 900, initialblockdownload: false }), false);
  // Without an answer from Core the block is counted, as it always was.
  assert.equal(relay.isCatchingUp(null), false);
});

test('isCatchingUp: a block with more blocks already on top of it', () => {
  // Core connects a backlog faster than the question comes back: the chain
  // looks synced, but this block is already buried.
  const synced = { blocks: 930, headers: 930, initialblockdownload: false };
  assert.equal(relay.isCatchingUp(synced, { confirmations: 29 }), true);
  assert.equal(relay.isCatchingUp(synced, { confirmations: 1 }), false);
  // A block that lost a reorg race reports -1: it still arrived, still counts.
  assert.equal(relay.isCatchingUp(synced, { confirmations: -1 }), false);
});

test('a buried block is not scored, even with the chain looking synced', async () => {
  chain = { blocks: 930, headers: 930, initialblockdownload: false };
  header = { confirmations: 12 };
  await relay.handleHashBlock(block(4));
  assert.equal(races(), 0);
  header = { confirmations: 1 };
});

test('a block arriving while Core catches up is not scored', async () => {
  chain = { blocks: 900, headers: 910, initialblockdownload: false };
  await relay.handleHashBlock(block(1));
  assert.equal(races(), 0);
});

test('a block at the tip is scored as before', async () => {
  chain = { blocks: 910, headers: 910, initialblockdownload: false };
  await relay.handleHashBlock(block(2));
  assert.equal(races(), 1);
});

test('if getblockchaininfo fails, the block is still scored', async () => {
  rpc.getBlockchainInfo = async () => { throw new Error('timeout'); };
  await relay.handleHashBlock(block(3));
  assert.equal(races(), 1);
});

test('the block that ends a catch-up is not scored either, a block minutes later is', async () => {
  rpc.getBlockchainInfo = async () => chain;
  const t = now + 100 * 600_000;
  chain = { blocks: 990, headers: 1000, initialblockdownload: false };
  header = { confirmations: 1 };
  await relay.handleHashBlock(block(100, t));            // backlog
  chain = { blocks: 1000, headers: 1000, initialblockdownload: false };
  await relay.handleHashBlock(block(101, t + 2000));     // the tip, same burst
  assert.equal(races(), 0);
  await relay.handleHashBlock(block(102, t + 9 * 60_000)); // the next real block
  assert.equal(races(), 1);
});
