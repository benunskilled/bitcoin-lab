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
const { manualAddPeer, resolveHostPort, formatAddress } = require('../src/lib/manual-peer');

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

// resolveHostPort is the part that decides whether a user-typed string
// carries an explicit port. IPv6 makes a naive trailing "/:(\d+)$/" split
// dangerous: it uses colons as hextet separators, so an address whose last
// hextet happens to look like a 2-5 digit decimal number (e.g. "::86") was
// previously chopped into a bogus host and a bogus "port".
test('resolveHostPort: IPv4 and hostnames, with and without an explicit port', () => {
  assert.deepEqual(resolveHostPort('203.0.113.5'), { addr: '203.0.113.5', port: null });
  assert.deepEqual(resolveHostPort('203.0.113.5:8333'), { addr: '203.0.113.5', port: 8333 });
  assert.deepEqual(resolveHostPort('node.example.com'), { addr: 'node.example.com', port: null });
  assert.deepEqual(resolveHostPort('node.example.com:9333'), { addr: 'node.example.com', port: 9333 });
});

test('resolveHostPort: bare IPv6 is never mistaken for host:port, even when the last hextet looks like a port', () => {
  // Regression cases: each of these has a last hextet that is 2-5 decimal
  // digits, which used to get sliced off as an explicit port.
  assert.deepEqual(resolveHostPort('2001:db8::86'), { addr: '2001:db8::86', port: null });
  assert.deepEqual(resolveHostPort('fe80::1234'), { addr: 'fe80::1234', port: null });
  assert.deepEqual(resolveHostPort('2001:db8:85a3::8a2e:370:7334'), { addr: '2001:db8:85a3::8a2e:370:7334', port: null });
  // And ordinary IPv6 that never triggered the old bug, for good measure.
  assert.deepEqual(resolveHostPort('2001:db8::1'), { addr: '2001:db8::1', port: null });
  assert.deepEqual(resolveHostPort('::1'), { addr: '::1', port: null });
});

test('resolveHostPort: bracketed IPv6 is the only form that can carry an explicit port', () => {
  assert.deepEqual(resolveHostPort('[2001:db8::1]:8333'), { addr: '2001:db8::1', port: 8333 });
  assert.deepEqual(resolveHostPort('[2001:db8::1]'), { addr: '2001:db8::1', port: null });
  assert.deepEqual(resolveHostPort('[::1]:9333'), { addr: '::1', port: 9333 });
});

test('formatAddress brackets an IPv6 addr the same way Core itself does, leaves IPv4/hostnames alone', () => {
  assert.equal(formatAddress('203.0.113.5', 8333), '203.0.113.5:8333');
  assert.equal(formatAddress('node.example.com', 8333), 'node.example.com:8333');
  assert.equal(formatAddress('2001:db8::1', 8333), '[2001:db8::1]:8333');
  assert.equal(formatAddress('::1', 9333), '[::1]:9333');
});

test('Add as Manual accepts bracketed IPv6 input end-to-end (previously rejected outright)', async () => {
  const server = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '::1', resolve);
  });
  const port = server.address().port;
  const input = `[::1]:${port}`;
  try {
    mock.method(rpc, 'getPeerInfo', async () => []);
    mock.method(rpc, 'disconnectNode', async () => {});
    mock.method(rpc, 'addNode', async () => {});

    const result = await manualAddPeer(input, 'ipv6 loopback');

    assert.equal(result.ok, true, result.error);
    // Bracketed, matching Core's own CService::ToStringAddrPort format -
    // this is what makes the trusted_peer <-> peer join in queries.js and
    // the disconnectIfLiveNonManual getpeerinfo comparison actually match.
    assert.equal(result.address, `[::1]:${port}`);
    const row = db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(`[::1]:${port}`);
    assert.ok(row, 'the IPv6 peer must be persisted as trusted, bracketed');
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
