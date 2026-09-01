'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point at a throwaway SQLite file and a small manual-peer cap before any
// app module is required, so config.js/db.js pick both up at module-load
// time - a cap of 2 keeps the promote/swap tests small instead of needing
// 8 seeded manual peers to exercise the "slots full" branch.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-peer-rotation-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';
process.env.MAX_MANUAL_PEERS = '2';

const db = require('../src/lib/db');
const rpc = require('../src/lib/rpc');
const manualPeer = require('../src/lib/manual-peer');
const queries = require('../src/lib/queries');
const peerRotation = require('../src/lib/peer-rotation');

test.before(() => {
  db.open();
});

test.beforeEach(() => {
  // Default: Core reports nothing live via RPC (peer-sync's
  // disconnectIfLiveNonManual then simply no-ops) and every mutating RPC
  // call succeeds - individual tests override/inspect these as needed.
  mock.method(rpc, 'getPeerInfo', async () => []);
  mock.method(rpc, 'addNode', async () => {});
  mock.method(rpc, 'disconnectNode', async () => {});
});

test.afterEach(() => {
  mock.restoreAll();
  // Full reset between tests except `meta` (migration flags, pools_seeded) -
  // each test that cares about the rotation-enabled flag sets/resets it
  // itself via setEnabled().
  // Children before parents - db.js turns on `foreign_keys = ON`, and
  // peer_session/relay_observation/peer_relay_stats all reference peer(id).
  db.instance.exec(`
    DELETE FROM peer_session;
    DELETE FROM relay_observation;
    DELETE FROM peer_relay_stats;
    DELETE FROM relay_race;
    DELETE FROM trusted_peer;
    DELETE FROM rotation_log;
    DELETE FROM peer;
  `);
});

let addrCounter = 0;
function nextAddress() {
  addrCounter += 1;
  return `203.0.113.${addrCounter}:8333`;
}

let raceCounter = 0;
function seedEligibility(peerId, eligible, first) {
  const insertRace = db.instance.prepare('INSERT INTO relay_race (block_hash, detected_at) VALUES (?, ?)');
  const insertObs = db.instance.prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)');
  for (let i = 0; i < eligible; i++) {
    raceCounter += 1;
    const raceId = insertRace.run(`rotation-race-${raceCounter}`, Date.now()).lastInsertRowid;
    insertObs.run(raceId, peerId, i < first ? 1 : 0);
  }
}

// Builds a peer with an open (live) session and, optionally, lifetime
// relay-observation history and/or trusted-peer status - everything
// peerRanking() reads from. Returns the address so callers don't need to
// know the peer's internal row id.
function seedLivePeer({
  address = nextAddress(),
  direction = 'outbound',
  connectionType = 'outbound-full-relay',
  eligible = 0,
  first = 0,
  trusted = false,
} = {}) {
  const peer = db.getOrCreatePeer(address);
  db.instance
    .prepare('INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)')
    .run(peer.id, direction, connectionType, Date.now() - 3600000);
  seedEligibility(peer.id, eligible, first);
  if (trusted) {
    db.instance.prepare('INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)').run(address, null, Date.now());
  }
  return address;
}

// A trusted peer that is NOT currently connected: a trusted_peer row plus a
// closed session, which is exactly what Core retrying a manual peer that went
// dark looks like from here.
function seedOfflineTrustedPeer({ address = nextAddress(), eligible = 0, first = 0 } = {}) {
  const peer = db.getOrCreatePeer(address);
  db.instance
    .prepare('INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at) VALUES (?, ?, ?, ?, ?)')
    .run(peer.id, 'outbound', 'manual', Date.now() - 7200000, Date.now() - 3600000);
  seedEligibility(peer.id, eligible, first);
  db.instance.prepare('INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)').run(address, null, Date.now());
  return address;
}

function ranking() {
  return queries.peerRanking();
}

test('kicks a 0-first-seen outbound peer once it clears the eligibility threshold', async () => {
  const address = seedLivePeer({ eligible: 144, first: 0 });
  const disconnected = [];
  rpc.disconnectNode.mock.mockImplementation(async (addr) => { disconnected.push(addr); });

  const kicked = await peerRotation.kickDeadWeight(ranking());

  assert.equal(kicked, 1);
  assert.deepEqual(disconnected, [address]);
  const logRow = db.instance.prepare('SELECT * FROM rotation_log WHERE action = ?').get('kick');
  assert.equal(logRow.address, address);
  assert.equal(logRow.eligible, 144);
});

test('ignores a feeler even if it somehow racked up enough eligible blocks', async () => {
  seedLivePeer({ connectionType: 'feeler', eligible: 200, first: 0 });
  const disconnected = [];
  rpc.disconnectNode.mock.mockImplementation(async (addr) => { disconnected.push(addr); });

  const kicked = await peerRotation.kickDeadWeight(ranking());

  assert.equal(kicked, 0);
  assert.deepEqual(disconnected, []);
});

test('does not kick a peer that has not reached the eligibility threshold yet', async () => {
  seedLivePeer({ eligible: 143, first: 0 });
  const kicked = await peerRotation.kickDeadWeight(ranking());
  assert.equal(kicked, 0);
});

test('does not kick a peer that has delivered at least one block first', async () => {
  seedLivePeer({ eligible: 144, first: 1 });
  const kicked = await peerRotation.kickDeadWeight(ranking());
  assert.equal(kicked, 0);
});

test('does not kick an already-trusted peer no matter how it performs', async () => {
  seedLivePeer({ eligible: 144, first: 0, trusted: true });
  const kicked = await peerRotation.kickDeadWeight(ranking());
  assert.equal(kicked, 0);
});

test('promotes the best candidate into a free manual slot', async () => {
  // MAX_MANUAL_PEERS is 2 and nothing is trusted yet - both slots are free.
  const address = seedLivePeer({ eligible: 144, first: 50 });

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 1);
  const row = db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(address);
  assert.ok(row, 'candidate must be persisted as trusted');
  const logRow = db.instance.prepare('SELECT * FROM rotation_log WHERE action = ?').get('promote');
  assert.equal(logRow.address, address);
  assert.ok(logRow.first_pct > 0);
});

test('does not promote a candidate that has not reached the eligibility threshold', async () => {
  seedLivePeer({ eligible: 143, first: 50 });
  const promoted = await peerRotation.promoteBestCandidate(ranking());
  assert.equal(promoted, 0);
});

test('does not promote a candidate with a 0% first-seen rate', async () => {
  seedLivePeer({ eligible: 144, first: 0 });
  const promoted = await peerRotation.promoteBestCandidate(ranking());
  assert.equal(promoted, 0);
});

test('swaps a strictly-better candidate in for the weakest manual peer once slots are full', async () => {
  const weak = seedLivePeer({ eligible: 144, first: 10, trusted: true }); // ~6.9%
  const strong = seedLivePeer({ eligible: 144, first: 100, trusted: true }); // ~69.4%
  const candidate = seedLivePeer({ eligible: 144, first: 80 }); // ~55.6% - beats weak, not strong

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 1);
  assert.equal(db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(weak), undefined, 'the weakest manual peer must be untrusted');
  assert.ok(db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(strong), 'the stronger existing manual peer must be untouched');
  assert.ok(db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(candidate), 'the candidate must now be trusted');
  const logRow = db.instance.prepare('SELECT * FROM rotation_log WHERE action = ?').get('swap');
  assert.equal(logRow.address, candidate);
  assert.equal(logRow.replaced_address, weak);
});

test('does nothing when no non-trusted candidate beats the weakest manual peer', async () => {
  const a = seedLivePeer({ eligible: 144, first: 80, trusted: true });
  const b = seedLivePeer({ eligible: 144, first: 90, trusted: true });
  seedLivePeer({ eligible: 144, first: 5 }); // far worse than either manual peer

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 0);
  assert.ok(db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(a));
  assert.ok(db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(b));
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM rotation_log').get().n, 0);
});

test('caps promotion at one per tick even when multiple candidates qualify', async () => {
  // Both slots free (nothing trusted yet), two qualifying candidates.
  seedLivePeer({ eligible: 144, first: 90 });
  seedLivePeer({ eligible: 144, first: 70 });

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 1);
  const trustedCount = db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n;
  assert.equal(trustedCount, 1, 'only the single best candidate may be promoted in one pass');
});

test('REGRESSION: an offline manual peer still occupies its slot', async () => {
  // MAX_MANUAL_PEERS is 2 here. One live manual, one offline manual - the cap
  // is reached. Counting only live manual peers made this look like a free
  // slot, so every tick promoted another peer forever: Core maintains at most
  // MAX_ADDNODE_CONNECTIONS addnodes and syncTrustedToAddnode hands those out
  // oldest-first, so the newcomer never became live and never closed the gap.
  seedLivePeer({ eligible: 144, first: 90, trusted: true });
  seedOfflineTrustedPeer({ eligible: 144, first: 80 });
  seedLivePeer({ eligible: 144, first: 20 }); // a candidate, but weaker than both manuals

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 0, 'a full manual set must not gain a third peer just because one is offline');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 2);
});

test('REGRESSION: a stronger candidate replaces an offline manual peer with a worse record', async () => {
  seedLivePeer({ eligible: 144, first: 90, trusted: true }); // 62.5%
  const weakOffline = seedOfflineTrustedPeer({ eligible: 144, first: 5 }); // 3.5% - worst overall
  const candidate = seedLivePeer({ eligible: 144, first: 60 }); // 41.7% - beats the offline one only

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 1);
  assert.equal(
    db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(weakOffline),
    undefined,
    'being offline is no protection for the worst record in the set',
  );
  assert.ok(db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(candidate));
});

test('REGRESSION: an inbound peer already trusted under its real address is not re-promoted', async () => {
  // The inbound row carries the peer's ephemeral source port; the address it
  // actually listens on is already a manual peer. Without a re-check after
  // resolving, this "promoted" the same peer on every tick - burning the one
  // promotion per pass forever and filling the log with false entries.
  seedLivePeer({ address: '198.51.100.9:8333', eligible: 144, first: 95, trusted: true });
  seedLivePeer({ address: '198.51.100.9:61234', direction: 'inbound', connectionType: 'inbound', eligible: 144, first: 95 });
  mock.method(manualPeer, 'findListeningAddress', async (host) => `${host}:8333`);

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 0, 'the peer is already manual under its listening address');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM rotation_log').get().n, 0, 'and no promote row may be logged');
});

test('promotes a reachable inbound candidate by re-deriving its real listening port', async () => {
  const candidate = seedLivePeer({ address: '198.51.100.7:54321', direction: 'inbound', connectionType: 'inbound', eligible: 144, first: 40 });
  // The rotation's contract with manual-peer.js is findListeningAddress - the
  // port scan itself is manual-peer's own business and is covered by its tests.
  mock.method(manualPeer, 'findListeningAddress', async (host) => (host === '198.51.100.7' ? `${host}:9333` : null));

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 1);
  // The live inbound address (with its ephemeral outbound-source port) must
  // never be the one persisted - only the re-probed real listening port is.
  assert.equal(db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(candidate), undefined);
  const row = db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get('198.51.100.7:9333');
  assert.ok(row, 'the peer must be trusted under its real, probed listening address');
});

test('skips an unreachable inbound candidate and falls through to the next-best one', async () => {
  seedLivePeer({ address: '198.51.100.8:11111', direction: 'inbound', connectionType: 'inbound', eligible: 144, first: 90 });
  const fallback = seedLivePeer({ eligible: 144, first: 60 }); // outbound, worse first%, but reachable by construction
  mock.method(manualPeer, 'findListeningAddress', async () => null); // inbound peer isn't actually listening on 8333 or 9333

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 1);
  assert.ok(db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(fallback));
});

test('tick is a complete no-op when the toggle is off', async () => {
  seedLivePeer({ eligible: 144, first: 0 }); // would otherwise be kicked
  seedLivePeer({ eligible: 144, first: 90 }); // would otherwise be promoted

  const result = await peerRotation.tick();

  assert.deepEqual(result, { enabled: false, kicked: 0, promoted: 0 });
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM rotation_log').get().n, 0);
});

test('tick runs both passes once the toggle is on', async () => {
  peerRotation.setEnabled(true);
  seedLivePeer({ eligible: 144, first: 0 });
  seedLivePeer({ eligible: 144, first: 90 });

  const result = await peerRotation.tick();

  assert.equal(result.enabled, true);
  assert.equal(result.kicked, 1);
  assert.equal(result.promoted, 1);
  peerRotation.setEnabled(false);
});

test('setEnabled/isEnabled round-trip through the meta table', () => {
  assert.equal(peerRotation.isEnabled(), false);
  peerRotation.setEnabled(true);
  assert.equal(peerRotation.isEnabled(), true);
  peerRotation.setEnabled(false);
  assert.equal(peerRotation.isEnabled(), false);
});
