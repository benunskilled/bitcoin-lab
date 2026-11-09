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
// One per region with two slots, so a "full region" fits in a small test.
process.env.MANUAL_PER_REGION = '1';

const config = require('../src/lib/config');
const db = require('../src/lib/db');
const rpc = require('../src/lib/rpc');
const manualPeer = require('../src/lib/manual-peer');
const queries = require('../src/lib/queries');
const peerRotation = require('../src/lib/peer-rotation');
const peerSync = require('../src/lib/peer-sync');
const network = require('../src/lib/network');

// Where each test address is, set per test with at(). The real table would
// tie these tests to a database that changes every week; an address with no
// entry is unknown, like an onion peer.
const PLACES = new Map();
// Core's "tried" table, as getrawaddrman returns it.
let BOOK = {};
function inBook(host, region, { port = 8333, network: net = 'ipv4', operator, country } = {}) {
  const address = `${host}:${port}`;
  BOOK[`${Object.keys(BOOK).length}`] = { address: host, port, network: net, services: 1033, time: 0 };
  if (region) at(address, region, operator, country);
  return address;
}
function at(address, region, operator = `op-${address}`, country = { EU: 'DE', NA: 'US', AS: 'JP', OC: 'AU' }[region] || 'XX') {
  PLACES.set(address, { asn: 1, operator, country, region });
  return address;
}

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
  mock.method(rpc, 'getNetworkInfo', async () => ({ networks: [{ name: 'ipv4', reachable: true, proxy: '' }, { name: 'ipv6', reachable: true, proxy: '' }] }));
  mock.method(network, 'lookup', (address) => PLACES.get(address) || { asn: 0, operator: '', country: '', region: '' });
  // Core's address book is empty unless a test fills it.
  mock.method(rpc, 'call', async (method) => {
    if (method === 'getrawaddrman') return { new: {}, tried: BOOK };
    throw new Error(`no ${method} in tests`);
  });
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
  racePool.length = 0;
  PLACES.clear();
  BOOK = {};
  require('../src/lib/peer-rotation/addrbook').resetForTests();
  db.instance.prepare("DELETE FROM meta WHERE key = 'rotation_trial_at'").run();
});

let addrCounter = 0;
function nextAddress() {
  addrCounter += 1;
  return `203.0.113.${addrCounter}:8333`;
}

const HOUR = 60 * 60 * 1000;

let raceCounter = 0;
// Every peer's observations land on the SAME races, growing the pool only when
// a peer needs more than it already holds.
//
// This used to give each peer a private run of races, which cannot happen: a
// race is one block, and every peer connected at that moment is eligible for
// it. The difference stayed invisible while nothing looked at *when* an
// observation happened - and became visible the moment the score gained a
// recent window, because with private races the newest window belonged
// entirely to whichever peer was seeded last, and everyone else read as having
// delivered nothing lately.
const racePool = [];
function seedEligibility(peerId, eligible, first) {
  const insertRace = db.instance.prepare('INSERT INTO relay_race (block_hash, detected_at) VALUES (?, ?)');
  const insertObs = db.instance.prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)');
  while (racePool.length < eligible) {
    raceCounter += 1;
    racePool.push(insertRace.run(`rotation-race-${raceCounter}`, Date.now()).lastInsertRowid);
  }
  for (let i = 0; i < eligible; i++) {
    insertObs.run(racePool[i], peerId, i < first ? 1 : 0);
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
  // When this peer entered the manual set. The default is deliberately old:
  // the new-slot-holder grace is measured from this, so a peer created "now"
  // is inside its grace and cannot be displaced - which is the point of the
  // grace, and would otherwise silently neuter every displacement test below.
  // Tests about the grace itself pass justPromoted: true.
  justPromoted = false,
  // Core picked it as one of its three high-bandwidth compact-block peers.
  hb = false,
} = {}) {
  const peer = db.getOrCreatePeer(address);
  db.instance
    .prepare('INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at, hb_to) VALUES (?, ?, ?, ?, NULL, ?)')
    .run(peer.id, direction, connectionType, Date.now() - 3600000, hb ? 1 : 0);
  seedEligibility(peer.id, eligible, first);
  if (trusted) {
    db.instance
      .prepare('INSERT INTO trusted_peer (address, label, kept, created_at) VALUES (?, ?, ?, ?)')
      .run(address, null, kept ? 1 : 0, justPromoted ? Date.now() + 1000 : Date.now() - 30 * 24 * HOUR);
  }
  return address;
}

// A trusted peer that is NOT currently connected: a trusted_peer row plus a
// closed session, which is exactly what Core retrying a manual peer that went
// dark looks like from here.
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

// --- The spread: operators and regions, not speed --------------------------

test('an outbound peer that never delivered first is left alone', async () => {
  // The rotation used to disconnect it so Core would dial someone new. A peer
  // on another continent seldom is first, and that peer is what the slots are
  // for now; Core picks and spreads its own outbound peers.
  peerRotation.setEnabled(true);
  try {
    seedLivePeer({ eligible: 144, first: 0 });
    const disconnected = [];
    rpc.disconnectNode.mock.mockImplementation(async (addr) => { disconnected.push(addr); });
    await peerRotation.tick();
    assert.deepEqual(disconnected, []);
    assert.equal(db.instance.prepare("SELECT COUNT(*) AS n FROM rotation_log WHERE action = 'kick'").get().n, 0);
  } finally {
    peerRotation.setEnabled(false);
  }
});

test('a full set in one region makes room for a candidate from another', async () => {
  const strong = at(seedLivePeer({ eligible: 144, first: 100, trusted: true }), 'EU');
  const weak = at(seedLivePeer({ eligible: 144, first: 10, trusted: true }), 'EU');
  const far = at(seedLivePeer({ eligible: 144, first: 0 }), 'AS', 'Sakura');

  assert.equal(await peerRotation.promoteBestCandidate(ranking()), 1);

  const has = (a) => Boolean(db.instance.prepare('SELECT 1 FROM trusted_peer WHERE address = ?').get(a));
  assert.ok(has(far), 'the peer from the missing region is in, never first or not');
  assert.ok(!has(weak), 'the weaker of the two in the full region made room');
  assert.ok(has(strong));
  const logRow = db.instance.prepare("SELECT * FROM rotation_log WHERE action = 'swap'").get();
  assert.equal(logRow.replaced_address, weak);
  assert.match(logRow.note, /^spread: Asia \(JP, Sakura\) in for Europe/);
});

test('a candidate from a region already at its target takes nobody\'s slot', async () => {
  // One per region in these tests: EU and NA are both at it.
  at(seedLivePeer({ eligible: 144, first: 10, trusted: true }), 'EU');
  at(seedLivePeer({ eligible: 144, first: 10, trusted: true }), 'NA');
  at(seedLivePeer({ eligible: 144, first: 140 }), 'EU');

  assert.equal(await peerRotation.promoteBestCandidate(ranking()), 0, 'speed alone no longer buys a slot');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM rotation_log').get().n, 0);
});

test('one operator, one slot', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU', 'Hetzner Online GmbH');
  at(seedLivePeer({ eligible: 144, first: 90 }), 'NA', 'Hetzner Online GmbH');
  assert.equal(await peerRotation.promoteBestCandidate(ranking()), 0, 'not even into a free slot');
});

test('a free slot goes first to a region with fewer manual peers, then to one Core does not reach', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  at(seedLivePeer({ eligible: 144, first: 120 }), 'EU'); // fastest, but its region has a manual peer
  at(seedLivePeer({ eligible: 144, first: 60 }), 'NA');
  at(seedLivePeer({ eligible: 10, first: 0 }), 'NA'); // another of Core's own in NA, too new to promote
  const oc = at(seedLivePeer({ eligible: 144, first: 5 }), 'OC');

  assert.equal(await peerRotation.promoteBestCandidate(ranking()), 1);
  // NA and OC both have no manual peer; Core reaches NA through another
  // outbound peer, OC only through the candidate itself.
  const row = db.instance.prepare("SELECT address FROM rotation_log WHERE action = 'promote'").get();
  assert.equal(row.address, oc);
});

test('within a region, a new country takes the place of a second one from the same country', async () => {
  const strong = at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU', 'A', 'DE');
  const weak = at(seedLivePeer({ eligible: 144, first: 10, trusted: true }), 'EU', 'B', 'DE');
  at(seedLivePeer({ eligible: 144, first: 0 }), 'EU', 'C', 'DE'); // a third German: no gain
  const fi = at(seedLivePeer({ eligible: 144, first: 0 }), 'EU', 'D', 'FI');

  assert.equal(await peerRotation.promoteBestCandidate(ranking()), 1);
  const has = (x) => Boolean(db.instance.prepare('SELECT 1 FROM trusted_peer WHERE address = ?').get(x));
  assert.ok(has(fi), 'Finland is new to the region');
  assert.ok(!has(weak), 'the weaker German made room');
  assert.ok(has(strong));
});

// --- Candidates from Core's address book, and the daily trial -------------

const addrbook = require('../src/lib/peer-rotation/addrbook');

test('a region nobody live can fill is filled from the address book, after a probe', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const busy = inBook('192.0.2.10', 'AS'); // already connected below
  seedLivePeer({ address: busy, eligible: 1 });
  const silent = inBook('192.0.2.11', 'OC');
  const good = inBook('192.0.2.12', 'OC');
  const probed = [];
  mock.method(manualPeer, 'probePort', async (host, port) => { probed.push(`${host}:${port}`); return `${host}:${port}` === good; });

  assert.equal(await addrbook.fillFromAddressBook(ranking()), 1);
  assert.ok(!probed.includes(busy), 'an address already connected is not a candidate');
  assert.ok(db.instance.prepare('SELECT 1 FROM trusted_peer WHERE address = ?').get(good));
  assert.ok(!db.instance.prepare('SELECT 1 FROM trusted_peer WHERE address = ?').get(silent));
  const row = db.instance.prepare("SELECT note FROM rotation_log WHERE action = 'promote'").get();
  assert.match(row.note, /^from the address book · Oceania/);
});

test('a Tor peer goes in unprobed, and only when Core has a Tor proxy', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const onion = inBook('abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz23.onion', null, { network: 'onion' });
  const probe = mock.method(manualPeer, 'probePort', async () => true);

  assert.equal(await addrbook.fillFromAddressBook(ranking()), 0, 'no Tor proxy: nothing');
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({ networks: [
    { name: 'ipv4', reachable: true, proxy: '' }, { name: 'onion', reachable: false, proxy: '10.0.0.1:9050' },
  ] }));
  addrbook.resetForTests();
  assert.equal(await addrbook.fillFromAddressBook(ranking()), 1);
  assert.ok(db.instance.prepare('SELECT 1 FROM trusted_peer WHERE address = ?').get(onion));
  assert.equal(probe.mock.callCount(), 0, 'this container cannot reach Tor, so it does not try');
});

test('nothing from the address book is probed while clearnet goes through a proxy', async () => {
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({ networks: [{ name: 'ipv4', reachable: true, proxy: '10.0.0.1:9050' }] }));
  inBook('192.0.2.20', 'AS');
  const probe = mock.method(manualPeer, 'probePort', async () => true);
  assert.equal(await addrbook.fillFromAddressBook(ranking()), 0);
  assert.equal(probe.mock.callCount(), 0);
});

test('a peer first for none of the recent blocks meets a faster challenger from its own region, once a day', async () => {
  const holder = at(seedLivePeer({ eligible: 144, first: 0, trusted: true }), 'EU', 'Slow', 'DE');
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'NA');
  db.instance.prepare('UPDATE peer_session SET min_ping_ms = 40 WHERE peer_id = (SELECT id FROM peer WHERE address = ?)').run(holder);
  const slow = inBook('192.0.2.30', 'EU', { operator: 'X', country: 'FR' });
  const fast = inBook('192.0.2.31', 'EU', { operator: 'Y', country: 'FI' });
  mock.method(manualPeer, 'probeTime', async (host) => (host === '192.0.2.31' ? 50 : 90)); // ~25 ms and ~45 ms

  assert.equal(await addrbook.trialInRegion(ranking()), 1);
  const has = (x) => Boolean(db.instance.prepare('SELECT 1 FROM trusted_peer WHERE address = ?').get(x));
  assert.ok(has(fast) && !has(holder) && !has(slow));
  assert.match(db.instance.prepare("SELECT note FROM rotation_log WHERE action = 'swap'").get().note, /^trial in Europe/);
  assert.equal(await addrbook.trialInRegion(ranking()), 0, 'one trial a day');
});

test('a peer that delivered a recent block first has no trial', async () => {
  const holder = at(seedLivePeer({ eligible: 144, first: 1, trusted: true }), 'EU');
  db.instance.prepare('UPDATE peer_session SET min_ping_ms = 400 WHERE peer_id = (SELECT id FROM peer WHERE address = ?)').run(holder);
  inBook('192.0.2.40', 'EU');
  mock.method(manualPeer, 'probeTime', async () => 2);
  assert.equal(await addrbook.trialInRegion(ranking()), 0);
});

test('peers you keep count for their region, and the rotation fills the others elsewhere', async () => {
  // Two friends' nodes in Germany, padlocked. With one per region in these
  // tests Europe is full with the first of them; the rotation's own European
  // peer is the surplus, never a padlocked one.
  const friend = at(seedLivePeer({ eligible: 144, first: 0, trusted: true, kept: true }), 'EU', 'Friend ISP');
  const own = at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const far = at(seedLivePeer({ eligible: 144, first: 0 }), 'OC');

  assert.equal(await peerRotation.promoteBestCandidate(ranking()), 1);
  const has = (x) => Boolean(db.instance.prepare('SELECT 1 FROM trusted_peer WHERE address = ?').get(x));
  assert.ok(has(friend), 'the padlocked friend stays');
  assert.ok(!has(own), 'the rotation\'s own peer in the same region makes room');
  assert.ok(has(far));
});

test('Core\'s high-bandwidth peers keep their manual slot', async () => {
  // Every swap closes a connection, and a reconnect loses the standing Core
  // gave it as one of its three compact-block peers.
  at(seedLivePeer({ eligible: 144, first: 10, trusted: true, hb: true }), 'EU');
  at(seedLivePeer({ eligible: 144, first: 10, trusted: true, hb: true }), 'EU');
  at(seedLivePeer({ eligible: 144, first: 0 }), 'AS');
  assert.equal(await peerRotation.promoteBestCandidate(ranking()), 0);
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

test('does not promote a block-relay-only peer: promoting it would drop one of Core\'s anchors', async () => {
  const anchor = seedLivePeer({ connectionType: 'block-relay-only', eligible: 144, first: 50 });
  const disconnected = [];
  rpc.disconnectNode.mock.mockImplementation(async (addr) => { disconnected.push(addr); });

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 0);
  assert.deepEqual(disconnected, []);
  const row = db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(anchor);
  assert.equal(row, undefined);
});

test('does not promote a candidate that has not reached the eligibility threshold', async () => {
  seedLivePeer({ eligible: config.minEligibleForJudgement - 1, first: 50 });
  const promoted = await peerRotation.promoteBestCandidate(ranking());
  assert.equal(promoted, 0);
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
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU'); // 62.5%
  const weakOffline = at(seedOfflineTrustedPeer({ eligible: 144, first: 5 }), 'EU'); // 3.5% - worst overall
  const candidate = at(seedLivePeer({ eligible: 144, first: 60 }), 'AS'); // 41.7% - beats the offline one only

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 1);
  assert.equal(
    db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(weakOffline),
    undefined,
    'being offline is no protection for the worst record in the set',
  );
  assert.ok(db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(candidate));
});

test('an inbound peer is never promoted, however well it has done', async () => {
  // It used to be, and that destroyed what it was rewarding. An inbound peer's
  // record belongs to the connection it opened; promotion probed for its
  // listening port, dialled out to that instead, and dropped the original
  // session. The peer that earned the number was gone, and what replaced it
  // delivered nothing on a real node.
  seedLivePeer({ address: '198.51.100.7:54321', direction: 'inbound', connectionType: 'inbound', eligible: 500, first: 400 });

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 0, 'the best peer on the node is left exactly where it is');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 0, 'nothing was added');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM rotation_log').get().n, 0, 'and nothing is claimed in the log');
});

test('a weaker outbound peer is promoted over a stronger inbound one', async () => {
  // The ranking still has the inbound peer at the top - it is measured and
  // ranked like anyone else. It is only the loop that will not act on it.
  seedLivePeer({ address: '198.51.100.8:11111', direction: 'inbound', connectionType: 'inbound', eligible: 500, first: 450 });
  const outbound = seedLivePeer({ eligible: 500, first: 60 });

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 1);
  assert.ok(db.instance.prepare('SELECT address FROM trusted_peer WHERE address = ?').get(outbound));
});

test('an inbound peer is still measured and still ranked', async () => {
  // Excluding it from the loop must not quietly exclude it from the table -
  // seeing that a peer you did not choose is your best one is the whole
  // argument for adding it by hand.
  const inbound = seedLivePeer({ address: '198.51.100.9:61234', direction: 'inbound', connectionType: 'inbound', eligible: 500, first: 400 });
  const row = ranking().find((p) => p.address === inbound);
  assert.ok(row, 'it is in the ranking');
  assert.ok(row.firstPct > 50, `with its real rate, got ${row.firstPct}`);
});

test('tick is a complete no-op when the toggle is off', async () => {
  seedLivePeer({ eligible: 144, first: 90 }); // would otherwise be promoted

  const result = await peerRotation.tick();

  assert.deepEqual(result, { enabled: false, retired: 0, revived: 0, promoted: 0, trialled: 0, deduped: 0 });
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM rotation_log').get().n, 0);
});

test('tick runs the passes once the toggle is on', async () => {
  peerRotation.setEnabled(true);
  seedLivePeer({ eligible: 144, first: 90 });

  const result = await peerRotation.tick();

  assert.equal(result.enabled, true);
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

test('a returning peer from a region already at its target stays parked', async () => {
  // MAX_MANUAL_PEERS is 2 in this file, one per region: EU and NA are full.
  at(seedLivePeer({ connectionType: 'manual', eligible: 200, first: 60, trusted: true }), 'EU');
  at(seedLivePeer({ connectionType: 'manual', eligible: 200, first: 4, trusted: true }), 'NA');
  const returning = at(seedParked({ firstPct: 40 }), 'EU');
  mock.method(manualPeer, 'probePort', async () => true);

  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.equal(revived, 0, 'reachable, and a fine record, but its region has its slot');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(returning).n, 0);
  // It is alive, so the failure count is reset rather than incremented - it
  // should be re-checked promptly when a slot does open up.
  assert.equal(db.instance.prepare('SELECT probe_failures AS f FROM parked_peer WHERE address = ?').get(returning).f, 0);
});

test('a returning peer that beats the weakest manual peer swaps in, and the loser leaves the manual set', async () => {
  const strong = at(seedLivePeer({ connectionType: 'manual', eligible: 200, first: 60, trusted: true }), 'EU'); // 30%
  const weak = at(seedLivePeer({ connectionType: 'manual', eligible: 200, first: 8, trusted: true }), 'EU'); // 4%
  const returning = at(seedParked({ firstPct: 25 }), 'AS');
  mock.method(manualPeer, 'probePort', async () => true);

  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.equal(revived, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(returning).n, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(weak).n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(strong).n, 1);
  // Still connected, so not parked: it goes on as an ordinary peer and has to
  // earn a slot again (see the test below).
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(weak).n, 0);
  const logRow = db.instance.prepare('SELECT * FROM rotation_log WHERE action = ?').get('revive');
  assert.equal(logRow.replaced_address, weak);
  assert.match(logRow.note, /^back · spread: Asia/);
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

test('a challenger clearly better than the weakest holder does take the slot', async () => {
  // Same setup, but 1.0% against 0.4% - a difference of 0.6 points, well past
  // the margin. The guard must not have frozen the rotation.
  at(seedLivePeer({ eligible: 500, first: 100, trusted: true }), 'EU'); // 20%
  const holder = at(seedLivePeer({ eligible: 500, first: 2, trusted: true }), 'EU'); // 0.4%
  const challenger = at(seedLivePeer({ eligible: 500, first: 5 }), 'AS'); // 1.0%

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
  const newcomer = at(seedLivePeer({ eligible: 3, first: 0, trusted: true, justPromoted: true }), 'EU');
  const older = at(seedLivePeer({ eligible: 500, first: 100, trusted: true }), 'EU');
  at(seedLivePeer({ eligible: 500, first: 50 }), 'AS');

  assert.equal(await peerRotation.promoteBestCandidate(ranking()), 1);
  const has = (a) => db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(a).n;
  assert.equal(has(newcomer), 1, 'the newcomer keeps the slot it just took');
  assert.equal(has(older), 0, 'the other one in the full region makes room instead');
});

test('REGRESSION: a parked peer cannot evict a freshly added one, which is what made the set ping-pong', async () => {
  // The exact loop from the wild, at the revive end of it: a parked peer with a
  // small but real record answers again, and the only slot it could take is
  // held by a peer added moments ago whose record is still empty. Without the
  // grace it evicted the newcomer, the newcomer's full history then won the
  // slot straight back through promoteBestCandidate, and round it went.
  const newcomer = seedLivePeer({ eligible: 3, first: 0, trusted: true, justPromoted: true });
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

test('the rotation log never holds more than it can show', async (t) => {
  // Nothing is kept that is not shown: the table is trimmed on every write to
  // exactly the number the dashboard offers behind "Show all", so there is no
  // retention window to reason about and no way for a misbehaving loop to
  // leave tens of thousands of rows behind before anyone notices.
  // A small limit stands in for the real one: the trimming is the same at any
  // size, and filling a thousand rows only makes the suite slow.
  const cfg = require('../src/lib/config');
  const saved = cfg.rotationLogEntries;
  cfg.rotationLogEntries = 30;
  t.after(() => { cfg.rotationLogEntries = saved; });
  const limit = cfg.rotationLogEntries;

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

test('promotions are remembered after the rotation log has been trimmed away', async (t) => {
  const address = seedLivePeer({ eligible: 300, first: 100 });
  await peerRotation.promoteBestCandidate(ranking());
  assert.equal(queries.outboundFunnel().promoted, 1);

  // Push the promotion out of the rows the log keeps (a small limit, as above).
  const saved = config.rotationLogEntries;
  config.rotationLogEntries = 30;
  t.after(() => { config.rotationLogEntries = saved; });
  for (let i = 0; i < config.rotationLogEntries + 5; i += 1) {
    peerRotation.logAction({ action: 'park', address: `198.51.100.${i + 1}:8333`, note: 'filler' });
  }
  const stillLogged = db.instance
    .prepare(`SELECT COUNT(*) AS n FROM rotation_log WHERE action = 'promote'`)
    .get().n;
  assert.equal(stillLogged, 0, 'the log should have trimmed the promotion away');
  assert.equal(queries.outboundFunnel().promoted, 1, 'but the count must survive it');
  assert.ok(address);
});

test('the same host promoted twice counts once', () => {
  seedLivePeer({ address: '203.0.113.30:8333', eligible: 300, first: 9 });
  db.instance.prepare(`INSERT OR IGNORE INTO promoted_peer (ip, first_promoted_at) VALUES (?, ?)`).run('203.0.113.30', 1);
  db.instance.prepare(`INSERT OR IGNORE INTO promoted_peer (ip, first_promoted_at) VALUES (?, ?)`).run('203.0.113.30', 2);
  assert.equal(queries.outboundFunnel().promoted, 1);
});

/**
 * One host, one spelling. The rotation wrote the bare host that
 * hostFromAddress returns; the backfill kept the brackets an IPv6 address
 * arrives in. Both meant "this host was kept", the primary key could not see
 * that they were the same, and the funnel counted one peer as two.
 */
test('a host added by hand and promoted by the rotation is one kept peer, not two', () => {
  const address = '[2001:db8::5]:8333';

  // Added by hand before the promotion record existed - the backfill is what
  // writes such a peer down.
  db.instance
    .prepare(`INSERT INTO trusted_peer (address, label, kept, created_at) VALUES (?, NULL, 0, ?)`)
    .run(address, 1000);
  db.instance.prepare(`DELETE FROM meta WHERE key = ?`).run('migration:promoted_peer_backfill_v1_15_10');
  db.runMigrations();

  // ...and then promoted by the rotation, which writes the same host its way.
  peerRotation.logAction({ action: 'promote', address, firstPct: 12.5, eligible: 300 });

  const ips = db.instance.prepare(`SELECT ip FROM promoted_peer ORDER BY ip`).all().map((r) => r.ip);
  assert.deepEqual(ips, ['2001:db8::5']);
});

/**
 * An address with no port is not a nameless peer.
 *
 * Core echoes an added node back through getaddednodeinfo exactly as it was
 * given, so a peer added on the default port carries no port at all. Stripping
 * everything from the first colon found none and returned the empty string, so
 * every portless peer on the node shared one bucket and any number of them
 * counted as one.
 */
test('the funnel counts a peer whose address carries no port as itself', () => {
  seedLivePeer({ address: '192.0.2.31', eligible: 300, first: 4 });
  seedLivePeer({ address: '192.0.2.32', eligible: 300, first: 4 });

  const f = queries.outboundFunnel();
  assert.equal(f.seen, 2);
  assert.equal(f.tested, 2);
  assert.equal(f.delivered, 2);
});

/**
 * All four numbers over one population, or it is not a funnel.
 *
 * "Kept" was a bare count of promoted_peer, which is also backfilled from the
 * manual set - and a hand-added peer need never have been an outbound peer at
 * all, including the case the rotation exists to notice: an address Core never
 * manages to connect. A node with eight of those read "3 seen, 2 tested, 1
 * delivered, 9 kept", where the last stage is larger than the first. That is
 * not a surprising statistic, it is a contradiction, and it is read as one.
 */
test('the funnel counts kept peers from the same population as the other three', () => {
  seedLivePeer({ address: '203.0.113.40:8333', eligible: 300, first: 9 });
  const insert = db.instance.prepare(`INSERT INTO promoted_peer (ip, first_promoted_at) VALUES (?, ?)`);
  insert.run('203.0.113.40', 1);   // the outbound peer above: belongs in the funnel
  insert.run('198.51.100.40', 2);  // added by hand, no outbound session ever
  insert.run('2001:db8::40', 3);   // likewise

  const f = queries.outboundFunnel();
  assert.equal(f.seen, 1);
  assert.equal(f.promoted, 1);
  assert.ok(f.promoted <= f.seen, 'a funnel whose last stage exceeds its first is reporting nonsense');

  // The record itself keeps all three: it is the durable answer to "how many
  // peers has this node ever kept", which rotation_log cannot give. Only the
  // funnel narrows it.
  assert.equal(db.instance.prepare(`SELECT COUNT(*) AS n FROM promoted_peer`).get().n, 3);
});

/**
 * The funnel runs on every /api/status poll, several times a minute, and it is
 * a scan of the peer table - which is deliberately never pruned for any peer
 * that has ever been around when a block landed. Cached against the newest
 * block, like routeMedian(), because that is the only thing that can change
 * three of its four numbers.
 */
test('the funnel is worked out once per block, not once per poll', () => {
  seedLivePeer({ address: '203.0.113.50:8333', eligible: 300, first: 9 });
  const first = queries.outboundFunnel();
  assert.equal(first.seen, 1);

  // A second outbound peer and no new block: the same answer, and the same
  // object, which is what says the scan did not run again.
  seedLivePeer({ address: '203.0.113.51:8333' });
  assert.equal(queries.outboundFunnel(), first);

  db.instance
    .prepare('INSERT INTO relay_race (block_hash, detected_at) VALUES (?, ?)')
    .run('funnel-cache-block', Date.now());
  assert.equal(queries.outboundFunnel().seen, 2, 'a block is what makes it look again');
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
  at(seedLivePeer({ address: '198.51.100.90:8333', trusted: true, kept: true, eligible: 500, first: 5 }), 'EU');
  at(seedLivePeer({ address: '198.51.100.91:8333', trusted: true, eligible: 500, first: 50 }), 'EU');
  const challenger = at(seedLivePeer({ address: '198.51.100.92:8333', eligible: 500, first: 250 }), 'AS');

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
  at(seedLivePeer({ address: '198.51.100.93:8333', trusted: true, eligible: 500, first: 5 }), 'EU');
  at(seedLivePeer({ address: '198.51.100.94:8333', trusted: true, eligible: 500, first: 50 }), 'EU');
  const challenger = at(seedLivePeer({ address: '198.51.100.95:8333', eligible: 500, first: 250 }), 'AS');

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

test('the rotation drops an inbound session to a host it already holds as manual', async () => {
  // Doing this once when the peer is added does not hold: the other node
  // dialled in, and it will dial in again. Every reconnect recreates the pair,
  // and the pair splits that peer's record over two rows - only the connection
  // that carried a block is credited with it, so the manual slot reads as
  // worthless while its twin does the work.
  peerRotation.setEnabled(true);
  const disconnects = [];
  mock.method(rpc, 'disconnectNode', async (target) => { disconnects.push(target); });
  mock.method(rpc, 'getPeerInfo', async () => [
    { id: 10, addr: '198.51.100.60:8333', connection_type: 'manual', network: 'ipv4' },
    { id: 11, addr: '198.51.100.60:49812', connection_type: 'inbound', network: 'ipv4' },
    { id: 12, addr: '198.51.100.61:41000', connection_type: 'inbound', network: 'ipv4' },
    { id: 13, addr: '10.21.22.10:52690', connection_type: 'inbound', network: 'onion' },
    // Core's own outbound choice to the same IP: often a second node behind it.
    { id: 14, addr: '198.51.100.60:8334', connection_type: 'outbound-full-relay', network: 'ipv4' },
  ]);

  const result = await peerRotation.tick();

  assert.equal(result.deduped, 1);
  assert.deepEqual(disconnects, [11], 'only the inbound twin of a manual peer - not other inbound peers, not Tor, not outbound');
});

test('a displaced peer is disconnected but not parked', async () => {
  // Not parked: the loop this closes, seen on a real node, was a peer displaced
  // at 5h43m back in its slot ten minutes later - parked peers are revived on
  // their LIFETIME record, the number the peer had just been displaced
  // despite. Out on one measure, back in on the other, every ten minutes.
  //
  // Disconnected: keeping the connection up does not make it an ordinary
  // outbound peer. Core keeps it MANUAL, holding one of the eight addnode
  // grants, and with every slot in use the challenger can then never be
  // dialled - seen on a real node, the promoted peer stayed offline until the
  // displaced one was dropped.
  const weak = at(seedLivePeer({ eligible: 500, first: 5, trusted: true }), 'EU');   // 1%
  at(seedLivePeer({ eligible: 500, first: 150, trusted: true }), 'EU');              // 30%, safe
  const challenger = at(seedLivePeer({ eligible: 500, first: 100 }), 'AS');          // 20%

  const disconnects = [];
  mock.method(rpc, 'disconnectNode', async (addr) => { disconnects.push(addr); });

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 1, 'the challenger takes the slot');
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(weak).n,
    0,
    'the displaced peer loses its manual slot',
  );
  assert.ok(disconnects.includes(weak), `the displaced peer must be disconnected so its addnode slot frees (got ${JSON.stringify(disconnects)})`);
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(weak).n,
    0,
    'and it must not be parked: parking would hand it the slot straight back on its lifetime record',
  );
  assert.ok(db.instance.prepare('SELECT 1 FROM trusted_peer WHERE address = ?').get(challenger), 'the challenger is trusted');
});

test('the new-slot grace runs from the promotion, not from the peer\'s lifetime block count', async () => {
  // The grace used to be "has this peer been eligible for 50 blocks", which is
  // a question about its whole life. A peer with any history at all therefore
  // walked into its slot already past the grace and could be displaced the
  // same minute - while the dashboard promised it fifty blocks of safety.
  const justPromoted = seedLivePeer({ eligible: 900, first: 9, trusted: true, justPromoted: true }); // 1%
  seedLivePeer({ eligible: 500, first: 150, trusted: true });   // 30%, safe on merit
  seedLivePeer({ eligible: 500, first: 100 });                  // 20%, would beat 1% easily

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 0, 'nothing may be displaced while the only weak slot is inside its grace');
  assert.equal(
    db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(justPromoted).n,
    1,
    'a peer with 900 blocks of history still gets its fifty blocks of safety after being promoted',
  );
});

test('after a reset, a protected manual peer that is offline keeps its slot', async () => {
  // "Your manual peers are kept - only their record starts again." The reset
  // used to wipe every session, so a protected peer that happened to be
  // offline read as an address Core had never held, and the next tick parked
  // it - or, with no record left to park, dropped it outright.
  peerRotation.setEnabled(true);
  const address = seedOfflineTrustedPeer({ offlineHours: 500, eligible: 500, first: 25, kept: true });

  db.resetPeerData();
  await peerRotation.tick();

  assert.ok(ranking().find((p) => p.address === address)?.trusted, 'still manual');
});

test('after a reset, an offline manual peer gets a fresh offline grace instead of losing its slot at once', async () => {
  peerRotation.setEnabled(true);
  const address = seedOfflineTrustedPeer({ offlineHours: 500, eligible: 500, first: 25 });

  db.resetPeerData();
  await peerRotation.tick();

  assert.ok(ranking().find((p) => p.address === address)?.trusted, 'not retired on the first tick after the reset');
});

test('a returning peer is judged by the same score as the holder, not by its old lifetime figure', async () => {
  // The holder delivers 15% lately and little before that; the parked peer
  // did well long ago and 1% lately. Compared lifetime against lifetime the
  // old record won the slot back from the peer that is delivering now.
  // The other slot, protected so the holder below is the weakest. Seeded
  // first, so its blocks are older than the 2,500 that follow.
  seedLivePeer({ connectionType: 'manual', eligible: 200, first: 100, trusted: true, kept: true });

  const races = [];
  const insertRace = db.instance.prepare('INSERT INTO relay_race (block_hash, detected_at) VALUES (?, ?)');
  for (let i = 0; i < 2500; i++) races.push(insertRace.run(`same-score-${i}`, Date.now()).lastInsertRowid);
  const obs = db.instance.prepare('INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)');
  const recentFrom = races.length - 500;

  const returning = '198.51.100.120:8333';
  const old = db.getOrCreatePeer(returning);
  // 295 firsts early on, 5 in the last 500 blocks: 12% lifetime, 1% now.
  races.forEach((id, i) => obs.run(id, old.id, (i < 295 || (i >= recentFrom && i < recentFrom + 5)) ? 1 : 0));
  db.instance
    .prepare(`INSERT INTO parked_peer (address, label, first_pct, eligible, parked_at, last_probe_at, probe_failures)
              VALUES (?, NULL, 12, 2500, ?, NULL, 0)`)
    .run(returning, Date.now() - HOUR);

  const holder = seedLivePeer({ connectionType: 'manual', trusted: true });
  const holderRow = db.getOrCreatePeer(holder);
  // Nothing early on, 75 of the last 500: 3% lifetime, 15% now.
  races.forEach((id, i) => obs.run(id, holderRow.id, (i >= recentFrom && i < recentFrom + 75) ? 1 : 0));
  mock.method(manualPeer, 'probePort', async () => true);
  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.equal(revived, 0, 'the peer delivering now keeps its slot');
  assert.ok(ranking().find((p) => p.address === holder)?.trusted);
});

test('a manual peer displaced by a returning one is not parked while it is still connected', async () => {
  // Same rule as a swap by promotion: parking is for a peer that is gone, and
  // a parked peer comes back on its record - so parking a live loser handed
  // it a way straight back in on the number it had just lost on.
  at(seedLivePeer({ connectionType: 'manual', eligible: 200, first: 60, trusted: true }), 'EU'); // 30%
  const weak = at(seedLivePeer({ connectionType: 'manual', eligible: 200, first: 8, trusted: true }), 'EU'); // 4%
  at(seedParked({ firstPct: 25 }), 'AS');
  mock.method(manualPeer, 'probePort', async () => true);

  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.equal(revived, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(weak).n, 0);
});

test('two adds at the same moment cannot take the manual set past its limit', async () => {
  // The count was read before the RPCs and the row written after them, so two
  // adds racing through the gap both saw a free slot. MAX_MANUAL_PEERS is 2.
  seedLivePeer({ connectionType: 'manual', trusted: true });
  const calls = [];
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => {
    calls.push(`${cmd} ${addr}`);
    await new Promise((r) => setTimeout(r, 10));
  });

  const results = await Promise.all([
    peerSync.addTrustedPeer('198.51.100.201:8333'),
    peerSync.addTrustedPeer('198.51.100.202:8333'),
  ]);

  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 2);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  const refused = results.find((r) => !r.ok);
  assert.match(refused.error, /slots are taken/);
  // Core was told to add it before the loss was known, so it is told to drop
  // it again - otherwise Core holds an addnode this app does not know about.
  const loser = results[0].ok ? '198.51.100.202:8333' : '198.51.100.201:8333';
  assert.ok(calls.includes(`remove ${loser}`), calls.join(', '));
});

// Both found by an outside review. The peer being replaced was chosen before
// the RPCs and removed after them, so in between another swap could free the
// same slot (both then wrote their row) or the padlock could go on it.
test('two swaps that chose the same peer to replace cannot both take its slot', async () => {
  const weak = seedLivePeer({ eligible: 144, first: 10, trusted: true });
  seedLivePeer({ eligible: 144, first: 100, trusted: true });
  const holder = ranking().find((p) => p.address === weak);
  const calls = [];
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => {
    calls.push(`${cmd} ${addr}`);
    await new Promise((r) => setTimeout(r, 10));
  });

  const results = await Promise.all([
    peerSync.addTrustedPeer('198.51.100.221:8333', null, { replace: holder }),
    peerSync.addTrustedPeer('198.51.100.222:8333', null, { replace: holder }),
  ]);

  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 2);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  const loser = results[0].ok ? '198.51.100.222:8333' : '198.51.100.221:8333';
  assert.ok(calls.includes(`remove ${loser}`), calls.join(', '));
});

test('a swap does not remove a peer that got its padlock while the swap was waiting', async () => {
  const weak = seedLivePeer({ eligible: 144, first: 10, trusted: true });
  seedLivePeer({ eligible: 144, first: 100, trusted: true });
  const holder = ranking().find((p) => p.address === weak);
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => {
    // The padlock goes on while Core is being asked.
    if (cmd === 'add') peerSync.setKept(weak, true);
  });

  const result = await peerSync.addTrustedPeer('198.51.100.223:8333', null, { replace: holder });

  assert.equal(result.ok, false);
  const kept = db.instance.prepare('SELECT kept FROM trusted_peer WHERE address = ?').get(weak);
  assert.equal(kept && kept.kept, 1, 'the locked peer keeps its slot');
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 2);
});

test('a swap whose addnode Core refuses leaves the weakest manual peer where it was', async () => {
  // The weakest was removed first and the challenger added after; when Core
  // refused the challenger, the slot was simply empty.
  const weak = at(seedLivePeer({ eligible: 144, first: 10, trusted: true }), 'EU');
  at(seedLivePeer({ eligible: 144, first: 100, trusted: true }), 'EU');
  const candidate = at(seedLivePeer({ eligible: 144, first: 80 }), 'AS');
  const calls = [];
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => {
    calls.push(`${cmd} ${addr}`);
    if (addr === candidate && cmd === 'add') throw new Error('Error: Unable to open connection');
  });

  const promoted = await peerRotation.promoteBestCandidate(ranking());

  assert.equal(promoted, 0);
  assert.ok(db.instance.prepare('SELECT 1 FROM trusted_peer WHERE address = ?').get(weak), 'the weakest keeps its slot');
  assert.ok(!calls.includes(`remove ${weak}`), 'and Core was never told to drop it');
});

test('in a swap the challenger is added before the weakest is removed', async () => {
  const weak = at(seedLivePeer({ eligible: 144, first: 10, trusted: true }), 'EU');
  at(seedLivePeer({ eligible: 144, first: 100, trusted: true }), 'EU');
  const candidate = at(seedLivePeer({ eligible: 144, first: 80 }), 'AS');
  const calls = [];
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => { calls.push(`${cmd} ${addr}`); });

  assert.equal(await peerRotation.promoteBestCandidate(ranking()), 1);
  assert.ok(calls.indexOf(`add ${candidate}`) < calls.indexOf(`remove ${weak}`), calls.join(', '));
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 2);
  // Still connected when it lost the slot, so not parked - as before.
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(weak).n, 0);
});

test('dead parked peers that are not due yet do not crowd out one that is', async () => {
  // Three per tick were picked by "longest unchecked" and only then filtered
  // for being due, so three long-dead addresses waiting out their backoff
  // took every place and a good peer due now was never knocked on.
  for (let i = 0; i < 3; i++) seedParked({ firstPct: 0, probeFailures: 10, lastProbeAt: Date.now() - 20 * HOUR });
  const good = seedParked({ firstPct: 30, lastProbeAt: Date.now() - HOUR });
  const probed = [];
  mock.method(manualPeer, 'probePort', async (host, port) => { probed.push(`${host}:${port}`); return true; });

  const revived = await peerRotation.reviveParkedPeers(ranking());

  assert.deepEqual(probed, [good]);
  assert.equal(revived, 1);
});

test('typing in a peer when the slots are full never displaces a protected one', async () => {
  // MAX_MANUAL_PEERS is 2. Both slots hold protected peers: nothing may go.
  const a = seedLivePeer({ connectionType: 'manual', trusted: true, kept: true, eligible: 144, first: 1 });
  const b = seedLivePeer({ connectionType: 'manual', trusted: true, kept: true, eligible: 144, first: 2 });
  const result = await peerSync.addTrustedPeer('198.51.100.210:8333', 'typed', { evictToFit: true, kept: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /protected/);
  const rows = db.instance.prepare('SELECT address FROM trusted_peer ORDER BY address').all().map((r) => r.address);
  assert.deepEqual(rows, [a, b].sort());
});

test('typing in a peer displaces the weakest unprotected one, even when a protected one is weaker', async () => {
  const keptWeak = seedLivePeer({ connectionType: 'manual', trusted: true, kept: true, eligible: 144, first: 1 });
  const free = seedLivePeer({ connectionType: 'manual', trusted: true, eligible: 144, first: 40 });
  const result = await peerSync.addTrustedPeer('198.51.100.211:8333', 'typed', { evictToFit: true, kept: true });
  assert.equal(result.ok, true);
  assert.equal(result.evicted.address, free);
  // Still connected: not parked, as after a swap by the rotation.
  assert.equal(result.evicted.parked, false);
  const rows = db.instance.prepare('SELECT address FROM trusted_peer').all().map((r) => r.address);
  assert.ok(rows.includes(keptWeak) && !rows.includes(free));
});

test('a peer displaced without any record is reported as not kept for re-testing', async () => {
  seedLivePeer({ connectionType: 'manual', trusted: true, kept: true, eligible: 144, first: 1 });
  seedLivePeer({ connectionType: 'manual', trusted: true });   // unprotected, no record
  const result = await peerSync.addTrustedPeer('198.51.100.212:8333', 'typed', { evictToFit: true, kept: true });
  assert.equal(result.ok, true);
  assert.equal(result.evicted.parked, false);
});

test('behind a Tor proxy a parked peer is not knocked on directly', async () => {
  // The knock is a TCP connection past Core: through a proxied node it would
  // show the node's own address.
  seedParked({ firstPct: 22 });
  let probes = 0;
  mock.method(manualPeer, 'probePort', async () => { probes += 1; return true; });
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({
    networks: [{ name: 'ipv4', reachable: true, proxy: '10.21.22.11:9050' }, { name: 'ipv6', reachable: false, proxy: '' }],
  }));
  assert.equal(await peerRotation.reviveParkedPeers(ranking()), 0);
  assert.equal(probes, 0);

  // No IPv6 alone is not a reason: the knock goes out over IPv4 as before.
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({
    networks: [{ name: 'ipv4', reachable: true, proxy: '' }, { name: 'ipv6', reachable: false, proxy: '' }],
  }));
  await peerRotation.reviveParkedPeers(ranking());
  assert.equal(probes, 1);
});

test('a returning peer whose addnode Core refuses leaves the weakest manual peer in its slot', async () => {
  // The weakest used to be removed first; a refused add then left the slot empty.
  at(seedLivePeer({ connectionType: 'manual', eligible: 200, first: 60, trusted: true }), 'EU'); // 30%
  const weak = at(seedLivePeer({ connectionType: 'manual', eligible: 200, first: 8, trusted: true }), 'EU'); // 4%
  at(seedParked({ firstPct: 25 }), 'AS');
  mock.method(manualPeer, 'probePort', async () => true);
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => {
    if (cmd === 'add') throw new Error('refused');
  });

  assert.equal(await peerRotation.reviveParkedPeers(ranking()), 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(weak).n, 1);
});

test('no clearnet at all, or no answer about it, also means no direct knock', async () => {
  seedParked({ firstPct: 22 });
  let probes = 0;
  mock.method(manualPeer, 'probePort', async () => { probes += 1; return true; });
  // onlynet=onion: IPv4 is not reachable.
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({
    networks: [{ name: 'ipv4', reachable: false, proxy: '' }, { name: 'onion', reachable: true, proxy: '10.21.22.11:9050' }],
  }));
  assert.equal(await peerRotation.reviveParkedPeers(ranking()), 0);
  // Core not answering: unknown counts as proxied.
  rpc.getNetworkInfo.mock.mockImplementation(async () => { throw new Error('down'); });
  assert.equal(await peerRotation.reviveParkedPeers(ranking()), 0);
  assert.equal(probes, 0);
});

test('a manual peer displaced by hand while offline is parked', async () => {
  const offline = seedOfflineTrustedPeer({ eligible: 144, first: 2 });
  seedLivePeer({ connectionType: 'manual', trusted: true, kept: true, eligible: 144, first: 40 });
  const result = await peerSync.addTrustedPeer('198.51.100.213:8333', 'typed', { evictToFit: true, kept: true });
  assert.equal(result.ok, true);
  assert.equal(result.evicted.address, offline);
  assert.equal(result.evicted.parked, true);
});

test('a Tor manual peer that stays offline is let go, not parked', async () => {
  const onion = seedOfflineTrustedPeer({
    address: 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz23.onion:8333', eligible: 0, offlineHours: 24 * 30,
  });
  assert.equal(await peerRotation.retireOfflineManualPeers(ranking()), 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(onion).n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(onion).n, 0);
});

test('on a node that reaches only Tor, no clearnet address is probed and the slots still fill', async () => {
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({ networks: [
    { name: 'ipv4', reachable: false, proxy: '' }, { name: 'ipv6', reachable: false, proxy: '' },
    { name: 'onion', reachable: true, proxy: '10.0.0.1:9050' },
  ] }));
  inBook('192.0.2.50', 'AS');
  const a = inBook('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion', null, { network: 'onion' });
  const b = inBook('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion', null, { network: 'onion' });
  const probe = mock.method(manualPeer, 'probePort', async () => true);

  assert.equal(await addrbook.fillFromAddressBook(ranking()), 1);
  assert.equal(await addrbook.fillFromAddressBook(ranking()), 1, 'a second Tor peer, rather than an empty slot');
  const trusted = db.instance.prepare('SELECT address FROM trusted_peer').all().map((r) => r.address).sort();
  assert.deepEqual(trusted, [a, b].sort());
  assert.equal(probe.mock.callCount(), 0, 'the clearnet address was never touched');
});
