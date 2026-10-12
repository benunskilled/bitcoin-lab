'use strict';

// LAB_READ_ONLY=1 (a test copy beside the real app on the same node): nothing may
// change Core's peers - not the dashboard, not the rotation, not the background
// sync - and the browser link goes to the test Peer Map's port.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-ro-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
process.env.PEERMAP_HEALTH_URL = 'off';
process.env.LAB_READ_ONLY = '1';
process.env.PEERMAP_LINK_PORT = '8795';
// Nothing listens here: a call that reached Core would fail.
process.env.BITCOIN_RPC_HOST = '127.0.0.1';
process.env.BITCOIN_RPC_PORT = '9';

const config = require('../src/lib/config');
const db = require('../src/lib/db');
const rpc = require('../src/lib/rpc');
const peerRotation = require('../src/lib/peer-rotation');
const { server } = require('../src/dashboard-server');

let baseUrl;

test.before(async () => {
  db.open();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function post(pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('config reads the read-only flag and the link port', () => {
  assert.equal(config.readOnly, true);
  assert.equal(config.peerMapLinkPort, 8795);
});

test('addnode and disconnectnode are never sent to Core', async () => {
  assert.equal(await rpc.addNode('203.0.113.5:8333', 'add'), null);
  assert.equal(await rpc.addNode('203.0.113.5:8333', 'remove'), null);
  assert.equal(await rpc.disconnectNode('203.0.113.5:8333'), null);
  assert.equal(await rpc.disconnectNode(7), null);
});

test('the rotation counts as off, whatever the database says', () => {
  peerRotation.setEnabled(true);
  assert.equal(peerRotation.isEnabled(), false);
});

test('peer-changing routes answer 403', async () => {
  for (const p of ['/api/peers/untrust', '/api/peers/manual-add', '/api/peers/add-manual', '/api/peers/disconnect', '/api/rotation/toggle']) {
    const { status, body } = await post(p, { address: '203.0.113.5:8333', enabled: true });
    assert.equal(status, 403, p);
    assert.match(body.error, /read-only/);
  }
});

test('/api/status tells the page it is read-only and which Peer Map port to link', async () => {
  const s = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(s.readOnly, true);
  assert.equal(s.peerMapLinkPort, 8795);
});
