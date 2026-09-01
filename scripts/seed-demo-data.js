'use strict';

// Dev tooling, not part of the running app (excluded from the Docker build
// via .dockerignore, not a listed dependency). Fills a fresh SQLite DB with
// plausible-looking synthetic data - only RFC 5737 documentation-range IPs
// (203.0.113.0/24, 198.51.100.0/24, 192.0.2.0/24), nothing real - so the
// dashboard can be screenshotted for the README/store listing without a
// live Bitcoin Core node. Never run against a real DB.
//
// Every pool gets observations in nearly every race (a rare miss, not a
// permanent absence) and every relay-race peer gets a share of "firsts" -
// a screenshot with half the rows reading "-" looks like a broken app, not
// a demo of one. Pairs with mock-rpc-server.js, which is what makes the
// "Block Height" tile show a real number instead of staying blank (that
// tile hits live Bitcoin Core RPC, not this DB).
//
// Usage: MOCK_RPC_PORT=18332 node scripts/mock-rpc-server.js &
//        DATA_DIR=/tmp/bitcoin-lab-demo node scripts/seed-demo-data.js
//        DATA_DIR=/tmp/bitcoin-lab-demo BITCOIN_RPC_HOST=127.0.0.1 \
//          BITCOIN_RPC_PORT=18332 node src/dashboard-server.js
//        npm install --no-save playwright && node scripts/screenshot.js

process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/bitcoin-lab-demo';
const fs = require('fs');
fs.mkdirSync(`${process.env.DATA_DIR}/sqlite`, { recursive: true });

const db = require('../src/lib/db');
db.open();
const inst = db.instance;

const now = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CURRENT_HEIGHT = Number(process.env.MOCK_RPC_HEIGHT || 921845);

// --- Peers -------------------------------------------------------------------
// Modelled on a real, long-running Umbrel node rather than invented from
// scratch: 206 connections, 188 of them inbound, 18 outbound of which 8 are
// the manual set. That shape matters for a screenshot. A demo with a dozen
// peers cannot show the two things this app is actually about - that the
// ranking has a long tail worth filtering ("showing 10 of 206"), and that a
// full outbound table is mostly 0.0% peers waiting to be replaced.
const LIVE_INBOUND = 188;
const LIVE_OUTBOUND_NON_MANUAL = 10; // 8 full-relay + 2 block-relay-only
const MANUAL_COUNT = 8;              // Core's MAX_ADDNODE_CONNECTIONS

const CLIENTS = ['/Satoshi:29.0.0/', '/Satoshi:28.1.0/', '/Satoshi:28.0.0/', '/Satoshi:27.2.0/', '/Satoshi:27.1.0/', '/Satoshi:26.2.0/'];

// Deterministic pseudo-randomness: a seeded generator rather than
// Math.random, so re-running this produces the same database and a
// regenerated screenshot differs only where the app itself changed.
let rngState = 20260901;
function rnd() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// Every peer gets its own ping, session length, history depth and client.
// Uniform columns are what make seeded data look seeded - real rows disagree
// with each other in every column at once.
function addPeer(address, subver, connType, direction, opts = {}) {
  const peer = db.getOrCreatePeer(address);
  const live = opts.live !== false;
  const startedAt = now - (opts.sessionMinutes || 45) * 60 * 1000;
  const ping = opts.pingMs || 30;
  const insert = inst.prepare(
    `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, ended_at, min_ping_ms, last_ping_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(peer.id, opts.corePeerId || peer.id, direction, connType, subver, startedAt, live ? null : now - (opts.offlineMinutes || 12) * 60 * 1000, ping, ping);
  // Older, closed sessions, so "Sessions" and "Total Time" read like a peer
  // with a history rather than one that appeared this morning.
  const past = opts.pastSessions ?? 0;
  for (let i = 0; i < past; i++) {
    const s = now - (opts.ageDays || 20) * DAY + i * 2 * DAY;
    insert.run(peer.id, peer.id, direction, connType, subver, s, s + (opts.pastSessionHours || 6) * HOUR, ping, ping);
  }
  return peer;
}

function trust(address, label) {
  inst
    .prepare(`INSERT OR IGNORE INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)`)
    .run(address, label || null, now - between(10, 40) * DAY);
}

// address, first, eligible, ping, session minutes, past sessions - the
// lifetime records are taken from a real node's ranking, so the spread
// between a 42% peer and a 0.4% one is a spread that actually occurs.
const MANUALS = [
  ['203.0.113.188:8333', 155, 363, 16, 3480, 0],
  ['198.51.100.195:8333', 117, 443, 18, 3600, 3],
  ['203.0.113.40:8333', 54, 449, 99, 3600, 4],
  ['198.51.100.78:8333', 24, 442, 20, 3600, 3],
  ['192.0.2.94:8333', 21, 450, 21, 3480, 3],
  ['203.0.113.167:8333', 2, 300, 16, 2880, 0],
  ['198.51.100.77:8333', 1, 154, 24, 118, 2],
  ['192.0.2.50:8333', 2, 449, 116, 3540, 4],
];

// Inbound peers can outrank most of the outbound set - which is the whole
// reason they are ranked and promotable at all.
const RANKED_INBOUND = [
  ['192.0.2.79:8333', 60, 298, 19, 2820, 0],
  ['198.51.100.108:8333', 2, 200, 96, 1870, 0],
  ['203.0.113.195:8333', 2, 357, 29, 3420, 0],
];

// The automatic outbound set: every one of them at 0.0%, with wildly
// different amounts of time to have proved otherwise. This is what the
// rotation loop exists to churn through.
const PLAIN_OUTBOUND = [
  ['203.0.113.64:8333', 8, 18, 118, 'outbound-full-relay'],
  ['198.51.100.49:8333', 57, 19, 572, 'outbound-full-relay'],
  ['192.0.2.152:8333', 54, 27, 546, 'block-relay-only'],
  ['203.0.113.213:8333', 8, 31, 115, 'outbound-full-relay'],
  ['198.51.100.193:8333', 97, 46, 966, 'block-relay-only'],
  ['192.0.2.104:8333', 8, 116, 117, 'outbound-full-relay'],
  ['203.0.113.207:8333', 130, 157, 1284, 'outbound-full-relay'],
  ['198.51.100.174:8333', 137, 161, 1342, 'outbound-full-relay'],
  ['192.0.2.14:8333', 6, 259, 72, 'outbound-full-relay'],
  ['203.0.113.14:8333', 41, 286, 467, 'outbound-full-relay'],
];

// peer row -> { eligible, first }, applied in one pass further down.
const relayPlan = [];

for (const [address, first, eligible, ping, sessionMinutes, pastSessions] of MANUALS) {
  const peer = addPeer(address, pick(CLIENTS), 'manual', 'outbound', {
    pingMs: ping, sessionMinutes, pastSessions, ageDays: between(40, 95), pastSessionHours: between(4, 20),
  });
  trust(address);
  relayPlan.push({ peer, eligible, first });
}

for (const [address, first, eligible, ping, sessionMinutes] of RANKED_INBOUND) {
  const peer = addPeer(address, pick(CLIENTS), 'inbound', 'inbound', {
    pingMs: ping, sessionMinutes, pastSessions: between(0, 2), ageDays: between(10, 40),
  });
  relayPlan.push({ peer, eligible, first });
}

for (const [address, eligible, ping, sessionMinutes, connType] of PLAIN_OUTBOUND) {
  const peer = addPeer(address, pick(CLIENTS), connType, 'outbound', {
    pingMs: ping, sessionMinutes, pastSessions: 0, ageDays: between(2, 20),
  });
  relayPlan.push({ peer, eligible, first: 0 });
}

// A sibling app on the same Umbrel (electrs) talking to Core's P2P port -
// labelled as such rather than shown as a meaningless internal IP.
addPeer('10.21.21.10:53400', '/electrs:0.11.1/', 'inbound', 'inbound', {
  ageDays: 12, pingMs: 2, pastSessions: 9, sessionMinutes: 4300,
});

// The long tail: inbound connections that come and go. Most have been around
// for a few blocks at most, which is exactly why the ranking needs an
// eligibility threshold before it acts on anyone.
const usedInbound = RANKED_INBOUND.length + 1;
for (let i = 0; i < LIVE_INBOUND - usedInbound; i++) {
  const address = `198.51.100.${(i % 254) + 1}:${18000 + i}`;
  const eligible = rnd() < 0.45 ? 0 : between(1, 60);
  const peer = addPeer(address, pick(CLIENTS), 'inbound', 'inbound', {
    pingMs: between(12, 340),
    sessionMinutes: between(3, 4000),
    pastSessions: rnd() < 0.3 ? between(1, 3) : 0,
    ageDays: between(1, 30),
    pastSessionHours: between(1, 12),
  });
  if (eligible > 0) relayPlan.push({ peer, eligible, first: 0 });
}

// --- Relay races (First/Eligible %) -------------------------------------------
// Races are shared rows; a peer is eligible for the most recent N of them,
// where N is the eligible count its row should show. Firsts are then handed
// out so that no race has two - Core credits exactly one peer per block (only
// the peer whose block was new to the node), and demo data that broke that
// invariant would be showing something the app can never actually produce.
const RACE_COUNT = 450;
const raceIds = [];
for (let i = 0; i < RACE_COUNT; i++) {
  const height = CURRENT_HEIGHT - (RACE_COUNT - 1 - i);
  raceIds.push(
    inst
      .prepare(`INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, ?, ?)`)
      .run(`00000000000000000001${height.toString(16).padStart(6, '0')}${'a'.repeat(36)}`, height, now - (RACE_COUNT - i) * 10 * 60 * 1000)
      .lastInsertRowid,
  );
}

// Most-constrained first: a peer eligible for only 154 races has far fewer
// places to put its firsts than one eligible for all 450, so it claims first.
const claimed = new Set();
const insertObs = inst.prepare(`INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)`);
const seedRelay = inst.transaction((plan) => {
  for (const entry of [...plan].sort((a, b) => a.eligible - b.eligible)) {
    const window = raceIds.slice(RACE_COUNT - entry.eligible);
    const firsts = new Set();
    if (entry.first > 0) {
      // Spread them across the window rather than clustering at one end.
      const stride = window.length / entry.first;
      for (let k = 0; firsts.size < entry.first && k < window.length * 2; k++) {
        const raceId = window[Math.min(window.length - 1, Math.floor((k * stride) % window.length))];
        if (claimed.has(raceId)) continue;
        claimed.add(raceId);
        firsts.add(raceId);
      }
      for (const raceId of window) {
        if (firsts.size >= entry.first) break;
        if (claimed.has(raceId)) continue;
        claimed.add(raceId);
        firsts.add(raceId);
      }
    }
    for (const raceId of window) insertObs.run(raceId, entry.peer.id, firsts.has(raceId) ? 1 : 0);
  }
});
seedRelay(relayPlan);

// --- Stratum pools + races -----------------------------------------------------
inst
  .prepare(`INSERT OR IGNORE INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 0, ?)`)
  .run('GoBrrr', 'gobrrr-pool_ckpool_1', 3333, now - 25 * DAY);

const pools = inst.prepare(`SELECT id, label FROM stratum_pool ORDER BY id`).all();
// One baseline latency per pool - close together on purpose, like real solo
// pools on similar connections, so the winner varies race to race instead
// of the same pool sweeping every single one.
const baseline = {};
pools.forEach((p, idx) => {
  baseline[p.id] = 60 + idx * 15 + Math.random() * 20;
});

const STRATUM_RACE_COUNT = 20; // > the default "Last 10 blocks" window
for (let i = 0; i < STRATUM_RACE_COUNT; i++) {
  const raceId = inst
    .prepare(`INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)`)
    .run(`00000000000000000002${i.toString(16).padStart(6, '0')}${'b'.repeat(36)}`, now - (STRATUM_RACE_COUNT - i) * 9 * 60 * 1000)
    .lastInsertRowid;

  const latencies = pools.map((p) => ({
    pool: p,
    // ~6% chance a given pool misses a given race - present almost
    // everywhere, not a coin flip - and never every pool at once.
    miss: Math.random() < 0.06,
    latencyMs: baseline[p.id] * (0.85 + Math.random() * 0.5),
  }));
  const ranked = latencies.filter((l) => !l.miss).sort((a, b) => a.latencyMs - b.latencyMs);
  ranked.forEach((l, rank) => {
    inst
      .prepare(`INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, ?, ?)`)
      .run(raceId, l.pool.id, l.latencyMs, rank + 1);
  });
  latencies
    .filter((l) => l.miss)
    .forEach((l) => {
      inst
        .prepare(`INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, NULL, NULL)`)
        .run(raceId, l.pool.id);
    });
}

// --- Peer rotation -----------------------------------------------------------
// The toggle on, plus a plausible day of activity, so the Peer Rotation panel
// shows what it actually does rather than an empty table.
inst
  .prepare(`INSERT INTO meta (key, value) VALUES ('peer_rotation_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
  .run();

const rotationLog = [
  ['kick', '198.51.100.203:8333', 0, 197, null, null, 'outbound-full-relay, 0/197 blocks first', 0.7],
  ['revive', '203.0.113.140:8333', 18.9, 302, null, null, 'answered again and took a free manual slot', 2.1],
  ['kick', '203.0.113.180:8333', 0, 161, null, null, 'block-relay-only, 0/161 blocks first', 3.4],
  ['park', '192.0.2.240:8333', 1.2, 188, null, null, 'offline 4h - past the 1h its record earned; parked for re-testing', 6.5],
  ['swap', '198.51.100.20:8333', 22.6, 168, '192.0.2.240:8333', 4.1, 'replaced the weakest current manual peer', 9.2],
  ['kick', '192.0.2.19:8333', 0, 152, null, null, 'outbound-full-relay, 0/152 blocks first', 14.8],
  ['promote', '203.0.113.55:8333', 31.4, 221, null, null, 'free manual slot (6/8 taken, 6 live)', 22.1],
];

// Two peers that lost their manual slot to a long absence and are being
// re-tested - one recently parked and still being checked often, one that has
// been unreachable long enough for the backoff to have stretched out.
const parked = [
  ['192.0.2.240:8333', 1.2, 188, 6.5, 0.4, 1],
  ['203.0.113.121:8333', 16.3, 264, 52, 5.5, 9],
];
for (const [address, firstPct, eligible, parkedHoursAgo, probeHoursAgo, failures] of parked) {
  inst
    .prepare(
      `INSERT INTO parked_peer (address, label, first_pct, eligible, parked_at, last_probe_at, probe_failures)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(address, firstPct, eligible, now - parkedHoursAgo * HOUR, now - probeHoursAgo * HOUR, failures);
}
for (const [action, address, firstPct, eligible, replacedAddress, replacedFirstPct, note, hoursAgo] of rotationLog) {
  inst
    .prepare(
      `INSERT INTO rotation_log (at, action, address, first_pct, eligible, replaced_address, replaced_first_pct, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(now - hoursAgo * HOUR, action, address, firstPct, eligible, replacedAddress, replacedFirstPct, note);
}

// fresh heartbeats so the dashboard doesn't show the "services not
// reporting in" banner in a screenshot of a demo-only, worker-less instance
const health = require('../src/lib/health');
health.write(db, 'peer-profiler');
health.write(db, 'relay-profiler');
health.write(db, 'stratum-race');

console.log('Demo data seeded at', process.env.DATA_DIR, '- current height', CURRENT_HEIGHT);
db.instance.close();
