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
const { manualAddPeer, probePeer, resolveHostPort, formatAddress } = require('../src/lib/manual-peer');
const config = require('../src/lib/config');

test.before(() => {
  db.open();
});

test.afterEach(() => {
  mock.restoreAll();
  // Manual slots are now a finite resource that adds compete for, so a test
  // leaving its peer behind would silently change what the next one is
  // testing once the cap is reached.
  db.instance.exec('DELETE FROM trusted_peer; DELETE FROM parked_peer;');
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

test('Add as Manual clears an existing non-manual session before the addnode, not after', async () => {
  const { server, port } = await withListeningPort();
  const address = `127.0.0.1:${port}`;
  try {
    mock.method(rpc, 'getPeerInfo', async () => [{ addr: address, connection_type: 'outbound-full-relay' }]);
    const calls = [];
    mock.method(rpc, 'disconnectNode', async (addr) => { calls.push(`disconnect ${addr}`); });
    mock.method(rpc, 'addNode', async (addr, cmd) => { calls.push(`addnode ${cmd} ${addr}`); });

    const result = await manualAddPeer(address, 'test peer');

    assert.equal(result.ok, true);
    // The order is the point, and it is the opposite of what it used to be.
    // Core will not open an outbound connection to a host it is already
    // connected to, so an addnode issued while the old session is still up is
    // accepted and then never dials: the slot is spent on a connection that
    // does not exist. Clearing the way first is the only order that actually
    // produces a manual connection to a peer that dialled in - which is the
    // case this whole path exists for.
    //
    // The cost is real and accepted: a refused addnode now leaves the old
    // connection dropped (see the refusal test below). The old order avoided
    // that and did not work.
    assert.deepEqual(calls, [`disconnect ${address}`, `addnode add ${address}`]);
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

// --- Trying a peer must be free ---------------------------------------------
//
// The behaviour these lock down is the one that makes an inbound peer safe to
// experiment with: nothing at all happens until a TCP handshake has succeeded
// AND a manual slot is confirmed. An unreachable address must cost nothing -
// no row, no addnode, and above all no dropped connection.

test('an unreachable address changes nothing: no row, no addnode, no disconnect', async () => {
  const calls = [];
  mock.method(rpc, 'getPeerInfo', async () => [{ addr: '203.0.113.9:8333', connection_type: 'inbound' }]);
  mock.method(rpc, 'disconnectNode', async (addr) => { calls.push(`disconnect ${addr}`); });
  mock.method(rpc, 'addNode', async (addr, cmd) => { calls.push(`addnode ${cmd} ${addr}`); });

  // Nothing listens on 8333 or 9333 here, so every probe fails.
  const result = await manualAddPeer('127.0.0.1');

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], 'a failed probe must not touch Core at all');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 0);
});

test('Test reports the port a node actually answers on, and writes nothing', async () => {
  const { server, port } = await withListeningPort();
  try {
    const calls = [];
    mock.method(rpc, 'addNode', async (addr, cmd) => { calls.push(`addnode ${cmd} ${addr}`); });
    mock.method(rpc, 'disconnectNode', async (addr) => { calls.push(`disconnect ${addr}`); });

    const result = await probePeer(`127.0.0.1:${port}`);

    assert.equal(result.ok, true);
    assert.equal(result.address, `127.0.0.1:${port}`);
    assert.deepEqual(calls, [], 'testing reachability is not an action');
    assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 0);
  } finally {
    server.close();
  }
});

// A port that is definitely closed: bind one, note it, then let it go. Using
// a literal like ":1" would not exercise this path at all - resolveHostPort
// only reads 2-to-5-digit suffixes as ports, so a single digit falls through
// to the 8333/9333 search instead of probing the port named.
async function closedPort() {
  const { server, port } = await withListeningPort();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('Test says so plainly when nothing is listening on the port given', async () => {
  const port = await closedPort();
  const result = await probePeer(`127.0.0.1:${port}`);
  assert.equal(result.ok, false);
  assert.match(result.error, /not reachable/);
});

// --- The eight-slot cap -----------------------------------------------------

function fillManualSlots(n) {
  const stmt = db.instance.prepare('INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)');
  for (let i = 0; i < n; i++) {
    const address = `198.51.100.${i + 1}:8333`;
    const peer = db.getOrCreatePeer(address);
    // A record, so weakestTrustedPeer has something to rank them by: peer i
    // gets i firsts out of 200 eligible, making 198.51.100.1 the weakest.
    const race = db.instance.prepare('INSERT INTO relay_race (block_hash, detected_at) VALUES (?, ?)');
    const obs = db.instance.prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)');
    for (let r = 0; r < 200; r++) {
      const raceId = race.run(`cap-${i}-${r}-${Math.random()}`, Date.now()).lastInsertRowid;
      obs.run(raceId, peer.id, r < i ? 1 : 0);
    }
    db.instance
      .prepare('INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)')
      .run(peer.id, 'outbound', 'manual', Date.now() - 3600000);
    stmt.run(address, null, Date.now());
  }
}

test('adding a peer at capacity frees exactly one slot, and names what it dropped', async () => {
  const { server, port } = await withListeningPort();
  const address = `127.0.0.1:${port}`;
  try {
    fillManualSlots(config.maxManualPeers);
    mock.method(rpc, 'getPeerInfo', async () => []);
    mock.method(rpc, 'addNode', async () => {});
    mock.method(rpc, 'disconnectNode', async () => {});

    const result = await manualAddPeer(address);

    assert.equal(result.ok, true);
    // Still exactly eight - the ninth row that Core would never have been
    // told about is the bug this replaces.
    assert.equal(
      db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n,
      config.maxManualPeers,
    );
    assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(address).n, 1);
    // The weakest one, by record - not the oldest, not an arbitrary one.
    assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get('198.51.100.1:8333').n, 0);
    assert.match(result.warning, /198\.51\.100\.1:8333/, 'the user has to be told which peer paid for this');
    // And the peer that lost its slot is parked, so it can come back.
    assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get('198.51.100.1:8333').n, 1);
  } finally {
    server.close();
  }
});

test('a refused addnode leaves no trusted row behind, and the dropped session is the price', async () => {
  const { server, port } = await withListeningPort();
  const address = `127.0.0.1:${port}`;
  try {
    mock.method(rpc, 'getPeerInfo', async () => [{ addr: address, connection_type: 'inbound' }]);
    const disconnects = [];
    mock.method(rpc, 'disconnectNode', async (addr) => { disconnects.push(addr); });
    mock.method(rpc, 'addNode', async () => { throw new Error('Error: Node address is invalid'); });

    const result = await manualAddPeer(address);

    assert.equal(result.ok, false);
    assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(address).n, 0);
    // Nothing of ours moved - no row, no eviction. But the old session is
    // gone, and that is a genuine regression against the previous order,
    // written down here rather than left to be rediscovered: clearing the way
    // has to happen before the addnode or the addnode does not produce a
    // connection at all, so a refusal after it costs the connection. It is
    // bounded - this only runs when such a session exists, moments after a
    // successful handshake to the same host - and the peer dialled in once,
    // so it will dial in again.
    assert.deepEqual(disconnects, [address], 'the way was cleared before the addnode was refused');
  } finally {
    server.close();
  }
});

test('"Node already added" is the state we wanted, not a failure', async () => {
  const { server, port } = await withListeningPort();
  const address = `127.0.0.1:${port}`;
  try {
    mock.method(rpc, 'getPeerInfo', async () => []);
    mock.method(rpc, 'disconnectNode', async () => {});
    mock.method(rpc, 'addNode', async () => { throw new Error('Error: Node already added (code -23)'); });

    const result = await manualAddPeer(address);

    assert.equal(result.ok, true);
    assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(address).n, 1);
  } finally {
    server.close();
  }
});

test('an inbound session is found by host, not by its ephemeral address', async () => {
  // The bug this replaced. An inbound peer is added under the LISTENING
  // address the probe found, while its live session is reported under the
  // port it dialled from. Comparing the two strings never matched, so nothing
  // was disconnected and the node ended up connected twice to the same peer:
  // once inbound, once manual - with Core crediting delivered blocks to
  // whichever connection carried them, so the manual slot measured as
  // worthless while its twin did the work.
  const { server, port } = await withListeningPort();
  const address = `127.0.0.1:${port}`;
  try {
    mock.method(rpc, 'getPeerInfo', async () => [
      { id: 41, addr: '127.0.0.1:51234', connection_type: 'inbound', network: 'ipv4' },
    ]);
    const disconnects = [];
    mock.method(rpc, 'disconnectNode', async (target) => { disconnects.push(target); });
    mock.method(rpc, 'addNode', async () => {});

    await manualAddPeer(address);

    assert.deepEqual(disconnects, [41], 'by Core\'s own peer id, so the two spellings cannot disagree again');
  } finally {
    server.close();
  }
});

test('peers on a shared proxy network are never matched by host', async () => {
  // Every inbound Tor peer arrives from the same address - Umbrel's Tor
  // container. Matching by host there would disconnect the entire network's
  // worth of peers in one go, which is the accident this guard exists for.
  const { server, port } = await withListeningPort();
  const address = `127.0.0.1:${port}`;
  try {
    mock.method(rpc, 'getPeerInfo', async () => [
      { id: 1, addr: '127.0.0.1:52690', connection_type: 'inbound', network: 'onion' },
      { id: 2, addr: '127.0.0.1:52691', connection_type: 'inbound', network: 'i2p' },
    ]);
    const disconnects = [];
    mock.method(rpc, 'disconnectNode', async (target) => { disconnects.push(target); });
    mock.method(rpc, 'addNode', async () => {});

    await manualAddPeer(address);

    assert.deepEqual(disconnects, [], 'they share one address and are not the peer being added');
  } finally {
    server.close();
  }
});
