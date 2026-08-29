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

function addPeer(address, subver, connType, direction, opts = {}) {
  const firstSeen = now - (opts.ageDays || 20) * DAY;
  const peer = db.getOrCreatePeer(address, firstSeen);
  const live = opts.live !== false;
  const startedAt = now - (opts.sessionMinutes || 45) * 60 * 1000;
  inst
    .prepare(
      `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, ended_at, min_ping_ms, last_ping_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(peer.id, opts.corePeerId || peer.id, direction, connType, subver, startedAt, live ? null : now - (opts.offlineMinutes || 12) * 60 * 1000, opts.pingMs || 30, opts.pingMs || 30);
  // a few older, closed sessions so "Sessions" / "Total Time" look established
  for (let i = 0; i < (opts.pastSessions ?? 4); i++) {
    const s = now - (opts.ageDays || 20) * DAY + i * 2 * DAY;
    inst
      .prepare(
        `INSERT INTO peer_session (peer_id, core_peer_id, direction, connection_type, subver, started_at, ended_at, min_ping_ms, last_ping_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(peer.id, peer.id, direction, connType, subver, s, s + 6 * HOUR, opts.pingMs || 30, opts.pingMs || 30);
  }
  return peer;
}

function trust(address) {
  inst
    .prepare(`INSERT OR IGNORE INTO trusted_peer (address, label, created_at) VALUES (?, NULL, ?)`)
    .run(address, now - 15 * DAY);
}

// --- Peers -------------------------------------------------------------------
// A mix of outbound/inbound/manual/feeler across a range of clients and
// ages, so Live Peer Ranking, Outbound Peers and Manual Peers all render
// with a dozen-plus rows instead of a handful.
const peers = [
  addPeer('203.0.113.12:8333', '/Satoshi:27.1.0/', 'outbound-full-relay', 'outbound', { ageDays: 61, pingMs: 18 }),
  addPeer('198.51.100.7:8333', '/Satoshi:27.0.0/', 'outbound-full-relay', 'outbound', { ageDays: 54, pingMs: 24 }),
  addPeer('[2001:db8::a1]:8333', '/Satoshi:26.2.0/', 'block-relay-only', 'outbound', { ageDays: 61, pingMs: 41 }),
  addPeer('198.51.100.44:8333', '/Satoshi:27.1.0/', 'outbound-full-relay', 'outbound', { ageDays: 48, pingMs: 33 }),
  addPeer('203.0.113.90:8333', '/Satoshi:26.1.0/', 'block-relay-only', 'outbound', { ageDays: 40, pingMs: 29 }),
  addPeer('192.0.2.44:8333', '/Satoshi:27.1.0/', 'inbound', 'inbound', { ageDays: 22, pingMs: 55 }),
  addPeer('192.0.2.101:8333', '/Satoshi:25.2.0/', 'inbound', 'inbound', { ageDays: 9, pingMs: 61 }),
  addPeer('192.0.2.156:8333', '/Satoshi:27.1.0/', 'inbound', 'inbound', { ageDays: 3, pingMs: 48 }),
  addPeer('192.0.2.88:8333', '/Satoshi:25.2.0/', 'feeler', 'outbound', { ageDays: 1, pingMs: 90, pastSessions: 0 }),
];

const manualLive = [
  addPeer('203.0.113.55:8333', '/Satoshi:27.1.0/', 'manual', 'outbound', { ageDays: 90, pingMs: 15 }),
  addPeer('198.51.100.20:8333', '/Satoshi:27.1.0/', 'manual', 'outbound', { ageDays: 75, pingMs: 19 }),
  addPeer('203.0.113.201:8333', '/Satoshi:26.2.0/', 'manual', 'outbound', { ageDays: 66, pingMs: 21 }),
];
manualLive.forEach((p) => trust(p.address));

const manualOffline = addPeer('198.51.100.201:8333', '/Satoshi:26.0.0/', 'manual', 'outbound', {
  ageDays: 70,
  live: false,
  offlineMinutes: 47,
  pastSessions: 5,
});
trust(manualOffline.address);

// local sibling app peer (electrs) via the umbrel internal docker network
addPeer('10.21.21.10:53400', '/electrs:0.11.1/', 'inbound', 'inbound', { ageDays: 12, pingMs: 2, pastSessions: 9 });

// --- Relay races (First/Eligible %) -------------------------------------------
// Every relay-eligible peer wins a share of races - weighted, not winner-
// take-all - so First Seen % varies row to row instead of most reading 0%.
const relayPeers = [...peers.slice(0, 5), ...manualLive.slice(0, 1)];
const relayWeights = [5, 3, 2, 2, 1, 1]; // roughly matches relayPeers order
const RACE_COUNT = 30;
for (let i = 0; i < RACE_COUNT; i++) {
  const height = CURRENT_HEIGHT - (RACE_COUNT - 1 - i);
  const raceId = inst
    .prepare(`INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, ?, ?)`)
    .run(`00000000000000000001${height.toString(16).padStart(6, '0')}${'a'.repeat(36)}`, height, now - (RACE_COUNT - i) * 10 * 60 * 1000)
    .lastInsertRowid;
  const totalWeight = relayWeights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * totalWeight;
  let firstIdx = 0;
  for (let w = 0; w < relayWeights.length; w++) {
    if (roll < relayWeights[w]) { firstIdx = w; break; }
    roll -= relayWeights[w];
  }
  relayPeers.forEach((p, idx) => {
    inst
      .prepare(`INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)`)
      .run(raceId, p.id, idx === firstIdx ? 1 : 0);
  });
}

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

// fresh heartbeats so the dashboard doesn't show the "services not
// reporting in" banner in a screenshot of a demo-only, worker-less instance
const health = require('../src/lib/health');
health.write(db, 'peer-profiler');
health.write(db, 'relay-profiler');
health.write(db, 'stratum-race');

console.log('Demo data seeded at', process.env.DATA_DIR, '- current height', CURRENT_HEIGHT);
db.instance.close();
