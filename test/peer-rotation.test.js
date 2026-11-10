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
const { LOG_ENTRIES } = require('../src/lib/peer-rotation/log');

// Where each test address is, set per test with at(). The real table would
// tie these tests to a database that changes every week; an address with no
// entry is unknown, like an onion peer.
const PLACES = new Map();
// Core's "tried" table, as getrawaddrman returns it, and its bans.
let BOOK = {};
let NEWBOOK = {};
let BANNED = [];
// An address Core has only heard of ("new"), passed on `ago` seconds back.
function inNew(host, region, ago = 3600) {
  const address = `${host}:8333`;
  NEWBOOK[`${Object.keys(NEWBOOK).length}`] = { address: host, port: 8333, network: 'ipv4', services: 1033, time: Math.floor(Date.now() / 1000) - ago };
  if (region) at(address, region);
  return address;
}
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
    if (method === 'getrawaddrman') return { new: NEWBOOK, tried: BOOK };
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
  NEWBOOK = {};
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
test('the offline grace: an hour for a peer never first, a day for one that ever was', () => {
  const hours = (pct) => peerRotation.offlineGraceMs(pct) / HOUR;
  assert.equal(hours(null), 1);
  assert.equal(hours(0), 1);
  assert.equal(hours(0.1), 24, 'one block first is enough');
  assert.equal(hours(40), 24, 'and being first often buys no more');
});

test('a manual peer never first loses its slot once it is offline past its hour', async () => {
  const address = seedOfflineTrustedPeer({ eligible: 200, first: 0, offlineHours: 5 });

  const retired = await peerRotation.retireOfflineManualPeers(ranking());

  assert.equal(retired, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(address).n, 0);
  const logRow = db.instance.prepare('SELECT * FROM rotation_log WHERE action = ?').get('retire');
  assert.equal(logRow.address, address);
});

test('a manual peer that was ever first keeps its slot through an outage that retires one that never was', async () => {
  // One block first: a day of grace. Offline for 5 - the outage that just
  // cost the other peer its slot in the test above.
  const strong = seedOfflineTrustedPeer({ eligible: 200, first: 1, offlineHours: 5 });

  const retired = await peerRotation.retireOfflineManualPeers(ranking());

  assert.equal(retired, 0);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer WHERE address = ?').get(strong).n, 1);
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

test('the rotation log never holds more than it can show', async () => {
  // Nothing is kept that is not shown: the table is trimmed on every write to
  // exactly the number the dashboard offers behind "Show all", so there is no
  // retention window to reason about and no way for a misbehaving loop to
  // leave tens of thousands of rows behind before anyone notices.
  const limit = LOG_ENTRIES;

  for (let i = 0; i < limit + 15; i += 1) {
    peerRotation.logAction({ action: 'retire', address: `198.51.100.${i}:8333`, firstPct: 0, eligible: 144, note: `entry ${i}` });
  }

  const stored = db.instance.prepare('SELECT COUNT(*) AS n FROM rotation_log').get().n;
  assert.equal(stored, limit, 'older entries go on the way in, not on a sweep');

  // And it is the NEWEST that survive - trimming the wrong end would quietly
  // freeze the log at whatever it held first.
  const notes = peerRotation.recentLog().map((e) => e.note);
  assert.equal(notes[0], `entry ${limit + 14}`, 'newest first');
  assert.ok(!notes.includes('entry 0'), 'the oldest is gone');
});

/**
 * One host, one spelling. The rotation wrote the bare host that
 * hostFromAddress returns; the backfill kept the brackets an IPv6 address
 * arrives in. Both meant "this host was kept", the primary key could not see
 * that they were the same, and one kept peer was counted as two.
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
  const rows = db.instance.prepare('SELECT address FROM trusted_peer').all().map((r) => r.address);
  assert.ok(rows.includes(keptWeak) && !rows.includes(free));
});

test('a peer without any record can be displaced by hand', async () => {
  seedLivePeer({ connectionType: 'manual', trusted: true, kept: true, eligible: 144, first: 1 });
  seedLivePeer({ connectionType: 'manual', trusted: true });   // unprotected, no record
  const result = await peerSync.addTrustedPeer('198.51.100.212:8333', 'typed', { evictToFit: true, kept: true });
  assert.equal(result.ok, true);
});

test('a manual peer displaced by hand while offline is the one that goes', async () => {
  const offline = seedOfflineTrustedPeer({ eligible: 144, first: 2 });
  seedLivePeer({ connectionType: 'manual', trusted: true, kept: true, eligible: 144, first: 40 });
  const result = await peerSync.addTrustedPeer('198.51.100.213:8333', 'typed', { evictToFit: true, kept: true });
  assert.equal(result.ok, true);
  assert.equal(result.evicted.address, offline);
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
  const before = fill.currentTrial();
  const settled = await fill.settle(peers, chain, now);
  if (settled === 'reverted') peers = fill.withoutSession(peers, before.address);
  const started = settled === 'waiting' ? 0 : await fill.start(ranking(), peers, chain, now);
  return { started: started ? 1 : 0, confirmed: settled === 'confirmed' ? 1 : 0, reverted: settled === 'reverted' ? 1 : 0 };
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
  assert.equal(row.note, 'Asia had none', 'where it is shows under the address; the note says why');
});

test('slot fill: a missing region "tried" has nobody from is looked for in "new", fresh addresses only', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.20', 'EU');
  inNew('198.18.0.21', 'AF', 3 * 86400);
  const africa = inNew('198.18.0.22', 'AF');
  inNew('198.18.0.23', 'EU');

  await step(setPeers([coreOut()]), Date.now());

  assert.equal(fill.currentTrial().address, africa, 'the fresh one, not the one passed on three days ago, and before a region already held');
  assert.equal(fill.currentTrial().fromNew, true);
});

test('slot fill: Core\'s own outbound peers count too - a region they crowd waits behind a thin one', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'AS');
  for (let i = 0; i < 3; i++) at(seedLivePeer({ eligible: 144 }), 'EU');
  inBook('198.18.0.50', 'EU');
  const asia = inBook('198.18.0.51', 'AS');

  await step(setPeers([coreOut()]), Date.now());

  assert.equal(fill.currentTrial().address, asia, 'Asia has one connection, Europe three of Core\'s own');
});

test('slot fill: with clearnet, no second I2P connection - Core\'s own counts - and the note says how few', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  at(seedLivePeer({ eligible: 144 }), 'AS');
  seedLivePeer({ address: `${'k'.repeat(52)}.b32.i2p:0`, eligible: 144 });
  inBook(`${'j'.repeat(52)}.b32.i2p`, null, { port: 0, network: 'i2p' });
  const asia = inBook('198.18.0.80', 'AS');
  const peers = setPeers([coreOut(), coreOut('ipv4', { network: 'i2p' })]);
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({ networks: ['ipv4', 'i2p'].map((name) => ({ name, reachable: true, proxy: '' })) }));

  await step(peers, Date.now());

  assert.equal(fill.currentTrial().address, asia, 'Asia and I2P have one connection each; I2P is full');
  assert.equal(fill.currentTrial().note, 'Asia had only 1');
});

test('slot fill: with clearnet and an I2P connection already, an I2P candidate alone is not taken', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  seedLivePeer({ address: `${'k'.repeat(52)}.b32.i2p:0`, eligible: 144 });
  inBook(`${'j'.repeat(52)}.b32.i2p`, null, { port: 0, network: 'i2p' });
  const peers = setPeers([coreOut(), coreOut('ipv4', { network: 'i2p' })]);
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({ networks: ['ipv4', 'i2p'].map((name) => ({ name, reachable: true, proxy: '' })) }));

  const result = await step(peers, Date.now());

  assert.equal(result.started, 0);
  assert.equal(fill.currentTrial(), null);
});

test('slot fill: a node on Tor alone takes Tor peers for every slot', async () => {
  at(seedLivePeer({ address: `${'t'.repeat(56)}.onion:8333`, eligible: 144, first: 50, trusted: true }), null);
  const tor = inBook(`${'u'.repeat(56)}.onion`, null, { network: 'onion' });
  const peers = setPeers([coreOut('onion')]);
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({ networks: [{ name: 'onion', reachable: true, proxy: '' }] }));

  await step(peers, Date.now());

  assert.equal(fill.currentTrial().address, tor);
});

test('slot fill: no provider Core\'s own outbound peers already use', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  at(seedLivePeer({ eligible: 144 }), 'NA', 'op-shared');
  inBook('198.18.0.60', 'OC', { operator: 'op-shared' });
  const other = inBook('198.18.0.61', 'OC');

  await step(setPeers([coreOut()]), Date.now());

  assert.equal(fill.currentTrial().address, other);
});

test('slot fill: a region whose tried candidates all share a provider in use still looks in "new"', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU', 'op-busy');
  inBook('198.18.0.70', 'AF', { operator: 'op-busy' });
  const africa = inNew('198.18.0.71', 'AF');

  await step(setPeers([coreOut()]), Date.now());

  assert.equal(fill.currentTrial().address, africa);
});

test('slot fill: a region "tried" can fill does not look in "new"', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.30', 'AS');
  inNew('198.18.0.31', 'AS');

  await step(setPeers([coreOut()]), Date.now());

  assert.equal(fill.currentTrial().address, asia);
});

test('slot fill: an address from "new" Core cannot reach is given up at the next pass', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const africa = inNew('198.18.0.40', 'AF');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);

  const result = await step(setPeers([coreOut()]), t0 + 10 * MIN);

  assert.equal(result.reverted, 1, 'out after one pass, not after a quarter of an hour');
  assert.ok(!isManual(africa));
});

test('slot fill: while Core has not connected yet, nothing else moves', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  inBook('198.18.0.12', 'OC');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);

  const result = await step(setPeers([coreOut()]), t0 + 4 * MIN);

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
  assert.deepEqual(logRows(), [], 'a candidate that did not work is not news');
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
  assert.equal(db.instance.prepare('SELECT ok FROM slot_fill_tried WHERE address = ?').get(asia).ok, 0, 'held against it for a week');
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

test('slot fill: padlocked by hand during the trial, the person\'s choice stands', async () => {
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  peerSync.setKept(asia, true);

  await step(setPeers([coreOut()]), t0 + 16 * MIN);

  assert.equal(fill.currentTrial(), null);
  assert.ok(isManual(asia), 'padlocked: it stays');
  assert.equal(logRows().length, 0);
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

test('promotions are remembered after the rotation log has been trimmed away', async () => {
  const address = seedLivePeer({ eligible: 300, first: 100 });
  peerRotation.logAction({ action: 'promote', address, note: 'test' });
  const kept = () => db.instance.prepare(`SELECT COUNT(*) AS n FROM promoted_peer`).get().n;
  assert.equal(kept(), 1);
  for (let i = 0; i < LOG_ENTRIES + 5; i += 1) {
    peerRotation.logAction({ action: 'retire', address: `198.51.100.${i + 1}:8333`, note: 'filler' });
  }
  assert.equal(db.instance.prepare(`SELECT COUNT(*) AS n FROM rotation_log WHERE action = 'promote'`).get().n, 0);
  assert.equal(kept(), 1, 'the record survives the trim');
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
  assert.deepEqual(result, { enabled: false, retired: 0, started: 0, confirmed: 0, reverted: 0 });
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

test('a kept peer that has really been connected keeps its slot when it goes offline', async () => {
  peerRotation.setEnabled(true);
  const address = seedOfflineTrustedPeer({ address: '198.51.100.96:8333', offlineHours: 500, eligible: 500, first: 5, kept: true });
  await peerRotation.tick();
  assert.ok(ranking().find((p) => p.address === address)?.trusted, 'still manual');
});

test('a kept peer Core never managed to connect loses its slot like any other', async () => {
  // An address that never stood up as an outbound connection is not a peer
  // anyone is keeping; protecting it would let one bad address hold one of
  // eight slots forever.
  peerRotation.setEnabled(true);
  const address = seedOfflineTrustedPeer({
    address: '198.51.100.97:8333', offlineHours: 500, eligible: 500, first: 5, kept: true, everManual: false,
  });
  await peerRotation.tick();
  assert.ok(!ranking().find((p) => p.address === address)?.trusted, 'the slot is freed');
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
  const asia = inBook('198.18.0.10', 'AS');
  await step(setPeers([coreOut()]), Date.now());

  peerRotation.setEnabled(false);
  await peerRotation.settleOnSwitchOff();

  assert.equal(fill.currentTrial(), null);
  assert.ok(!isManual(asia), 'Core had not connected: taken out again');
  assert.deepEqual(logRows(), []);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM slot_fill_tried').get().n, 0, 'and the candidate is not held against');
});

test('slot fill: a trial that outlived a long pause is undone, not retired', async () => {
  // Core down, or the app stopped, for longer than the shortest offline
  // grace: the candidate reads as an hour offline. Retiring it first lost the
  // peer it had replaced for good.
  peerRotation.setEnabled(true);
  at(seedLivePeer({ eligible: 144, first: 90, trusted: true }), 'EU');
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
  assert.ok(!isManual(asia));
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

test('REGRESSION: two sessions started in the same second - the live one is what the row shows', () => {
  // Core opened two connections to a manual peer in one second: one that
  // never finished its handshake (no client, no services) and the one that
  // did. The tie picked the failed one, and a working peer read "offers no
  // services" for hours.
  const address = nextAddress();
  const peer = db.getOrCreatePeer(address);
  const at0 = Date.now() - HOUR;
  const insert = db.instance.prepare(
    'INSERT INTO peer_session (peer_id, direction, connection_type, started_at, ended_at, subver, services) VALUES (?, ?, ?, ?, ?, ?, ?)');
  // In the order Core reported them: the failed one first.
  insert.run(peer.id, 'outbound', 'manual', at0, at0 + 1000, null, '');
  insert.run(peer.id, 'outbound', 'manual', at0, null, '/Satoshi:0.18.0/', 'NETWORK,WITNESS');
  db.instance.prepare('INSERT INTO trusted_peer (address, label, kept, created_at) VALUES (?, NULL, 0, ?)').run(address, at0);
  const row = ranking().find((p) => p.address === address);
  assert.equal(row.client, '/Satoshi:0.18.0/');
  assert.equal(row.offersNothing, false);
});

test('slot fill: switched off while a pass is adding, the candidate is taken out, not left unjudged', async () => {
  peerRotation.setEnabled(true);
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  setPeers([coreOut()]);
  // The switch goes off in the dashboard while this pass is inside its add.
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => {
    if (cmd === 'add' && addr === asia) {
      peerRotation.setEnabled(false);
      await peerRotation.settleOnSwitchOff(); // sees the trial, but no row yet
    }
  });
  const result = await peerRotation.tick();
  assert.equal(result.started, 0);
  assert.ok(!isManual(asia));
  assert.equal(fill.currentTrial(), null);
});

test('slot fill: the sync never adopts the candidate between its addnode and its row', async () => {
  const asia = '198.18.0.10:8333';
  db.instance.prepare("INSERT INTO meta (key, value) VALUES ('slot_fill_trial', ?)").run(JSON.stringify({ address: asia, startedAt: Date.now() }));
  mock.method(rpc, 'getAddedNodeInfo', async () => [{ addednode: asia }]);
  await peerSync.adoptExternalManualPeers();
  assert.ok(!isManual(asia), 'not taken in as somebody else\'s addnode, padlocked');
});

test('slot fill: a trial whose candidate never got its row is cleared, and Core told to drop it', async () => {
  const asia = '198.18.0.10:8333';
  const t0 = Date.now() - 5 * MIN;
  db.instance.prepare("INSERT INTO meta (key, value) VALUES ('slot_fill_trial', ?)").run(JSON.stringify({ address: asia, startedAt: t0 }));
  const calls = [];
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => { calls.push(`${cmd} ${addr}`); });
  assert.equal(await fill.settle([], { headers: TIP }, Date.now()), 'left');
  assert.equal(fill.currentTrial(), null);
  assert.deepEqual(calls, [`remove ${asia}`]);
});

test('REGRESSION: a cleared trial whose remove Core did not take is removed again, never adopted', async () => {
  // Core timed out on the remove: the trial is gone, Core still lists the
  // candidate, and the next sync used to take it in as somebody else's
  // addnode - padlocked, for good.
  const asia = '198.18.0.10:8333';
  db.instance.prepare("INSERT INTO meta (key, value) VALUES ('slot_fill_trial', ?)").run(JSON.stringify({ address: asia, startedAt: Date.now() - 5 * MIN }));
  const calls = [];
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => {
    calls.push(`${cmd} ${addr}`);
    if (calls.length === 1) throw new Error('timeout');
  });
  assert.equal(await fill.settle([], { headers: TIP }, Date.now()), 'left');
  assert.equal(fill.currentTrial(), null);
  mock.method(rpc, 'getAddedNodeInfo', async () => [{ addednode: asia }]);
  await peerSync.adoptExternalManualPeers();
  assert.ok(!isManual(asia), 'not adopted');
  assert.deepEqual(calls, [`remove ${asia}`, `remove ${asia}`], 'the sync told Core again');
});

test('a peer whose last connection never finished its handshake is not "offers nothing"', () => {
  const at0 = Date.now() - 3 * HOUR;
  const insert = db.instance.prepare(`INSERT INTO peer_session
    (peer_id, direction, connection_type, started_at, ended_at, subver, services, min_ping_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const seed = (sessions) => {
    const address = nextAddress();
    const peer = db.getOrCreatePeer(address);
    for (const s of sessions) insert.run(peer.id, 'outbound', 'manual', ...s);
    db.instance.prepare('INSERT INTO trusted_peer (address, label, kept, created_at) VALUES (?, NULL, 0, ?)').run(address, at0);
    return ranking().find((p) => p.address === address);
  };
  // A working node, then a retry that failed: offline now.
  let row = seed([[at0, at0 + HOUR, '/Satoshi:0.18.0/', 'NETWORK,WITNESS', 180], [at0 + 2 * HOUR, at0 + 2 * HOUR + 1000, null, '', null]]);
  assert.equal(row.offersNothing, false);
  assert.equal(row.client, '/Satoshi:0.18.0/');
  // Connected right now, handshake not finished, nothing known before: unknown.
  row = seed([[Date.now() - 2000, null, null, '', null]]);
  assert.equal(row.offersNothing, false);
  // A peer that did finish its handshake - empty user agent, but a ping - and
  // announces no services really does offer nothing.
  row = seed([[at0, null, null, '', 50]]);
  assert.equal(row.offersNothing, true);
});

test('slot fill: an address already in Core\'s addnode list is somebody else\'s, and skipped', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  rpc.addNode.mock.mockImplementation(async (addr, cmd) => {
    if (cmd === 'add' && addr === asia) throw new Error('Error: Node already added');
  });
  assert.equal((await step(setPeers([coreOut()]), Date.now())).started, 0);
  assert.ok(!isManual(asia), 'no row, so no failed trial can later remove that entry');
});

test('a manual peer Core has just reconnected is not retired on an old picture', async () => {
  peerRotation.setEnabled(true);
  const address = seedOfflineTrustedPeer({ offlineHours: 500, eligible: 500, first: 1 });
  setPeers([{ id: 4, addr: address, network: 'ipv4', connection_type: 'manual' }]);
  const result = await peerRotation.tick();
  assert.equal(result.retired, 0);
  assert.ok(isManual(address));
});

test('REGRESSION: a manual peer Core reconnects during the pass is not retired', async () => {
  // Absent from the pass's getpeerinfo, back by the time it would go: the
  // remove would have cut the new connection.
  const address = seedOfflineTrustedPeer({ offlineHours: 500, eligible: 500, first: 0 });
  rpc.getPeerInfo.mock.mockImplementation(async () => [{ id: 4, addr: address, network: 'ipv4', connection_type: 'manual' }]);
  const disconnects = [];
  rpc.disconnectNode.mock.mockImplementation(async (id) => { disconnects.push(id); });
  assert.equal(await peerRotation.retireOfflineManualPeers(ranking(), null, []), 0);
  assert.ok(isManual(address));
  assert.deepEqual(disconnects, []);
});

test('a manual peer is not retired while Core does not answer the check before', async () => {
  const address = seedOfflineTrustedPeer({ offlineHours: 500, eligible: 500, first: 0 });
  rpc.getPeerInfo.mock.mockImplementation(async () => { throw new Error('timeout'); });
  assert.equal(await peerRotation.retireOfflineManualPeers(ranking(), null, []), 0);
  assert.ok(isManual(address));
});

test('switched off while Core did not answer, the trial is settled on a later pass', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  await step(setPeers([coreOut()]), Date.now() - 5 * MIN);
  peerRotation.setEnabled(false);
  rpc.getPeerInfo.mock.mockImplementation(async () => { throw new Error('timeout'); });
  await peerRotation.settleOnSwitchOff();
  assert.ok(fill.currentTrial(), 'still open');
  setPeers([coreOut()]);
  await peerRotation.tick();
  assert.equal(fill.currentTrial(), null);
  assert.ok(!isManual(asia));
});

// --- Deadlines by network, and the next candidate at once ---------------------

test('slot fill: no connection to a clearnet candidate by 5 minutes - out, and the next goes in that pass', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const oceania = inBook('198.18.0.12', 'OC');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  const first = fill.currentTrial().address;
  const second = first === asia ? oceania : asia;

  assert.equal((await step(setPeers([coreOut()]), t0 + 4 * MIN)).reverted, 0, 'still waiting at 4 minutes');
  const result = await step(setPeers([coreOut()]), t0 + 5 * MIN);

  assert.equal(result.reverted, 1);
  assert.equal(result.started, 1, 'no ten-minute pause behind a candidate that did not answer');
  assert.equal(fill.currentTrial().address, second);
  assert.ok(!isManual(first));
});

test('slot fill: a Tor candidate gets 10 minutes to connect', async () => {
  at(seedLivePeer({ address: `${'t'.repeat(56)}.onion:8333`, eligible: 144, first: 50, trusted: true }), null);
  const tor = inBook(`${'u'.repeat(56)}.onion`, null, { network: 'onion' });
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({ networks: [{ name: 'onion', reachable: true, proxy: '' }] }));
  const t0 = Date.now();
  await step(setPeers([coreOut('onion')]), t0);

  assert.equal((await step(setPeers([coreOut('onion')]), t0 + 9 * MIN)).reverted, 0);
  assert.equal((await step(setPeers([coreOut('onion')]), t0 + 10 * MIN)).reverted, 1);
  assert.ok(!isManual(tor));
});

test('slot fill: an I2P candidate gets 15 minutes to connect', async () => {
  at(seedLivePeer({ address: `${'t'.repeat(52)}.b32.i2p:0`, eligible: 144, first: 50, trusted: true }), null);
  const i2p = inBook(`${'v'.repeat(52)}.b32.i2p`, null, { network: 'i2p', port: 0 });
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({ networks: [{ name: 'i2p', reachable: true, proxy: '' }] }));
  const t0 = Date.now();
  await step(setPeers([coreOut('i2p')]), t0);
  assert.equal(fill.currentTrial().address, i2p);

  assert.equal((await step(setPeers([coreOut('i2p')]), t0 + 14 * MIN)).reverted, 0);
  assert.equal((await step(setPeers([coreOut('i2p')]), t0 + 15 * MIN)).reverted, 1);
});

test('slot fill: connected but with no header height yet - no verdict for 30 minutes, and it keeps the slot once the height comes', async () => {
  // A peer a block or two behind answers the first headers request with
  // nothing, and Core shows -1 until that peer announces a block.
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);

  assert.equal((await step(setPeers([coreOut(), manualSession(asia, { synced: -1 })]), t0 + 20 * MIN)).reverted, 0, 'not yet a verdict');
  assert.ok(isManual(asia));
  assert.equal((await step(setPeers([coreOut(), manualSession(asia, { synced: TIP + 1 })]), t0 + 25 * MIN)).confirmed, 1);
});

test('slot fill: still no header height after 30 minutes - out', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);

  assert.equal((await step(setPeers([coreOut(), manualSession(asia, { synced: -1 })]), t0 + 30 * MIN)).reverted, 1);
  assert.ok(!isManual(asia));
});

test('slot fill: a height that is not ours is out at 15 minutes, as before', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);

  assert.equal((await step(setPeers([coreOut(), manualSession(asia, { synced: TIP - 50 })]), t0 + 14 * MIN)).reverted, 0);
  assert.equal((await step(setPeers([coreOut(), manualSession(asia, { synced: TIP - 50 })]), t0 + 15 * MIN)).reverted, 1);
});

// Moves the open trial back in time, as if it had been running that long.
function ageTrial(ms) {
  const row = db.instance.prepare(`SELECT value FROM meta WHERE key = 'slot_fill_trial'`).get();
  const trial = JSON.parse(row.value);
  trial.startedAt -= ms;
  db.instance.prepare(`UPDATE meta SET value = ? WHERE key = 'slot_fill_trial'`).run(JSON.stringify(trial));
}

test('tick: a candidate taken out is followed by the next in the same pass', async () => {
  peerRotation.setEnabled(true);
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  inBook('198.18.0.12', 'OC');
  setPeers([coreOut()]);
  await peerRotation.tick();
  const first = fill.currentTrial().address;

  ageTrial(6 * MIN);
  const result = await peerRotation.tick();

  assert.equal(result.reverted, 1);
  assert.equal(result.started, 1);
  assert.notEqual(fill.currentTrial().address, first);
});

test('tick: Core not answering right after a candidate went - the next pass starts the next one', async () => {
  peerRotation.setEnabled(true);
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  inBook('198.18.0.12', 'OC');
  setPeers([coreOut()]);
  await peerRotation.tick();
  ageTrial(6 * MIN);
  let calls = 0;
  rpc.getPeerInfo.mock.mockImplementation(async () => {
    calls += 1;
    if (calls > 1) throw new Error('connect ECONNREFUSED');
    return [coreOut()];
  });

  const result = await peerRotation.tick();

  assert.ok(calls >= 3, 'asked again after the candidate went (the old code stopped at two), and that failed');
  assert.equal(result.reverted, 1);
  assert.equal(result.started, 0);
  assert.equal(fill.currentTrial(), null);
});

test('watchTrial: nothing without a trial, a verdict with one', async () => {
  peerRotation.setEnabled(true);
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  setPeers([coreOut()]);
  const calls = rpc.getPeerInfo.mock.callCount();

  assert.equal(await peerRotation.watchTrial(), null);
  assert.equal(rpc.getPeerInfo.mock.callCount(), calls, 'not even a getpeerinfo');

  await peerRotation.tick();
  ageTrial(6 * MIN);
  const result = await peerRotation.watchTrial();

  assert.equal(result.reverted, 1);
});

test('watchTrial: switched off, nothing happens', async () => {
  peerRotation.setEnabled(false);
  assert.equal(await peerRotation.watchTrial(), null);
});

test('tick: two passes at once - the second does nothing, so no second candidate goes in', async () => {
  peerRotation.setEnabled(true);
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  inBook('198.18.0.10', 'AS');
  inBook('198.18.0.12', 'OC');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  rpc.getPeerInfo.mock.mockImplementation(async () => { await held; return [coreOut()]; });

  const first = peerRotation.tick();
  const second = await peerRotation.tick();
  release();
  const done = await first;

  assert.deepEqual([second.started, second.reverted, second.confirmed], [0, 0, 0]);
  assert.equal(done.started, 1);
  assert.equal(db.instance.prepare('SELECT COUNT(*) AS n FROM trusted_peer').get().n, 2, 'one candidate only');
});

// --- Why a trial ended, kept in the database -----------------------------------

const triedRow = (address) => db.instance.prepare('SELECT ok, reason, started_at, network FROM slot_fill_tried WHERE address = ?').get(address);

test('slot fill: a trial that ended without a connection keeps its reason, start and network', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  await step(setPeers([coreOut()]), t0 + 5 * MIN);

  assert.deepEqual(triedRow(asia), { ok: 0, reason: 'no_connection', started_at: t0, network: 'clearnet' });
});

async function endTrialWith(session, waitedMin) {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  await step(setPeers([coreOut(), manualSession(asia, session)]), t0 + waitedMin * MIN);
  return triedRow(asia);
}

test('slot fill: the reason tells serves-no-blocks from a wrong height', async () => {
  assert.equal((await endTrialWith({ services: '0000000000000000' }, 15)).reason, 'no_services');
});

test('slot fill: a height that is not ours is recorded as such', async () => {
  assert.equal((await endTrialWith({ synced: TIP - 50 }, 15)).reason, 'height_wrong');
});

test('slot fill: no header height after the long wait is recorded as unknown, not as wrong', async () => {
  assert.equal((await endTrialWith({ synced: -1 }, 30)).reason, 'height_unknown');
});

test('slot fill: a candidate that was kept is recorded as ok, with how long it took', async () => {
  at(seedLivePeer({ eligible: 144, first: 50, trusted: true }), 'EU');
  const asia = inBook('198.18.0.10', 'AS');
  const t0 = Date.now();
  await step(setPeers([coreOut()]), t0);
  await step(setPeers([coreOut(), manualSession(asia)]), t0 + 2 * MIN);

  assert.deepEqual(triedRow(asia), { ok: 1, reason: 'ok', started_at: t0, network: 'clearnet' });
});

test('slot fill: a Tor candidate is recorded as tor', async () => {
  at(seedLivePeer({ address: `${'t'.repeat(56)}.onion:8333`, eligible: 144, first: 50, trusted: true }), null);
  const tor = inBook(`${'u'.repeat(56)}.onion`, null, { network: 'onion' });
  rpc.getNetworkInfo.mock.mockImplementation(async () => ({ networks: [{ name: 'onion', reachable: true, proxy: '' }] }));
  const t0 = Date.now();
  await step(setPeers([coreOut('onion')]), t0);
  await step(setPeers([coreOut('onion')]), t0 + 10 * MIN);

  assert.equal(triedRow(tor).network, 'tor');
});
