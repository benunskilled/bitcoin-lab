'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-adoption-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
process.env.MAX_MANUAL_PEERS = '2';

const db = require('../src/lib/db');
const rpc = require('../src/lib/rpc');
const { adoptExternalManualPeers } = require('../src/lib/peer-sync');

test.before(() => {
  db.open();
});

test.afterEach(() => {
  mock.restoreAll();
  db.instance.exec('DELETE FROM trusted_peer;');
});

const rows = () => db.instance.prepare(`SELECT address, kept FROM trusted_peer ORDER BY address`).all();

test('an addnode somebody else configured is adopted as protected', async () => {
  // A -addnode= line in bitcoin.conf, or a peer set in Umbrel's own settings:
  // a person chose it. Adopted unprotected, the rotation would later be free
  // to `addnode remove` it - undoing a choice this app never made.
  mock.method(rpc, 'getAddedNodeInfo', async () => [{ addednode: '198.51.100.7:8333' }]);
  const result = await adoptExternalManualPeers();
  assert.equal(result.adopted, 1);
  assert.deepEqual(rows(), [{ address: '198.51.100.7:8333', kept: 1 }]);
});

test('adoption stops at the manual-peer limit and leaves the rest alone', async () => {
  db.instance
    .prepare(`INSERT INTO trusted_peer (address, label, kept, created_at) VALUES ('203.0.113.1:8333', NULL, 0, 1)`)
    .run();
  mock.method(rpc, 'getAddedNodeInfo', async () => [
    { addednode: '203.0.113.1:8333' },
    { addednode: '198.51.100.7:8333' },
    { addednode: '198.51.100.8:8333' },
    { addednode: '198.51.100.9:8333' },
  ]);
  const result = await adoptExternalManualPeers();
  assert.equal(result.adopted, 1, 'one free slot, one adoption');
  assert.equal(rows().length, 2, 'never more rows than MAX_MANUAL_PEERS');
  // Core's own list is handed on untouched; nothing was removed from it.
  assert.equal(result.addedNodes.length, 4);
});
