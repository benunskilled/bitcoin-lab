'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-recon-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const blocks = require('../src/lib/queries/blocks');
const relay = require('../src/relay-profiler');
const { snapshot, classify, HEADER_BYTES } = require('../src/lib/reconstruction');

test.before(() => db.open());

// A peer as getpeerinfo reports it, with only the counters that matter here.
const peer = (id, { sent = {}, recv = {}, conntime = 1000 } = {}) => ({
  id, addr: `10.0.0.${id}:8333`, conntime, bytessent_per_msg: sent, bytesrecv_per_msg: recv,
});

test('a compact block with nothing to ask for came from the mempool', () => {
  const before = snapshot([peer(1, { recv: { cmpctblock: 5000 } })], 2_000_000);
  const after = [peer(1, { recv: { cmpctblock: 9000 } })];
  assert.deepEqual(classify(before, after), { kind: 'mempool', missingBytes: 0, askedPeers: [] });
});

test('getblocktxn going out means Core asked; blocktxn coming back is what was missing', () => {
  const before = snapshot([peer(1, { recv: { cmpctblock: 5000 } }), peer(2)], 2_000_000);
  const after = [
    peer(1, { sent: { getblocktxn: 60 }, recv: { cmpctblock: 9000, blocktxn: 24 + 38000 } }),
    peer(2, { recv: { cmpctblock: 4000 } }), // a low-bandwidth copy, nothing asked of it
  ];
  const r = classify(before, after);
  assert.equal(r.kind, 'asked');
  assert.equal(r.missingBytes, 38000);
  assert.deepEqual(r.askedPeers, ['10.0.0.1:8333']);
});

test('two peers asked for the same transactions count once: the largest answer', () => {
  const before = snapshot([peer(1), peer(2)], 2_000_000);
  const after = [
    peer(1, { sent: { getblocktxn: 60 }, recv: { cmpctblock: 9000, blocktxn: HEADER_BYTES + 40000 } }),
    peer(2, { sent: { getblocktxn: 60 }, recv: { cmpctblock: 9000, blocktxn: HEADER_BYTES + 39000 } }),
  ];
  const r = classify(before, after);
  assert.equal(r.missingBytes, 40000);
  assert.deepEqual(r.askedPeers, ['10.0.0.1:8333', '10.0.0.2:8333']);
});

test('a block downloaded whole, with no compact block, is told apart', () => {
  const before = snapshot([peer(1)], 2_000_000);
  assert.equal(classify(before, [peer(1, { recv: { block: 1_500_000 } })]).kind, 'full');
});

// Block 975049: Core's log said rebuilt from the mempool, nothing requested;
// a peer had pushed the whole block unasked, and the counters said "full".
// Block 975133 the same, with the whole block from a peer that had also sent
// a compact block - so beside any compact block, a whole block never counts.
test('a whole block beside a compact block does not count, whoever sent it', () => {
  const before = snapshot([peer(1), peer(2)], 2_000_000);
  const pushed = { subver: '/Satoshi:23.0.0/', connectionType: 'inbound', bytes: 1_500_000 };
  for (const after of [
    [peer(1, { recv: { cmpctblock: 9000 } }), peer(2, { recv: { block: 1_500_000 } })],
    [peer(1, { recv: { cmpctblock: 9000 } }), peer(2, { recv: { cmpctblock: 9000, block: 1_500_000 } })],
  ]) {
    after[1].subver = pushed.subver;
    after[1].connection_type = pushed.connectionType;
    assert.deepEqual(classify(before, after), { kind: 'mempool', missingBytes: 0, askedPeers: [], ignoredWholeBlocks: [pushed] });
  }
  const asked = [
    peer(1, { sent: { getblocktxn: 60 }, recv: { cmpctblock: 9000, blocktxn: HEADER_BYTES + 800, block: 1_500_000 } }),
    peer(2, { recv: { block: 1_500_000 } }),
  ];
  const r = classify(before, asked);
  assert.equal(r.kind, 'asked', 'not "unclear" any more: Core asked, and that is what the log showed');
  assert.equal(r.missingBytes, 800);
  assert.equal(r.ignoredWholeBlocks.length, 2);
});

// Found by an outside review: a late blocktxn for the block before and a
// whole block from another peer read as "asked", with the previous block's
// bytes on this one. The counters cannot tell that from a rebuild that failed
// after asking, so it is neither.
test('asked and a whole block with no compact block is unclear, with no bytes put on the block', () => {
  const before = snapshot([peer(1), peer(2)], 2_000_000);
  const after = [
    peer(1, { sent: { getblocktxn: 60 }, recv: { blocktxn: HEADER_BYTES + 10000 } }),
    peer(2, { recv: { block: 1_500_000 } }),
  ];
  const r = classify(before, after);
  assert.equal(r.kind, 'unclear');
  assert.equal(r.missingBytes, null);
});

test('without a snapshot of the block before, or with nothing new, it cannot be told', () => {
  assert.equal(classify(null, [peer(1, { recv: { cmpctblock: 1 } })]), null);
  const before = snapshot([peer(1, { recv: { cmpctblock: 5 } })], 2_000_000);
  assert.equal(classify(before, [peer(1, { recv: { cmpctblock: 5 } })]), null);
});

test('a connection opened since counts from zero; an older one missing from the snapshot is left out', () => {
  const before = snapshot([], 2_000_000);
  const fresh = peer(7, { conntime: 2_100, sent: { getblocktxn: 40 }, recv: { blocktxn: HEADER_BYTES + 100 } });
  assert.equal(classify(before, [fresh]).kind, 'asked');
  const old = peer(8, { conntime: 1_000, sent: { getblocktxn: 40 }, recv: { blocktxn: 900 } });
  assert.equal(classify(before, [old]), null);
});

test('the counters at the start tell the first block; a block that came first is not overwritten', async () => {
  const rpc = require('../src/lib/rpc');
  const saved = { getPeerInfo: rpc.getPeerInfo, getBlockchainInfo: rpc.getBlockchainInfo };
  rpc.getPeerInfo = async () => [peer(1, { recv: { cmpctblock: 100 } })];
  rpc.getBlockchainInfo = async () => ({ blocks: 49 });
  try {
    await relay.takeStartSnapshot(1_500_000);
    const p = [peer(1, { recv: { cmpctblock: 200 } })];
    assert.equal(relay.reconstructionOf(p, { height: 50 }, 1_600_000).kind, 'mempool');
    // The snapshot of block 50 is newer than anything the start could bring.
    await relay.takeStartSnapshot(1_700_000);
    const p51 = [peer(1, { recv: { cmpctblock: 300 } })];
    assert.equal(relay.reconstructionOf(p51, { height: 51 }, 1_800_000).kind, 'mempool');
  } finally {
    Object.assign(rpc, saved);
  }
});

test('only the snapshot of the block right before is compared with', () => {
  const p0 = [peer(1, { recv: { cmpctblock: 100 } })];
  relay.reconstructionOf(p0, { height: 100 }, 2_000_000);
  const p1 = [peer(1, { recv: { cmpctblock: 200 } })];
  assert.equal(relay.reconstructionOf(p1, { height: 101 }, 2_600_000).kind, 'mempool');
  // 102 never came: 103 is not compared with 101.
  const p3 = [peer(1, { recv: { cmpctblock: 400 } })];
  assert.equal(relay.reconstructionOf(p3, { height: 103 }, 3_800_000), null);
  // Without a header the height is unknown, and so is the next comparison.
  assert.equal(relay.reconstructionOf(p3, null, 4_000_000), null);
  assert.equal(relay.reconstructionOf(p3, { height: 104 }, 4_100_000), null);
});

test('the day and the week count each kind and averages what was missing when asked', () => {
  db.instance.prepare(`DELETE FROM relay_observation`).run();
  db.instance.prepare(`DELETE FROM relay_race`).run();
  const now = 1_800_000_000_000;
  const add = (i, recon, bytes, at = now - i * 600_000) => db.instance
    .prepare(`INSERT INTO relay_race (block_hash, detected_at, recon, recon_missing_bytes) VALUES (?, ?, ?, ?)`)
    .run(`h${i}`, at, recon, bytes);
  assert.equal(blocks.reconstructionWeek(now), null);
  add(1, 'mempool', 0);
  add(2, 'asked', 30000);
  add(3, 'asked', 50000);
  add(4, 'full', null);
  add(5, null, null); // not told: left out
  add(6, 'asked', 999999, now - 8 * 24 * 3600 * 1000); // older than a week
  assert.deepEqual(blocks.reconstructionWeek(now), { blocks: 4, mempool: 1, asked: 2, full: 1, askedAvgBytes: 40000 });
  // The day holds the four within the last hours, not the one from last week.
  assert.deepEqual(blocks.reconstructionDay(now), { blocks: 4, mempool: 1, asked: 2, full: 1, askedAvgBytes: 40000 });
  add(7, 'mempool', 0, now - 2 * 24 * 3600 * 1000);
  assert.equal(blocks.reconstructionDay(now + 60_000).blocks, 4);
  assert.equal(blocks.reconstructionWeek(now + 60_000).blocks, 5);
});

test('the block size comes from the getblock the pool attribution reads anyway', async () => {
  const rpc = require('../src/lib/rpc');
  const saved = { getBlock: rpc.getBlock, getRawTransaction: rpc.getRawTransaction };
  rpc.getBlock = async () => ({ size: 1_163_355, tx: ['cb'] });
  rpc.getRawTransaction = async () => ({ vin: [{ coinbase: '' }], vout: [] });
  try {
    const { lastInsertRowid } = db.instance
      .prepare(`INSERT INTO relay_race (block_hash, detected_at) VALUES ('sized', 1)`).run();
    await relay.attributePool(lastInsertRowid, 'sized');
    assert.equal(db.instance.prepare(`SELECT block_size AS s FROM relay_race WHERE id = ?`).get(lastInsertRowid).s, 1_163_355);
  } finally {
    Object.assign(rpc, saved);
  }
});

test('the last hundred blocks: of those, the ones that could be told', () => {
  db.instance.prepare(`DELETE FROM relay_observation`).run();
  db.instance.prepare(`DELETE FROM relay_race`).run();
  const add = (i, recon, bytes) => db.instance
    .prepare(`INSERT INTO relay_race (block_hash, detected_at, recon, recon_missing_bytes) VALUES (?, ?, ?, ?)`)
    .run(`l${i}`, 1_000 + i, recon, bytes);
  assert.equal(blocks.reconstructionLast(), null);
  add(0, 'asked', 999999); // falls out of the window below
  for (let i = 1; i <= 97; i++) add(i, 'mempool', 0);
  add(98, 'asked', 20000);
  add(99, null, null); // not told
  add(100, 'asked', 40000);
  assert.deepEqual(blocks.reconstructionLast(), { blocks: 99, mempool: 97, asked: 2, full: 0, askedAvgBytes: 30000 });
  assert.equal(blocks.reconstructionLast(3).blocks, 2);
});

test('an unclear block is left out of the shares, like one that was not told', () => {
  db.instance.prepare(`DELETE FROM relay_observation`).run();
  db.instance.prepare(`DELETE FROM relay_race`).run();
  const add = (i, recon, bytes) => db.instance
    .prepare(`INSERT INTO relay_race (block_hash, detected_at, recon, recon_missing_bytes) VALUES (?, ?, ?, ?)`)
    .run(`u${i}`, Date.now() - 1000 + i, recon, bytes);
  add(1, 'mempool', 0);
  add(2, 'asked', 20000);
  add(3, 'unclear', null);
  assert.deepEqual(blocks.reconstructionLast(), { blocks: 2, mempool: 1, asked: 1, full: 0, askedAvgBytes: 20000 });
  assert.equal(blocks.reconstructionDay().blocks, 2);
});
