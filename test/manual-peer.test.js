'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

// Point at a throwaway SQLite file before any app module is required, so
// config.js/db.js pick it up at module-load time.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-manual-peer-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const rpc = require('../src/lib/rpc');
const { manualAddPeer } = require('../src/lib/manual-peer');

test.before(() => {
  db.open();
});

test.afterEach(() => {
  mock.restoreAll();
});

// A real local listener so manualAddPeer's TCP probe succeeds without
// touching the network - explicit ":port" input skips the 8333/9333 scan
// and probes exactly this address.
function withListeningPort() {
  return new Promise((resolve) => {
    const server = net.createServer(() => {});
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

test('Add as Manual disconnects an already-connected non-manual session before persisting trust', async () => {
  const { server, port } = await withListeningPort();
  const address = `127.0.0.1:${port}`;
  try {
    mock.method(rpc, 'getPeerInfo', async () => [{ addr: address, connection_type: 'outbound-full-relay' }]);
    const disconnectCalls = [];
    mock.method(rpc, 'disconnectNode', async (addr) => { disconnectCalls.push(addr); });
    mock.method(rpc, 'addNode', async () => {});

    const result = await manualAddPeer(address, 'test peer');

    assert.equal(result.ok, true);
    assert.deepEqual(disconnectCalls, [address], 'the existing non-manual session must be disconnected first');
    const row = db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(address);
    assert.ok(row, 'the peer must still end up persisted as trusted after the disconnect');
  } finally {
    server.close();
  }
});

test('Add as Manual does not disconnect a session that is already manual', async () => {
  const { server, port } = await withListeningPort();
  const address = `127.0.0.1:${port}`;
  try {
    mock.method(rpc, 'getPeerInfo', async () => [{ addr: address, connection_type: 'manual' }]);
    const disconnectCalls = [];
    mock.method(rpc, 'disconnectNode', async (addr) => { disconnectCalls.push(addr); });
    mock.method(rpc, 'addNode', async () => {});

    const result = await manualAddPeer(address, 'already manual');

    assert.equal(result.ok, true);
    assert.deepEqual(disconnectCalls, [], 'an already-manual session must not be churned');
  } finally {
    server.close();
  }
});

test('Add as Manual does not disconnect anything when the address is not currently live', async () => {
  const { server, port } = await withListeningPort();
  const address = `127.0.0.1:${port}`;
  try {
    mock.method(rpc, 'getPeerInfo', async () => []);
    const disconnectCalls = [];
    mock.method(rpc, 'disconnectNode', async (addr) => { disconnectCalls.push(addr); });
    mock.method(rpc, 'addNode', async () => {});

    const result = await manualAddPeer(address, 'offline peer');

    assert.equal(result.ok, true);
    assert.deepEqual(disconnectCalls, [], 'nothing to disconnect for a peer Core does not currently show as connected');
  } finally {
    server.close();
  }
});

test('a getpeerinfo failure does not block adding the peer as manual', async () => {
  const { server, port } = await withListeningPort();
  const address = `127.0.0.1:${port}`;
  try {
    mock.method(rpc, 'getPeerInfo', async () => { throw new Error('rpc unreachable'); });
    const disconnectCalls = [];
    mock.method(rpc, 'disconnectNode', async (addr) => { disconnectCalls.push(addr); });
    mock.method(rpc, 'addNode', async () => {});

    const result = await manualAddPeer(address, 'rpc down');

    assert.equal(result.ok, true);
    assert.deepEqual(disconnectCalls, []);
    const row = db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(address);
    assert.ok(row, 'the add must still succeed even if the live-session check itself failed');
  } finally {
    server.close();
  }
});
