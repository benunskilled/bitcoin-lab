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

const config = require('../src/lib/config');
const db = require('../src/lib/db');
const rpc = require('../src/lib/rpc');
const manualPeer = require('../src/lib/manual-peer');
const queries = require('../src/lib/queries');
const peerRotation = require('../src/lib/peer-rotation');
const peerSync = require('../src/lib/peer-sync');

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
    DELETE FROM parked_peer;
    DELETE FROM rotation_log;
    DELETE FROM promoted_peer;
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
  kept = false,
} = {}) {
  const peer = db.getOrCreatePeer(address);
  db.instance
    .prepare('INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)')
    .run(peer.id, direction, connectionType, Date.now() - 3600000);
  seedEligibility(peer.id, eligible, first);
  if (trusted) {
    db.instance
      .prepare('INSERT INTO trusted_peer (address, label, kept, created_at) VALUES (?, ?, ?, ?)')
      .run(address, null, kept ? 1 : 0, Date.now());
  }
  return address;
}

// A trusted peer that is NOT currently connected: a trusted_peer row plus a
// closed session, which is exactly what Core retrying a manual peer that went
// dark looks like from here.
const HOUR = 60 * 60 * 1000;

function seedOfflineTrustedPeer({
  address = nextAddress(),
  eligible = 0,
  first = 0,
  offlineHours = 1,
  kept = false,
  // Whether Core ever actually held a manual connection to it. False models
  // the address that answered a port probe but never stood up as an outbound
  // connection - the common fate of a peer that only ever dialled in.
  everManual = true,
} = {}) {
  const peer = db.getOrCreatePeer(address);
  const endedAt = Date.now() - offlineHours * HOUR;
  db.instance
    .prepare('INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at) VALUES (?, ?, ?, ?, ?)')
    .run(peer.id, everManual ? 'outbound' : 'inbound', everManual ? 'manual' : 'inbound', endedAt - HOUR, endedAt);
  seedEligibility(peer.id, eligible, first);
  db.instance
    .prepare('INSERT INTO trusted_peer (address, label, kept, created_at) VALUES (?, ?, ?, ?)')
    .run(address, null, kept ? 1 : 0, endedAt - HOUR);
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
  seedLivePeer({ eligible: config.minEligibleForJudgement - 1, first: 0 });
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
  seedLivePeer({ eligible: config.minEligibleForJudgement - 1, first: 50 });
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

  assert.deepEqual(result, { enabled: false, kicked: 0, retired: 0, revived: 0, promoted: 0 });
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

// --- Offline manual peers: a grace period bought with performance -----------
//
// The rule these cover is the one a user can actually feel: a peer that
// delivers 40% of your blocks first is worth waiting a week for, one at 0.8%
// is not worth waiting a day for. A single flat timeout for both is the
// obvious implementation and the one worth having tests against.

test('the offline grace period scales with the peer\'s own First %', () => {
  const hours = (pct) => peerRotation.offlineGraceMs(pct) / HOUR;

  assert.equal(hours(0.8), 1, 'a weak peer gets the floor - an hour, not a day');
  assert.equal(hours(40), 24, 'a strong peer gets the ceiling - a day, not a week');
  assert.ok(hours(5) > hours(0.8), 'more performance always buys more patience');
  assert.ok(hours(20) > hours(5));
  assert.equal(hours(null), 1, 'no track record yet gets the floor, never the ceiling');

  // The ceiling is deliberately a day rather than a week: parking makes
  // retiring reversible, so the wait only has to cover outages that fix
  // themselves, not "might come back eventually".
  assert.ok(hours(100) <= 24, 'no record, however good, buys more than a day');
});

test('a weak manual peer loses its slot once it is offline past its short grace', async () => {
  // 2/200 = 1% -> 1h of grace. Offline for 5.
  const address = seedOfflineTrustedPeer({ eligible: 200, first: 2, offlineHours: 5 });

  const retired = await peerRotation.retireOfflineManualPeers(ranking());

  assert.equal(retired, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(address).n, 0);
  const parked = db.instance.prepare('SELECT * FROM parked_peer WHERE address = ?').get(address);
  assert.ok(parked, 'a retired peer is parked, not forgotten');
  assert.equal(parked.probe_failures, 0);
  const logRow = db.instance.prepare('SELECT * FROM rotation_log WHERE action = ?').get('park');
  assert.equal(logRow.address, address);
});

test('a strong manual peer keeps its slot through an outage that would retire a weak one', async () => {
  // 80/200 = 40% -> the 24h ceiling. Offline for 5 - the exact same outage
  // that just cost the 1% peer its slot in the test above.
  const strong = seedOfflineTrustedPeer({ eligible: 200, first: 80, offlineHours: 5 });

  const retired = await peerRotation.retireOfflineManualPeers(ranking());

  assert.equal(retired, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(strong).n, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer').get().n, 0);
});

test('a live manual peer is never retired, however bad its record', async () => {
  seedLivePeer({ connectionType: 'manual', eligible: 500, first: 0, trusted: true });

  const retired = await peerRotation.retireOfflineManualPeers(ranking());

  assert.equal(retired, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 1);
});

test('a manual peer that has never connected at all is timed from when it was added', async () => {
  // No session row ever - so there is no offlineSinceMs to measure. It was
  // reachable when it was added (every add path probes first), so silence
  // since then means the same thing and must not grant infinite patience.
  const address = nextAddress();
  db.getOrCreatePeer(address);
  db.instance
    .prepare('INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)')
    .run(address, null, Date.now() - 5 * HOUR);

  const retired = await peerRotation.retireOfflineManualPeers(ranking());

  assert.equal(retired, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(address).n, 0);
  // Nothing to park: it has no eligible blocks, so there is no record to
  // come back to. Re-probing it forever would be busywork.
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer').get().n, 0);
});

// --- Parked peers come back -------------------------------------------------

function seedParked({ address = nextAddress(), firstPct = 20, eligible = 200, lastProbeAt = null, probeFailures = 0 } = {}) {
  db.instance
    .prepare(
      `INSERT INTO parked_peer (address, label, first_pct, eligible, parked_at, last_probe_at, probe_failures)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(address, firstPct, eligible, Date.now() - 3 * HOUR, lastProbeAt, probeFailures);
  return address;
}

test('a parked peer that answers again takes a free manual slot back', async () => {
  const address = seedParked({ firstPct: 22 });
  const probed = [];
  mock.method(manualPeer, 'probePort', async (host, port) => { probed.push(`${host}:${port}`); return true; });
  const added = [];
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => { added.push(`${cmd} ${addr}`); });

  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.equal(revived, 1);
  // The port it was originally added on - one connect(), not a port search.
  assert.deepEqual(probed, [address]);
  assert.deepEqual(added, [`add ${address}`]);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(address).n, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(address).n, 0);
  const logRow = db.instance.prepare('SELECT * FROM rotation_log WHERE action = ?').get('revive');
  assert.equal(logRow.address, address);
  assert.equal(logRow.replaced_address, null);
});

test('a parked peer that is still unreachable stays parked and backs off', async () => {
  const address = seedParked();
  mock.method(manualPeer, 'probePort', async () => false);

  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.equal(revived, 0);
  const row = db.instance.prepare('SELECT * FROM parked_peer WHERE address = ?').get(address);
  assert.equal(row.probe_failures, 1);
  assert.ok(row.last_probe_at != null);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 0);
});

test('the re-probe interval backs off, so a long-dead address is barely probed', async () => {
  // 9 failures against a 30-minute base is well past the 12h cap, so a peer
  // probed 20 minutes ago is not due - and must not be touched.
  seedParked({ lastProbeAt: Date.now() - 20 * 60 * 1000, probeFailures: 9 });
  let probes = 0;
  mock.method(manualPeer, 'probePort', async () => { probes += 1; return true; });

  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.equal(probes, 0);
  assert.equal(revived, 0);
});

test('a returning peer only displaces a manual peer it actually beats', async () => {
  // MAX_MANUAL_PEERS is 2 in this file. Fill both with strong peers.
  seedLivePeer({ connectionType: 'manual', eligible: 200, first: 60, trusted: true }); // 30%
  seedLivePeer({ connectionType: 'manual', eligible: 200, first: 40, trusted: true }); // 20%
  const mediocre = seedParked({ firstPct: 5 });
  mock.method(manualPeer, 'probePort', async () => true);

  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.equal(revived, 0, 'reachable is not the same as worth a slot');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(mediocre).n, 0);
  // It is alive, so the failure count is reset rather than incremented - it
  // should be re-checked promptly when a slot does open up.
  assert.equal(db.instance.prepare('SELECT probe_failures AS f FROM parked_peer WHERE address = ?').get(mediocre).f, 0);
});

test('a returning peer that beats the weakest manual peer swaps in, and the loser is parked in turn', async () => {
  const strong = seedLivePeer({ connectionType: 'manual', eligible: 200, first: 60, trusted: true }); // 30%
  const weak = seedLivePeer({ connectionType: 'manual', eligible: 200, first: 8, trusted: true }); // 4%
  const returning = seedParked({ firstPct: 25 });
  mock.method(manualPeer, 'probePort', async () => true);

  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.equal(revived, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(returning).n, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(weak).n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(strong).n, 1);
  // The displaced peer keeps its own second chance.
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(weak).n, 1);
  const logRow = db.instance.prepare('SELECT * FROM rotation_log WHERE action = ?').get('revive');
  assert.equal(logRow.replaced_address, weak);
});

test('at most one peer joins the manual set per tick, revival or promotion', async () => {
  peerRotation.setEnabled(true);
  seedParked({ firstPct: 30 });
  seedLivePeer({ eligible: 200, first: 100 }); // a strong promotion candidate too
  mock.method(manualPeer, 'probePort', async () => true);
  mock.method(manualPeer, 'findListeningAddress', async (host) => `${host}:8333`);

  const result = await peerRotation.tick();

  assert.equal(result.revived, 1);
  assert.equal(result.promoted, 0, 'a revival uses up the tick\'s one move');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 1);
  peerRotation.setEnabled(false);
});

// --- How hard a parked peer is chased, and for how long ---------------------
//
// Both scale with the peer's own record, in opposite directions to the naive
// design: a peer that delivered 30% of your blocks is worth knocking on twice
// a day for months, one at 1% is not worth knocking on twice a day for a
// month. Even a successful answer from the weak one is barely worth having.

test('a strong parked peer is chased at full speed, a weak one progressively less often', () => {
  const hours = (pct) => peerRotation.probeIntervalCapMs(pct) / HOUR;

  assert.equal(hours(40), 12, 'a 40% peer keeps the fastest ceiling');
  assert.equal(hours(20), 12, 'and so does anything at or above full-speed pct');
  assert.ok(hours(10) > 12 && hours(10) < 48, 'the middle slides between the two');
  assert.ok(hours(1) > hours(10), 'weaker means rarer');
  assert.equal(hours(0), 48, 'no record at all gets the slowest ceiling');
});

test('a strong parked peer is remembered for months, a weak one for days', () => {
  const days = (pct) => peerRotation.parkedRetentionMs(pct) / (24 * HOUR);

  assert.equal(days(40), 180, 'the best peers are kept for half a year');
  assert.equal(days(0.8), 4, 'the weakest are dropped in days, not a month');
  assert.ok(days(5) > days(0.8) && days(5) < days(40));
  assert.equal(days(0), 2, 'the floor');
});

test('a weak parked peer is forgotten once its own retention is up, while a strong one is kept', async () => {
  const weak = nextAddress();
  const strong = nextAddress();
  const tenDaysAgo = Date.now() - 10 * 24 * HOUR;
  const insert = db.instance.prepare(
    `INSERT INTO parked_peer (address, label, first_pct, eligible, parked_at, last_probe_at, probe_failures)
     VALUES (?, NULL, ?, 200, ?, NULL, 0)`,
  );
  insert.run(weak, 0.8, tenDaysAgo);   // 0.8% -> kept 4 days: long gone
  insert.run(strong, 30, tenDaysAgo);  // 30%  -> kept 150 days: still waiting
  mock.method(manualPeer, 'probePort', async () => false);

  await peerRotation.reviveParkedPeers(ranking());

  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(weak).n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(strong).n, 1);
});

test('the slower ceiling actually holds a weak peer back that a strong one would pass', async () => {
  // Both probed 20 hours ago with 6 failures, so both are at their ceiling.
  const probedAt = Date.now() - 20 * HOUR;
  const strong = seedParked({ firstPct: 30, lastProbeAt: probedAt, probeFailures: 6 }); // ceiling 12h -> due
  const weak = seedParked({ firstPct: 1, lastProbeAt: probedAt, probeFailures: 6 });    // ceiling ~46h -> not due
  const probed = [];
  mock.method(manualPeer, 'probePort', async (host, port) => { probed.push(`${host}:${port}`); return false; });

  await peerRotation.reviveParkedPeers(ranking());

  assert.deepEqual(probed, [strong]);
  assert.ok(!probed.includes(weak));
});

// --- REGRESSIONS: the rotation loop eating itself (v1.15.5) ------------------
//
// Every one of these reproduces a defect that shipped in v1.15.0-v1.15.4 and
// was found by review rather than by this suite. They are written as the
// scenario, not as the fix, so they stay meaningful if the implementation
// changes again.

test('REGRESSION: (re-)joining the manual set restarts the offline clock', () => {
  const now = Date.now();
  // Last seen five hours ago, but added to the manual set one minute ago.
  const peer = { live: false, offlineSinceMs: 5 * HOUR, trustedSince: now - 60_000 };
  const measured = peerRotation.offlineGraceMs(1); // 1% -> the 1h floor
  assert.ok(
    Math.min(peer.offlineSinceMs, now - peer.trustedSince) < measured,
    'a peer added a minute ago is one minute old, not five hours overdue',
  );
});

test('REGRESSION: a manual peer added seconds ago is not retired on the next tick', async () => {
  // The exact shape that caused it: a stale closed session, and a
  // trusted_peer row created just now.
  const address = nextAddress();
  const peer = db.getOrCreatePeer(address);
  const endedAt = Date.now() - 5 * HOUR;
  db.instance
    .prepare('INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at) VALUES (?, ?, ?, ?, ?)')
    .run(peer.id, 'outbound', 'manual', endedAt - HOUR, endedAt);
  seedEligibility(peer.id, 200, 2); // 1% -> one hour of grace
  db.instance.prepare('INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)').run(address, null, Date.now());

  const retired = await peerRotation.retireOfflineManualPeers(ranking());

  assert.equal(retired, 0, 'it has been manual for seconds, not five hours');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(address).n, 1);
});

test('REGRESSION: park/revive does not loop, and does not starve a real candidate', async () => {
  peerRotation.setEnabled(true);
  // A weak manual peer with a stale closed session - the loop's seed.
  const stale = nextAddress();
  const sp = db.getOrCreatePeer(stale);
  const endedAt = Date.now() - 5 * HOUR;
  db.instance
    .prepare('INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at) VALUES (?, ?, ?, ?, ?)')
    .run(sp.id, 'outbound', 'manual', endedAt - HOUR, endedAt);
  seedEligibility(sp.id, 200, 2);
  db.instance.prepare('INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)').run(stale, null, Date.now());
  // A genuinely strong live candidate waiting for a slot.
  const candidate = seedLivePeer({ eligible: 200, first: 180 });
  mock.method(manualPeer, 'probePort', async () => true);
  mock.method(manualPeer, 'findListeningAddress', async (host) => `${host}:8333`);

  const ticks = [];
  for (let i = 0; i < 4; i++) ticks.push(await peerRotation.tick()); // eslint-disable-line no-await-in-loop

  const parks = db.instance.prepare(`SELECT COUNT(*) AS n FROM rotation_log WHERE action = 'park'`).get().n;
  const revives = db.instance.prepare(`SELECT COUNT(*) AS n FROM rotation_log WHERE action = 'revive'`).get().n;
  assert.equal(parks, 0, 'the freshly added peer is not parked at all');
  assert.equal(revives, 0);
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(candidate).n,
    1,
    'and the 90% candidate actually gets promoted - the loop used to eat every tick\'s one move',
  );
  peerRotation.setEnabled(false);
});

test('REGRESSION: a refused addnode leaves the parked entry intact', async () => {
  const address = nextAddress();
  db.instance
    .prepare(`INSERT INTO parked_peer (address, label, first_pct, eligible, parked_at, last_probe_at, probe_failures)
              VALUES (?, NULL, 40, 450, ?, NULL, 0)`)
    .run(address, Date.now() - HOUR);
  mock.method(manualPeer, 'probePort', async () => true);
  rpc.addNode.mock.mockImplementation(async () => { throw new Error('Error: Node address is invalid'); });

  await peerRotation.reviveParkedPeers(ranking());

  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(address).n, 0);
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(address).n,
    1,
    'months of ranking data must survive one failed RPC call',
  );
});

test('REGRESSION: a manual peer always has a peer row, so the rotation can see it', async () => {
  const address = nextAddress();
  mock.method(manualPeer, 'probePort', async () => true);

  await peerSync.addTrustedPeer(address, 'test');

  assert.ok(
    db.instance.prepare('SELECT 1 FROM peer WHERE address = ?').get(address),
    'without this row it is invisible to peerRanking and can never be retired',
  );
  assert.ok(ranking().some((p) => p.address === address));
});

test('the rotation loop never spends a probe on a peer it cannot dial', async () => {
  // A strong Tor peer, and nothing else worth promoting. Before this it was
  // picked as the best candidate on every single pass, probed, and failed -
  // burning the tick's one move on an address that can never answer.
  const address = 'vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion:8333';
  const peer = db.getOrCreatePeer(address);
  db.instance
    .prepare('INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)')
    .run(peer.id, 'inbound', 'inbound', Date.now() - 3600000);
  seedEligibility(peer.id, 200, 180); // 90% first - by record, the best peer there is

  let probes = 0;
  mock.method(manualPeer, 'findListeningAddress', async () => { probes += 1; return null; });

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 0);
  assert.equal(probes, 0, 'it must be skipped, not probed and rejected');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 0);
});

// ---------------------------------------------------------------------------
// v1.15.7: the two guards that stopped the manual set churning against itself.
//
// Both come from a loop observed on a real node: two peers 0.2 points apart
// swapped the same slot every ten minutes for hours, each swap a genuine
// disconnect and a genuine addnode. Two separate causes, so two separate
// guards - a minimum margin, and a grace period for a peer that has only just
// taken a slot and therefore has no record to be judged on yet.
// ---------------------------------------------------------------------------

test('a challenger only 0.2 points better does not take a slot', async () => {
  // Both slots full. The weakest holder sits at 0.4% (2/500), which is exactly
  // the pair seen in the wild.
  seedLivePeer({ eligible: 500, first: 100, trusted: true }); // 20%
  const holder = seedLivePeer({ eligible: 500, first: 2, trusted: true }); // 0.4%
  seedLivePeer({ eligible: 500, first: 3 }); // 0.6% - better, but only just

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 0, '0.6 against 0.4 is not worth a disconnect');
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(holder).n,
    1,
    'the holder keeps its slot',
  );
});

test('a challenger clearly better than the weakest holder does take the slot', async () => {
  // Same setup, but 1.0% against 0.4% - a difference of 0.6 points, well past
  // the margin. The guard must not have frozen the rotation.
  seedLivePeer({ eligible: 500, first: 100, trusted: true }); // 20%
  const holder = seedLivePeer({ eligible: 500, first: 2, trusted: true }); // 0.4%
  const challenger = seedLivePeer({ eligible: 500, first: 5 }); // 1.0%

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(challenger).n, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(holder).n, 0);
  const logRow = db.instance.prepare('SELECT * FROM rotation_log WHERE action = ?').get('swap');
  assert.equal(logRow.replaced_address, holder);
});

test('a peer that has only just taken a slot cannot be evicted for having no record yet', async () => {
  // The newcomer reads as 0% because it has seen three blocks, not because it
  // is bad. Before the grace it was therefore the weakest of the set and any
  // candidate with a history displaced it immediately.
  const newcomer = seedLivePeer({ eligible: 3, first: 0, trusted: true });
  seedLivePeer({ eligible: 500, first: 100, trusted: true }); // 20%, the real weakest-eligible
  seedLivePeer({ eligible: 500, first: 50 }); // 10% - would have beaten the newcomer

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 0, 'nobody may be displaced: the newcomer is shielded, the other is better');
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(newcomer).n,
    1,
    'the newcomer keeps the slot it just took',
  );
});

test('REGRESSION: a parked peer cannot evict a freshly added one, which is what made the set ping-pong', async () => {
  // The exact loop from the wild, at the revive end of it: a parked peer with a
  // small but real record answers again, and the only slot it could take is
  // held by a peer added moments ago whose record is still empty. Without the
  // grace it evicted the newcomer, the newcomer's full history then won the
  // slot straight back through promoteBestCandidate, and round it went.
  const newcomer = seedLivePeer({ eligible: 3, first: 0, trusted: true });
  seedLivePeer({ eligible: 500, first: 100, trusted: true }); // 20%
  const parked = seedParked({ firstPct: 0.4, eligible: 565 });
  mock.method(manualPeer, 'probePort', async () => true);

  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.equal(revived, 0, 'answering is not enough when nobody may be displaced');
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(newcomer).n,
    1,
    'the freshly added peer must still hold its slot',
  );
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(parked).n,
    1,
    'and the parked peer stays parked, to be re-tried later',
  );
  // Alive, so its backoff must not grow - it should be asked again promptly
  // once a slot genuinely frees up.
  assert.equal(db.instance.prepare('SELECT probe_failures AS f FROM parked_peer WHERE address = ?').get(parked).f, 0);
});

test('the rotation log never holds more than it can show', async () => {
  // Nothing is kept that is not shown: the table is trimmed on every write to
  // exactly the number the dashboard offers behind "Show all", so there is no
  // retention window to reason about and no way for a misbehaving loop to
  // leave tens of thousands of rows behind before anyone notices.
  const limit = require('../src/lib/config').rotationLogEntries;

  for (let i = 0; i < limit + 15; i += 1) {
    peerRotation.logAction({ action: 'kick', address: `198.51.100.${i}:8333`, firstPct: 0, eligible: 144, note: `entry ${i}` });
  }

  const stored = db.instance.prepare('SELECT COUNT(*) AS n FROM rotation_log').get().n;
  assert.equal(stored, limit, 'older entries go on the way in, not on a sweep');

  // And it is the NEWEST that survive - trimming the wrong end would quietly
  // freeze the log at whatever it held first.
  const notes = peerRotation.recentLog().map((e) => e.note);
  assert.equal(notes[0], `entry ${limit + 14}`, 'newest first');
  assert.ok(!notes.includes('entry 0'), 'the oldest is gone');
});

// --- the outbound funnel -----------------------------------------------
//
// Four counts over the whole history rather than the live snapshot, and every
// one of them de-duplicated by IP. The de-duplication is the part worth
// testing: it is the difference between "this node has seen 74 peers" and a
// number that grows every time a host reconnects on a different port.

test('the funnel counts outbound peers by IP, not by address', () => {
  // Same host, two addresses - which is exactly what a promoted inbound peer
  // looks like: once on its ephemeral source port, once on 8333.
  seedLivePeer({ address: '203.0.113.77:51234', eligible: 60, first: 5 });
  seedLivePeer({ address: '203.0.113.77:8333', eligible: 60, first: 5 });
  seedLivePeer({ address: '198.51.100.9:8333', eligible: 60, first: 2 });

  const f = queries.outboundFunnel();
  assert.equal(f.seen, 2);
  assert.equal(f.tested, 2);
  assert.equal(f.delivered, 2);
});

test('the funnel separates seen, judged and delivered', () => {
  seedLivePeer({ address: '203.0.113.10:8333', eligible: 5, first: 0 });   // too new to judge
  seedLivePeer({ address: '203.0.113.11:8333', eligible: 300, first: 0 }); // judged, never delivered
  seedLivePeer({ address: '203.0.113.12:8333', eligible: 300, first: 7 }); // judged and delivering

  const f = queries.outboundFunnel();
  assert.equal(f.seen, 3);
  assert.equal(f.tested, 2);
  assert.equal(f.delivered, 1);
});

test('the funnel ignores inbound peers', () => {
  seedLivePeer({ address: '203.0.113.20:8333', eligible: 300, first: 9 });
  seedLivePeer({ address: '198.51.100.20:44444', direction: 'inbound', connectionType: 'inbound', eligible: 300, first: 9 });

  const f = queries.outboundFunnel();
  assert.equal(f.seen, 1);
  assert.equal(f.delivered, 1);
});

test('promotions are remembered after the rotation log has been trimmed away', async () => {
  const address = seedLivePeer({ eligible: 300, first: 100 });
  await peerRotation.promoteBestCandidate(ranking());
  assert.equal(queries.outboundFunnel().promoted, 1);

  // Push the promotion out of the thirty rows the log keeps.
  for (let i = 0; i < config.rotationLogEntries + 5; i += 1) {
    seedLivePeer({ eligible: 300, first: 0 });
    await peerRotation.kickDeadWeight(ranking());
  }
  const stillLogged = db.instance
    .prepare(`SELECT COUNT(*) AS n FROM rotation_log WHERE action = 'promote'`)
    .get().n;
  assert.equal(stillLogged, 0, 'the log should have trimmed the promotion away');
  assert.equal(queries.outboundFunnel().promoted, 1, 'but the count must survive it');
  assert.ok(address);
});

test('the same host promoted twice counts once', () => {
  db.instance.prepare(`INSERT OR IGNORE INTO promoted_peer (ip, first_promoted_at) VALUES (?, ?)`).run('203.0.113.30', 1);
  db.instance.prepare(`INSERT OR IGNORE INTO promoted_peer (ip, first_promoted_at) VALUES (?, ?)`).run('203.0.113.30', 2);
  assert.equal(queries.outboundFunnel().promoted, 1);
});

// ---------------------------------------------------------------------------
// The keep star
//
// Its whole purpose is to hold a slot for a reason the app cannot measure: a
// friend's node, a second node of your own, a peer kept for how it is reached
// rather than for what it delivers. So the two ways the rotation can take a
// slot away - displacing it for a better peer, parking it while it is offline
// - both have to leave it alone. With one exception, which the last test here
// pins down.
// ---------------------------------------------------------------------------

test('a kept peer is not displaced, however much better the challenger is', async () => {
  peerRotation.setEnabled(true);
  // Slots full: one kept peer with a poor record, one ordinary one, and a
  // candidate far better than either. Without the star the kept peer is
  // exactly what the swap would take.
  seedLivePeer({ address: '198.51.100.90:8333', trusted: true, kept: true, eligible: 500, first: 5 });
  seedLivePeer({ address: '198.51.100.91:8333', trusted: true, eligible: 500, first: 50 });
  const challenger = seedLivePeer({ address: '198.51.100.92:8333', eligible: 500, first: 250 });

  await peerRotation.tick();

  const trusted = ranking().filter((p) => p.trusted).map((p) => p.address);
  assert.ok(trusted.includes('198.51.100.90:8333'), 'the kept peer keeps its slot, poor record and all');
  assert.ok(!trusted.includes('198.51.100.91:8333'), 'the unprotected one is what the challenger takes instead');
  assert.ok(trusted.includes(challenger));
});

test('an ordinary manual peer with the same record is still displaced', async () => {
  // The control for the test above: same setup, star off. If this one does not
  // swap, the test above proves nothing about the star.
  peerRotation.setEnabled(true);
  seedLivePeer({ address: '198.51.100.93:8333', trusted: true, eligible: 500, first: 5 });
  seedLivePeer({ address: '198.51.100.94:8333', trusted: true, eligible: 500, first: 50 });
  const challenger = seedLivePeer({ address: '198.51.100.95:8333', eligible: 500, first: 250 });

  await peerRotation.tick();

  const trusted = ranking().filter((p) => p.trusted).map((p) => p.address);
  assert.ok(!trusted.includes('198.51.100.93:8333'), 'the weakest unprotected peer loses its slot');
  assert.ok(trusted.includes(challenger));
});

test('a kept peer that has really been connected is not parked when it goes offline', async () => {
  peerRotation.setEnabled(true);
  const address = seedOfflineTrustedPeer({
    address: '198.51.100.96:8333',
    offlineHours: 500,   // far past any grace its record could earn
    eligible: 500,
    first: 5,
    kept: true,
  });

  await peerRotation.tick();

  assert.ok(ranking().find((p) => p.address === address)?.trusted, 'still manual');
  assert.equal(peerRotation.parkedPeers().length, 0, 'and not parked');
});

test('a kept peer Core never managed to connect is parked like any other', async () => {
  // The address that answered a port probe and then never stood up as an
  // outbound connection - which is what a peer that only ever dialled in
  // usually turns out to be. Protecting that would let one bad address hold
  // one of eight slots forever, which is the opposite of what the star is for.
  peerRotation.setEnabled(true);
  const address = seedOfflineTrustedPeer({
    address: '198.51.100.97:8333',
    offlineHours: 500,
    eligible: 500,
    first: 5,
    kept: true,
    everManual: false,
  });

  await peerRotation.tick();

  assert.ok(!ranking().find((p) => p.address === address)?.trusted, 'the slot is freed');
  assert.equal(peerRotation.parkedPeers().length, 1, 'and its record is parked, not thrown away');
});

test('adding by hand sets the star; a promotion by the rotation does not', async () => {
  peerRotation.setEnabled(true);
  // The two callers of addTrustedPeer, side by side. manual-peer.js passes
  // kept: true for everything a person types in; the rotation calls it with
  // no options at all, from promoteBestCandidate.
  await peerSync.addTrustedPeer('198.51.100.98:8333', null, { kept: true });
  seedLivePeer({ address: '198.51.100.99:8333', eligible: 500, first: 250 });
  await peerRotation.tick();

  const byAddress = Object.fromEntries(ranking().map((p) => [p.address, p]));
  assert.equal(byAddress['198.51.100.98:8333']?.kept, true, 'typing an address in is the decision');
  assert.equal(byAddress['198.51.100.99:8333']?.kept, false, 'the loop must stay able to undo its own promotions');
});

test('re-adding a peer never clears a star that is already set', async () => {
  // addTrustedPeer is called by the rotation too - adopting a peer Core
  // already knows, reviving a parked one - and those calls pass kept=false.
  // Taking the star off is the star's own control, not a side effect.
  const address = seedLivePeer({ address: '198.51.100.100:8333', trusted: true, kept: true });
  await peerSync.addTrustedPeer(address, null);

  assert.equal(ranking().find((p) => p.address === address)?.kept, true);

  peerSync.setKept(address, false);
  assert.equal(ranking().find((p) => p.address === address)?.kept, false, 'and the control itself works');
});
