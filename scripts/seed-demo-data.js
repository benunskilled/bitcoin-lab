'use strict';

// Dev tooling, not part of the running app (excluded from the Docker build
// via .dockerignore, not a listed dependency). Fills a fresh SQLite DB with
// plausible-looking synthetic data - only RFC 5737 documentation-range IPs
// (203.0.113.0/24, 198.51.100.0/24, 192.0.2.0/24), nothing real - so the
// dashboard can be screenshotted for the README/store listing without a
// live Bitcoin Core node. Never run against a real DB.
//
// Usage: DATA_DIR=/tmp/bitcoin-lab-demo node scripts/seed-demo-data.js
//   then: DATA_DIR=/tmp/bitcoin-lab-demo node src/dashboard-server.js
//   then: npm install --no-save playwright && node scripts/screenshot.js

process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/bitcoin-lab-demo';
const fs = require('fs');
fs.mkdirSync(`${process.env.DATA_DIR}/sqlite`, { recursive: true });

const db = require('../src/lib/db');
db.open();
const inst = db.instance;

const now = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
  // a couple of older, closed sessions so "Sessions" / "Total Time" look real
  for (let i = 0; i < (opts.pastSessions || 3); i++) {
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

function trust(address, label) {
  inst
    .prepare(`INSERT OR IGNORE INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?)`)
    .run(address, label || null, now - 15 * DAY);
}

// --- Peers -----------------------------------------------------------------
const peers = [
  addPeer('203.0.113.12:8333', '/Satoshi:27.1.0/', 'outbound-full-relay', 'outbound', { ageDays: 40, pingMs: 18 }),
  addPeer('198.51.100.7:8333', '/Satoshi:27.0.0/', 'block-relay-only', 'outbound', { ageDays: 33, pingMs: 24 }),
  addPeer('[2001:db8::a1]:8333', '/Satoshi:26.2.0/', 'outbound-full-relay', 'outbound', { ageDays: 61, pingMs: 41 }),
  addPeer('192.0.2.44:8333', '/Satoshi:27.1.0/', 'inbound', 'inbound', { ageDays: 5, pingMs: 55 }),
  addPeer('192.0.2.88:8333', '/Satoshi:25.2.0/', 'feeler', 'outbound', { ageDays: 1, pingMs: 90, pastSessions: 0 }),
  addPeer('203.0.113.55:8333', '/Satoshi:27.1.0/', 'manual', 'outbound', { ageDays: 90, pingMs: 15 }),
];
trust('203.0.113.55:8333', null);
const manualOffline = addPeer('198.51.100.201:8333', '/Satoshi:26.0.0/', 'manual', 'outbound', {
  ageDays: 70,
  live: false,
  offlineMinutes: 47,
  pastSessions: 4,
});
trust('198.51.100.201:8333', null);

// local sibling app peer (electrs) via the umbrel internal docker network
addPeer('10.21.21.10:53400', '/electrs:0.11.1/', 'inbound', 'inbound', { ageDays: 12, pingMs: 2, pastSessions: 8 });

// --- Relay races (First/Eligible %) ----------------------------------------
const relayPeers = peers.slice(0, 4);
for (let i = 0; i < 30; i++) {
  const raceId = inst
    .prepare(`INSERT INTO relay_race (block_hash, block_height, detected_at) VALUES (?, ?, ?)`)
    .run(`00000000000000000001${String(i).padStart(4, '0')}${'a'.repeat(38)}`, 918000 + i, now - (30 - i) * 10 * 60 * 1000).lastInsertRowid;
  const firstIdx = i % 3 === 2 ? 1 : 0; // peer 0 wins most, peer 1 sometimes
  relayPeers.forEach((p, idx) => {
    inst
      .prepare(`INSERT INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)`)
      .run(raceId, p.id, idx === firstIdx ? 1 : 0);
  });
}

// --- Stratum pools + races ---------------------------------------------------
inst
  .prepare(`INSERT OR IGNORE INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 0, ?)`)
  .run('GoBrrr', 'gobrrr-pool_ckpool_1', 3333, now - 25 * DAY);

const pools = inst.prepare(`SELECT id, label FROM stratum_pool ORDER BY id LIMIT 3`).all();

for (let i = 0; i < 40; i++) {
  const raceId = inst
    .prepare(`INSERT INTO stratum_race (prevhash, created_at) VALUES (?, ?)`)
    .run(`prevhash-${i}`, now - (40 - i) * 9 * 60 * 1000).lastInsertRowid;
  const winner = i % 5 === 0 ? 1 : 0;
  pools.forEach((p, idx) => {
    const miss = idx === 2 && i % 7 === 0;
    inst
      .prepare(`INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, ?, ?)`)
      .run(raceId, p.id, miss ? null : (idx === winner ? 40 + Math.random() * 30 : 120 + Math.random() * 200), miss ? null : idx + 1);
  });
}

// fresh heartbeats so the dashboard doesn't show the "services not
// reporting in" banner in a screenshot of a demo-only, worker-less instance
const health = require('../src/lib/health');
health.write(db, 'peer-profiler');
health.write(db, 'relay-profiler');
health.write(db, 'stratum-race');

console.log('Demo data seeded at', process.env.DATA_DIR);
db.instance.close();
