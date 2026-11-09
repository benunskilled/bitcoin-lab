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
// Core's "tried" table, as getrawaddrman returns it, and its bans.
let BOOK = {};
let BANNED = [];
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
  mock.method(rpc, 'getBlockchainInfo', async () => ({ blocks: TIP, headers: TIP, initialblockdownload: false }));
  mock.method(network, 'lookup', (address) => PLACES.get(address) || { asn: 0, operator: '', country: '', region: '' });
  // Core's address book is empty unless a test fills it.
  mock.method(rpc, 'call', async (method) => {
    if (method === 'getrawaddrman') return { new: {}, tried: BOOK };
    if (method === 'listbanned') return BANNED;
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
  BANNED = [];
  require('../src/lib/peer-rotation/addrbook').resetForTests();
  db.instance.exec(`DELETE FROM slot_fill_tried;
    DELETE FROM meta WHERE key IN ('slot_fill_trial', 'slot_fill_swap_rest_until', 'peer_rotation_enabled');`);
});

// Core's chain tip in these tests.
const TIP = 900000;

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


test('an inbound peer is still measured and still ranked', async () => {
  // Excluding it from the loop must not quietly exclude it from the table -
  // seeing that a peer you did not choose is your best one is the whole
  // argument for adding it by hand.
  const inbound = seedLivePeer({ address: '198.51.100.9:61234', direction: 'inbound', connectionType: 'inbound', eligible: 500, first: 400 });
  const row = ranking().find((p) => p.address === inbound);
  assert.ok(row, 'it is in the ranking');
  assert.ok(row.firstPct > 50, `with its real rate, got ${row.firstPct}`);
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

// --- Parked peers -----------------------------------------------------------

function seedParked({ address = nextAddress(), firstPct = 20, eligible = 200, lastProbeAt = null, probeFailures = 0 } = {}) {
  db.instance
    .prepare(
      `INSERT INTO parked_peer (address, label, first_pct, eligible, parked_at, last_probe_at, probe_failures)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(address, firstPct, eligible, Date.now() - 3 * HOUR, lastProbeAt, probeFailures);
  return address;
}

// --- How hard a parked peer is chased, and for how long ---------------------
//
// Both scale with the peer's own record, in opposite directions to the naive
// design: a peer that delivered 30% of your blocks is worth offering to Core
// twice a day for months, one at 1% is not worth offering twice a day for a
// month. Even a successful connection to the weak one is barely worth having.

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

// --- Manual slot fill: a candidate on trial, and Core decides ----------------
//
// The slot fill never dials anyone itself and never touches Core's own
// connections. It adds a candidate from Core's address book (or a parked
// peer), lets the peer it replaces go, and waits for Core: a manual
// connection to a node that serves blocks on our tip within the trial, or the
// candidate goes and the peer it replaced comes back.

const fill = require('../src/lib/peer-rotation/fill');
const MIN = 60 * 1000;

// One of Core's own outbound connections: proof the network works from here.
let coreId = 500;
function coreOut(network = 'ipv4', extra = {}) {
  coreId += 1;
  const addr = network === 'onion' ? `${'c'.repeat(56)}${coreId}.onion:8333` : `192.0.2.${coreId % 250}:8333`;
  return { id: coreId, addr, network, connection_type: 'outbound-full-relay', services: '0000000000000409', synced_headers: TIP, ...extra };
}
// Core's manual connection to a candidate.
function manualSession(address, { services = '0000000000000409', synced = TIP, network = 'ipv4', ...extra } = {}) {
  return { id: 900, addr: address, network, connection_type: 'manual', services, synced_headers: synced, ...extra };
}
function setPeers(list) {
  rpc.getPeerInfo.mock.mockImplementation(async () => list);
  return list;
}
const isManual = (address) => Boolean(db.instance.prepare('SELECT 1 FROM trusted_peer WHERE address = ?').get(address));
const logRows = () => db.instance.prepare('SELECT * FROM rotation_log ORDER BY id').all();
// One pass of the slot fill as tick() runs it, without the retire and dedupe
// around it.
async function step(peers, now) {
  const chain = await rpc.getBlockchainInfo();
  const settled = await fill.settle(peers, chain, now);
  const started = settled === 'waiting' || settled === 'reverted' ? 0 : await fill.start(ranking(), peers, chain, now);
  return { started, confirmed: settled === 'confirmed' ? 1 : 0, reverted: settled === 'reverted' ? 1 : 0 };
}

test('slot fill: a free slot goes to an address-book peer from a missing region, and Core is asked, not probed', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.11', 'EU', { operator: 'Other' }); // Europe has its peer
  const asia = inBook('198.18.0.10', 'AS');
  const peers = setPeers([coreOut()]);
  const disconnects = [];
  rpc.disconnectNode.mock.mockImplementation(async (a) => { disconnects.push(a); });
  const probe = mock.method(manualPeer, 'probePort', async () => true);

  const result = await step(peers, Date.now());

  assert.equal(result.started, 1);
  assert.equal(fill.currentTrial().address, asia);
  assert.ok(isManual(asia));
  assert.equal(ranking().find((p) => p.address === asia).status, 'TESTING');
  assert.equal(probe.mock.callCount(), 0, 'nothing is dialled from this container');
  assert.deepEqual(disconnects, [], 'and nothing of Core\'s is touched');
  assert.equal(logRows().length, 0, 'nothing is logged until Core has connected');
});

test('slot fill: once Core holds a working connection the candidate keeps the slot', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);

  const result = await step(setPeers([coreOut(), manualSession(asia)]), t0 + 10 * MIN);

  assert.equal(result.confirmed, 1);
  assert.equal(fill.currentTrial(), null);
  assert.ok(isManual(asia));
  const [row] = logRows();
  assert.equal(row.action, 'promote');
  assert.match(row.note, /^from the address book · Asia \(JP, /);
});

test('slot fill: while Core has not connected yet, nothing else moves', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  inBook('198.18.0.12', 'OC');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);

  const result = await step(setPeers([coreOut()]), t0 + 5 * MIN);

  assert.deepEqual(result, { started: 0, confirmed: 0, reverted: 0 });
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 2, 'one candidate at a time');
});

test('slot fill: a candidate Core cannot connect to goes again, and is not tried again for a week', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);

  const result = await step(setPeers([coreOut()]), t0 + 16 * MIN);

  assert.equal(result.reverted, 1);
  assert.ok(!isManual(asia));
  const [row] = logRows();
  assert.equal(row.action, 'revert');
  assert.match(row.note, /^Asia \(JP, .*\): Core could not connect in 16 min$/);
  assert.equal((await step(setPeers([coreOut()]), t0 + 17 * MIN)).started, 0, 'the only candidate failed');
});

test('slot fill: blocks found during the trial do not fail a candidate that had the tip when it connected', async () => {
  // Core only moves synced_headers when that peer announces a block first, so
  // a good peer can sit a few blocks behind the tip a quarter of an hour on.
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  rpc.getBlockchainInfo.mock.mockImplementation(async () => ({ blocks: TIP + 4, headers: TIP + 4, initialblockdownload: false }));

  const result = await step(setPeers([coreOut(), manualSession(asia, { synced: TIP })]), t0 + 14 * MIN);

  assert.equal(result.confirmed, 1);
});

test('slot fill: a connection that serves no blocks, or is not on our tip, does not count', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  assert.equal((await step(setPeers([coreOut(), manualSession(asia, { synced: TIP - 50 })]), t0 + 10 * MIN)).confirmed, 0);

  await step(setPeers([coreOut(), manualSession(asia, { services: '0000000000000000' })]), t0 + 16 * MIN);

  assert.ok(!isManual(asia));
  assert.match(logRows()[0].note, /connected, but serves no blocks/);
});

test('slot fill: a swap lets a surplus peer go, and brings it back on its old slot if the candidate fails', async () => {
  const strong = at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const weak = at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  const since = db.instance.prepare('SELECT created_at AS t FROM trusted_peer WHERE address = ?').get(weak).t;
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();

  await step(setPeers([coreOut()]), t0);
  assert.equal(fill.currentTrial().holder.address, weak, 'the weaker of the two in the crowded region');
  assert.ok(!isManual(weak) && isManual(asia) && isManual(strong));

  await step(setPeers([coreOut()]), t0 + 16 * MIN);
  assert.ok(isManual(weak), 'back');
  assert.equal(db.instance.prepare('SELECT created_at AS t FROM trusted_peer WHERE address = ?').get(weak).t, since,
    'on the slot it had held since when it had - no fresh grace for being let go for nothing');
  assert.ok(!isManual(asia));
  assert.match(logRows()[0].note, /Europe \(DE, .*\) back$/);
});

test('slot fill: after a failed swap the next one waits an hour', async () => {
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  inBook('198.18.0.11', 'AS', { operator: 'Second' });
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  await step(setPeers([coreOut()]), t0 + 16 * MIN);

  assert.equal((await step(setPeers([coreOut()]), t0 + 30 * MIN)).started, 0, 'every failed swap cost a peer its connection');
  assert.equal((await step(setPeers([coreOut()]), t0 + 80 * MIN)).started, 1);
});

test('slot fill: a confirmed swap is logged with the region it filled', async () => {
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const weak = at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  await step(setPeers([coreOut(), manualSession(asia)]), t0 + 10 * MIN);

  const [row] = logRows();
  assert.equal(row.action, 'swap');
  assert.equal(row.replaced_address, weak);
  assert.match(row.note, /^from the address book · Asia \(JP, .*\) in for Europe \(DE, .*\): Asia had none$/);
});

test('slot fill: a peer Core uses for compact blocks right now is never let go, in either direction', async () => {
  const a = at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const b = at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  // The ranking snapshot has neither as high-bandwidth; Core says so now.
  const peers = setPeers([coreOut(), manualSession(a, { bip152_hb_to: true }), manualSession(b, { bip152_hb_from: true })]);

  assert.equal((await step(peers, Date.now())).started, 0);
  assert.ok(isManual(a) && isManual(b));
});

test('slot fill: padlocked peers count for their region and are never the one let go', async () => {
  const friend = at(seedLivePeer({ eligible: 144, first: 0, trusted: true, kept: true }), 'EU', 'Friend ISP');
  const own = at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  inBook('198.18.0.10', 'OC');

  await step(setPeers([coreOut()]), Date.now());

  assert.ok(isManual(friend));
  assert.ok(!isManual(own), 'the slot fill\'s own peer in the same region makes room');
});

test('slot fill: a peer that only just took its slot is safe for its grace', async () => {
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true, justPromoted: true }), 'EU');
  at(seedLivePeer({ eligible: 144, first: 5, trusted: true, justPromoted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 0);
});

test('slot fill: a swap never empties a region to fill another', async () => {
  // Two manual peers at one operator in two regions: each is alone in its
  // region, so neither is surplus for a third region's sake.
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU', 'Same Hosting');
  at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'NA', 'Same Hosting');
  inBook('198.18.0.10', 'AS');
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 0);
});

test('slot fill: one operator, one slot', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU', 'Hetzner Online GmbH');
  inBook('198.18.0.10', 'AS', { operator: 'Hetzner Online GmbH' });
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 0, 'not even into a free slot');
});

test('slot fill: an address Core is already connected to is never a candidate', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const disconnects = [];
  rpc.disconnectNode.mock.mockImplementation(async (a) => { disconnects.push(a); });
  const peers = setPeers([coreOut(), { id: 7, addr: '198.18.0.10:51234', network: 'ipv4', connection_type: 'inbound' }]);

  assert.equal((await step(peers, Date.now())).started, 0);
  assert.ok(!isManual(asia));
  assert.deepEqual(disconnects, []);
});

test('slot fill: only networks Core may use and is connected on right now', async () => {
  mock.method(rpc, 'getNetworkInfo', async () => ({
    networks: ['ipv4', 'ipv6', 'onion', 'i2p'].map((name) => ({ name, reachable: true, proxy: name === 'onion' ? '127.0.0.1:9050' : '' })),
  }));
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('2001:db8::10', 'AS', { network: 'ipv6' }); // allowed by onlynet, but no IPv6 route
  const tor = inBook(`${'d'.repeat(56)}.onion`, null, { network: 'onion' });

  assert.equal((await step(setPeers([coreOut('ipv4')]), Date.now())).started, 0, 'no IPv6 or Tor connection of Core\'s own');

  require('../src/lib/peer-rotation/addrbook').resetForTests();
  const result = await step(setPeers([coreOut('ipv4'), coreOut('onion')]), Date.now());
  assert.equal(result.started, 1);
  assert.equal(fill.currentTrial().address, tor);
});

test('slot fill: nothing Core has banned', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  BANNED = [{ address: '198.18.0.0/24' }];
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 0);
});

test('slot fill: without getrawaddrman it waits, and does not fall back to the mixed table', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asked = [];
  rpc.call.mock.mockImplementation(async (method) => {
    asked.push(method);
    if (method === 'listbanned') return [];
    throw new Error('Method not found');
  });
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 0);
  assert.ok(!asked.includes('getnodeaddresses'));
});

test('slot fill: a node still catching up starts nothing', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  rpc.getBlockchainInfo.mock.mockImplementation(async () => ({ blocks: 10, headers: TIP, initialblockdownload: true }));
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 0);
});

test('slot fill: a parked peer is offered first, and parked again one failure further if Core cannot reach it', async () => {
  const parked = at(seedParked({ firstPct: 30 }), 'AS');
  inBook('198.18.0.10', 'AS');
  const parkedAt = db.instance.prepare('SELECT parked_at AS t FROM parked_peer WHERE address = ?').get(parked).t;
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  assert.equal(fill.currentTrial().address, parked);

  await step(setPeers([coreOut()]), t0 + 16 * MIN);

  const row = db.instance.prepare('SELECT * FROM parked_peer WHERE address = ?').get(parked);
  assert.equal(row.probe_failures, 1);
  assert.equal(row.parked_at, parkedAt, 'remembered from when it lost its slot, not from the last try');
});

test('slot fill: a parked peer Core connects to is logged as back', async () => {
  const parked = at(seedParked({ firstPct: 30 }), 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  await step(setPeers([coreOut(), manualSession(parked)]), t0 + 10 * MIN);
  const [row] = logRows();
  assert.equal(row.action, 'revive');
  assert.match(row.note, /^back · Asia/);
});

test('slot fill: parked peers not due yet are left alone, and the weak ones wait longer', async () => {
  const probedAt = Date.now() - 20 * HOUR;
  const strong = at(seedParked({ firstPct: 30, lastProbeAt: probedAt, probeFailures: 6 }), 'AS'); // ceiling 12h: due
  at(seedParked({ firstPct: 1, lastProbeAt: probedAt, probeFailures: 6 }), 'OC'); // ceiling ~46h: not due
  for (let i = 0; i < 3; i++) at(seedParked({ firstPct: 0, probeFailures: 10, lastProbeAt: Date.now() - 20 * HOUR }), 'SA');
  const due = require('../src/lib/peer-rotation/parking').dueParkedPeers(Date.now()).map((r) => r.address);
  assert.deepEqual(due, [strong]);
});

test('slot fill: a weak parked peer is forgotten once its own retention is up, while a strong one is kept', () => {
  const weak = nextAddress();
  const strong = nextAddress();
  const tenDaysAgo = Date.now() - 10 * 24 * HOUR;
  const insert = db.instance.prepare(
    `INSERT INTO parked_peer (address, label, first_pct, eligible, parked_at, last_probe_at, probe_failures)
     VALUES (?, NULL, ?, 200, ?, NULL, 0)`,
  );
  insert.run(weak, 0.8, tenDaysAgo); // 0.8% -> kept 4 days: long gone
  insert.run(strong, 30, tenDaysAgo); // 30% -> kept 150 days: still waiting
  require('../src/lib/peer-rotation/parking').dueParkedPeers(Date.now());
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(weak).n, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM parked_peer WHERE address = ?').get(strong).n, 1);
});

test('slot fill: taken out or padlocked by hand during the trial, the person\'s choice stands', async () => {
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const weak = at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  peerSync.setKept(asia, true);

  await step(setPeers([coreOut()]), t0 + 16 * MIN);

  assert.equal(fill.currentTrial(), null);
  assert.ok(isManual(asia), 'padlocked: it stays');
  assert.ok(!isManual(weak), 'and nothing is undone behind the person\'s back');
  assert.ok(peerRotation.parkedPeers().some((p) => p.address === weak), 'the peer it replaced keeps its record parked');
  assert.equal(logRows().length, 0);
});

test('slot fill: a candidate whose addnode Core refuses leaves the peer it would have replaced in place', async () => {
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const weak = at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => {
    if (cmd === 'add' && addr === asia) throw new Error('Error: Invalid IP/Subnet');
  });
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 0);
  assert.ok(isManual(weak));
  assert.ok(!isManual(asia));
  assert.equal(fill.currentTrial(), null);
});

test('slot fill: in a swap the candidate is added before the peer it replaces is removed', async () => {
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const weak = at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const calls = [];
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => { calls.push(`${cmd} ${addr}`); });
  await step(setPeers([coreOut()]), Date.now());
  assert.deepEqual(calls, [`add ${asia}`, `remove ${weak}`]);
});

test('slot fill: a free slot no gap can fill still goes to someone', async () => {
  // A node with Europe covered and only European candidates: the slot does
  // not stay empty for want of a perfect one.
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const eu = inBook('198.18.0.10', 'EU', { operator: 'Another' });
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 1);
  assert.equal(fill.currentTrial().address, eu);
});

test('slot fill: what it adds carries no padlock; what a person types in does', async () => {
  await peerSync.addTrustedPeer('198.51.100.98:8333', null, { kept: true });
  const asia = inBook('198.18.0.10', 'AS');
  at('198.51.100.98:8333', 'EU');
  await step(setPeers([coreOut()]), Date.now());
  const byAddress = Object.fromEntries(ranking().map((p) => [p.address, p]));
  assert.equal(byAddress['198.51.100.98:8333']?.kept, true);
  assert.equal(byAddress[asia]?.kept, false);
});

test('promotions are remembered after the rotation log has been trimmed away', async (t) => {
  // The funnel counts Core's outbound peers that ever held a manual slot.
  const address = seedLivePeer({ eligible: 300, first: 100 });
  peerRotation.logAction({ action: 'promote', address, note: 'test' });
  assert.equal(queries.outboundFunnel().promoted, 1);
  const saved = config.rotationLogEntries;
  config.rotationLogEntries = 30;
  t.after(() => { config.rotationLogEntries = saved; });
  for (let i = 0; i < config.rotationLogEntries + 5; i += 1) {
    peerRotation.logAction({ action: 'park', address: `198.51.100.${i + 1}:8333`, note: 'filler' });
  }
  assert.equal(db.instance.prepare(`SELECT COUNT(*) AS n FROM rotation_log WHERE action = 'promote'`).get().n, 0);
  assert.equal(queries.outboundFunnel().promoted, 1, 'the count survives the trim');
});

test('REGRESSION: a manual peer always has a peer row, so the slot fill can see it', async () => {
  const address = nextAddress();
  await peerSync.addTrustedPeer(address, 'test');
  assert.ok(db.instance.prepare('SELECT 1 FROM peer WHERE address = ?').get(address));
  assert.ok(ranking().some((p) => p.address === address));
});

// --- The pass as a whole ------------------------------------------------------

test('tick is a complete no-op when the toggle is off', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  setPeers([coreOut()]);
  const result = await peerRotation.tick();
  assert.deepEqual(result, { enabled: false, retired: 0, started: 0, confirmed: 0, reverted: 0, deduped: 0 });
  assert.equal(fill.currentTrial(), null);
});

test('tick runs the slot fill once the toggle is on', async () => {
  peerRotation.setEnabled(true);
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  setPeers([coreOut()]);
  const result = await peerRotation.tick();
  assert.equal(result.enabled, true);
  assert.equal(result.started, 1);
});

test('tick does nothing at all while Core does not answer', async () => {
  peerRotation.setEnabled(true);
  seedOfflineTrustedPeer({ offlineHours: 500, eligible: 500, first: 1 });
  rpc.getPeerInfo.mock.mockImplementation(async () => { throw new Error('connect ECONNREFUSED'); });
  const result = await peerRotation.tick();
  assert.equal(result.retired, 0, 'Core being down is no evidence about any peer');
});

test('a kept peer that has really been connected is not parked when it goes offline', async () => {
  peerRotation.setEnabled(true);
  const address = seedOfflineTrustedPeer({ address: '198.51.100.96:8333', offlineHours: 500, eligible: 500, first: 5, kept: true });
  await peerRotation.tick();
  assert.ok(ranking().find((p) => p.address === address)?.trusted, 'still manual');
  assert.equal(peerRotation.parkedPeers().length, 0, 'and not parked');
});

test('a kept peer Core never managed to connect is parked like any other', async () => {
  // An address that never stood up as an outbound connection is not a peer
  // anyone is keeping; protecting it would let one bad address hold one of
  // eight slots forever.
  peerRotation.setEnabled(true);
  const address = seedOfflineTrustedPeer({
    address: '198.51.100.97:8333', offlineHours: 500, eligible: 500, first: 5, kept: true, everManual: false,
  });
  await peerRotation.tick();
  assert.ok(!ranking().find((p) => p.address === address)?.trusted, 'the slot is freed');
  assert.equal(peerRotation.parkedPeers().length, 1, 'and its record is parked, not thrown away');
});

test('the pass drops an inbound session to a host it already holds as manual', async () => {
  peerRotation.setEnabled(true);
  const disconnects = [];
  mock.method(rpc, 'disconnectNode', async (target) => { disconnects.push(target); });
  setPeers([
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

test('after a reset, a protected manual peer that is offline keeps its slot', async () => {
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

test('slot fill: switched off during a trial, nothing is left half done', async () => {
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const weak = at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  await step(setPeers([coreOut()]), Date.now());
  assert.ok(!isManual(weak));

  peerRotation.setEnabled(false);
  await peerRotation.settleOnSwitchOff();

  assert.equal(fill.currentTrial(), null);
  assert.ok(isManual(weak) && !isManual(asia), 'Core had not connected: undone, the replaced peer back');
  assert.match(logRows()[0].note, /slot fill switched off during the trial · Europe .* back$/);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM slot_fill_tried').get().n, 0, 'and the candidate is not held against');
});

test('slot fill: a trial that outlived a long pause is undone, not retired', async () => {
  // Core down, or the app stopped, for longer than the shortest offline
  // grace: the candidate reads as an hour offline. Retiring it first lost the
  // peer it had replaced for good.
  peerRotation.setEnabled(true);
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const weak = at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  setPeers([coreOut()]);
  await peerRotation.tick();
  assert.equal(fill.currentTrial().address, asia);
  // Two hours later, as far as the trial knows.
  const trial = fill.currentTrial();
  db.instance.prepare("UPDATE meta SET value = ? WHERE key = 'slot_fill_trial'").run(JSON.stringify({ ...trial, startedAt: trial.startedAt - 2 * HOUR }));
  db.instance.prepare('UPDATE trusted_peer SET created_at = ? WHERE address = ?').run(Date.now() - 2 * HOUR, asia);

  const result = await peerRotation.tick();

  assert.equal(result.reverted, 1);
  assert.equal(result.retired, 0);
  assert.ok(isManual(weak), 'the replaced peer is back');
});

test('slot fill: a replaced peer Core will not take back is parked, not lost', async () => {
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const weak = at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  // Meanwhile it dialled in.
  await step(setPeers([coreOut(), { id: 3, addr: weak.replace(':8333', ':50000'), network: 'ipv4', connection_type: 'inbound' }]), t0 + 16 * MIN);

  assert.ok(!isManual(weak));
  assert.ok(peerRotation.parkedPeers().some((p) => p.address === weak));
  assert.match(logRows()[0].note, /not back \(.*already connected to Core\), parked$/);
});

test('slot fill: each failed swap in a row makes the next one wait twice as long', async () => {
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  at(seedLivePeer({ eligible: 144, first: 5, trusted: true }), 'EU');
  for (let i = 0; i < 4; i++) inBook(`198.18.0.${10 + i}`, 'AS', { operator: `AS-${i}` });
  let t = Date.now();
  await step(setPeers([coreOut()]), t);
  await step(setPeers([coreOut()]), t += 16 * MIN); // first failure: an hour
  assert.equal((await step(setPeers([coreOut()]), t + 61 * MIN)).started, 1);
  t += 61 * MIN;
  await step(setPeers([coreOut()]), t += 16 * MIN); // second: two hours
  assert.equal((await step(setPeers([coreOut()]), t + 61 * MIN)).started, 0);
  assert.equal((await step(setPeers([coreOut()]), t + 121 * MIN)).started, 1);
});

test('slot fill: a parked peer waiting out its backoff does not slip in through the address book', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const parked = at(seedParked({ firstPct: 1, lastProbeAt: Date.now() - 10 * MIN, probeFailures: 5 }), 'AS');
  inBook(parked.split(':')[0], 'AS');
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 0);
});

test('slot fill: never this node\'s own address', async () => {
  mock.method(rpc, 'getNetworkInfo', async () => ({
    networks: [{ name: 'ipv4', reachable: true, proxy: '' }],
    localaddresses: [{ address: '198.18.0.10', port: 8333, score: 4 }],
  }));
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 0);
});

test('a peer-data reset forgets which candidates failed', () => {
  db.instance.prepare('INSERT INTO slot_fill_tried (address, tried_at, ok) VALUES (?, ?, 0)').run('198.18.0.99:8333', Date.now());
  db.resetPeerData();
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM slot_fill_tried').get().n, 0);
});
