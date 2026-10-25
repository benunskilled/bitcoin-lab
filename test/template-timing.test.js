'use strict';

// getblocktemplate builds a whole block in Core - real CPU on a Raspberry Pi,
// at the moment a new block has just arrived. Its timing only means something
// beside Stratum Race, so with Stratum Race off it is not asked for at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-template-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const rpc = require('../src/lib/rpc');
const stratumRace = require('../src/lib/stratum-race-toggle');
const relay = require('../src/relay-profiler');

const now = Date.UTC(2026, 9, 3, 12);
let templateCalls = 0;

test.before(() => {
  db.open();
  rpc.getPeerInfo = async () => [{ addr: '198.51.100.1:8333', last_block: Math.floor(now / 1000) }];
  rpc.getBlockchainInfo = async () => ({ blocks: 1, headers: 1, initialblockdownload: false });
  rpc.getBlockHeader = async () => ({ confirmations: 1, height: 1 });
  rpc.getBlock = async () => { throw new Error('not in this test'); };
  rpc.timeCall = async () => { templateCalls += 1; return { count: 3 }; };
});

// Ten minutes apart, like real blocks: blocks seconds apart are a backlog.
const block = (i) => ({ blockHash: String(i).padStart(64, 'd'), detectedAtMs: now + i * 600_000, t0: process.hrtime.bigint() });
const settle = () => new Promise((r) => setTimeout(r, 20));

test('with Stratum Race off, no block template is requested', async () => {
  stratumRace.setEnabled(false);
  templateCalls = 0;
  await relay.handleHashBlock(block(1));
  await settle();
  assert.equal(templateCalls, 0);
  const row = db.instance.prepare('SELECT template_ms AS ms FROM relay_race WHERE block_hash = ?').get(block(1).blockHash);
  assert.equal(row.ms, null, 'and the block is still recorded, just without a template time');
});

test('with Stratum Race on, the template is timed as before', async () => {
  stratumRace.setEnabled(true);
  templateCalls = 0;
  await relay.handleHashBlock(block(2));
  await settle();
  assert.equal(templateCalls, 1);
  const row = db.instance.prepare('SELECT template_tx AS tx FROM relay_race WHERE block_hash = ?').get(block(2).blockHash);
  assert.equal(row.tx, 3);
});

test('while Core catches up, the blocks after the first get no template', async () => {
  // A full template for every old block is load on Core when it is busiest.
  stratumRace.setEnabled(true);
  rpc.getBlockchainInfo = async () => ({ blocks: 1, headers: 9, initialblockdownload: false });
  templateCalls = 0;
  const at = now + 3_600_000;
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await relay.handleHashBlock({ blockHash: String(10 + i).padStart(64, 'd'), detectedAtMs: at + i * 500, t0: process.hrtime.bigint() });
  }
  await settle();
  assert.equal(templateCalls, 1, 'only the first, before it is known to be a catch-up');
  rpc.getBlockchainInfo = async () => ({ blocks: 1, headers: 1, initialblockdownload: false });
});
