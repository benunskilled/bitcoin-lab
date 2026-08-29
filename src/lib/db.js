'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');
const logger = require('./logger').make('db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS peer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,   -- ip:port, as reported by Bitcoin Core
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS peer_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_id INTEGER NOT NULL REFERENCES peer(id),
  core_peer_id INTEGER,           -- Bitcoin Core's own transient peer "id" for this session
  direction TEXT NOT NULL,        -- inbound | outbound
  connection_type TEXT NOT NULL,  -- manual | outbound-full-relay | block-relay-only | inbound | feeler | addr-fetch
  subver TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  min_ping_ms REAL,
  last_ping_ms REAL
);
CREATE INDEX IF NOT EXISTS idx_peer_session_peer ON peer_session(peer_id);
CREATE INDEX IF NOT EXISTS idx_peer_session_open ON peer_session(peer_id, ended_at);

CREATE TABLE IF NOT EXISTS trusted_peer (
  address TEXT PRIMARY KEY,
  label TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_race (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_hash TEXT NOT NULL UNIQUE,
  block_height INTEGER,
  detected_at INTEGER NOT NULL   -- ms since epoch, derived from the hrtime capture
);

CREATE TABLE IF NOT EXISTS relay_observation (
  race_id INTEGER NOT NULL REFERENCES relay_race(id),
  peer_id INTEGER NOT NULL REFERENCES peer(id),
  eligible INTEGER NOT NULL DEFAULT 1,
  first INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (race_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_relay_obs_peer ON relay_observation(peer_id);

CREATE TABLE IF NOT EXISTS stratum_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(host, port)
);

CREATE TABLE IF NOT EXISTS stratum_race (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prevhash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stratum_observation (
  race_id INTEGER NOT NULL REFERENCES stratum_race(id),
  pool_id INTEGER NOT NULL REFERENCES stratum_pool(id),
  latency_ms REAL,               -- NULL = miss (no notify within the race timeout)
  rank INTEGER,
  PRIMARY KEY (race_id, pool_id)
);
CREATE INDEX IF NOT EXISTS idx_stratum_obs_pool ON stratum_observation(pool_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// label, host, port - sourced from public solo-pool directories (Aug 2026).
// Purely a starting point: every row is a normal stratum_pool row the user
// can disable or delete like any other, nothing is special-cased in code.
const DEFAULT_POOLS = [
  ['AtlasPool', 'solo.atlaspool.io', 3333],
  ['EU CKPool', 'eusolo.ckpool.org', 3333],
  ['Braiins Solo', 'solo.stratum.braiins.com', 3333],
  ['SoloHash DE', 'solo-de.solohash.co.uk', 3333],
  ['SoloMining.de', 'pool.solomining.de', 3333],
  ['Satoshi Radio', 'pool.satoshiradio.nl', 3333],
  ['2Miners Solo BTC', 'solo-btc.2miners.com', 2323],
  ['Parasite Pool', 'parasite.wtf', 42069],
];

let db;

function open() {
  if (db) return db;
  const dir = path.dirname(config.sqlitePath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.sqlitePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Four separate processes (dashboard, peer-profiler, relay-profiler,
  // stratum-race) each hold their OWN connection to this same file. WAL
  // mode lets them read concurrently, but a writer can still briefly block
  // another writer - and since v1.9.0, peer-profiler's daily retention
  // prune (a multi-statement transaction) and its weekly VACUUM hold a
  // write lock far longer than the single-row inserts every other process
  // normally does. Without a busy_timeout, any OTHER connection's write
  // that lands during that window fails immediately with SQLITE_BUSY
  // instead of just waiting the (usually well under a second) for it to
  // clear - for stratum-race.js specifically, an unhandled failure there
  // used to crash the whole process, silently dropping every pool
  // connection and losing in-flight race data (see stratum-race.js). This
  // makes every connection wait up to 10s and retry instead.
  db.pragma('busy_timeout = 10000');
  db.exec(SCHEMA);
  seedDefaultPools();
  logger.info('database ready', { path: config.sqlitePath });
  return db;
}

function seedDefaultPools() {
  const already = db.prepare(`SELECT value FROM meta WHERE key = 'pools_seeded'`).get();
  if (already) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 1, ?)`,
  );
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const [label, host, port] of DEFAULT_POOLS) insert.run(label, host, port, now);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('pools_seeded', '1')`).run();
  });
  tx();
  logger.info('seeded default stratum pools', { count: DEFAULT_POOLS.length });
}

function getOrCreatePeer(address) {
  const now = Date.now();
  db.prepare(`INSERT OR IGNORE INTO peer (address, first_seen_at) VALUES (?, ?)`).run(address, now);
  return db.prepare(`SELECT * FROM peer WHERE address = ?`).get(address);
}

// DELETEs (queries.pruneOldData) free up rows but SQLite never shrinks the
// file on disk for them on its own - only VACUUM actually reclaims that
// space. VACUUM briefly needs up to ~2x the file's current size and
// rewrites the whole thing, so it's throttled to at most once a week
// (tracked in `meta`) rather than run after every prune - the DB stays
// small enough at this app's scale that a weekly rewrite is unnoticeable,
// but there's no reason to pay that I/O cost daily for no extra benefit.
const VACUUM_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
function maybeVacuum() {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'last_vacuum_at'`).get();
  const last = row ? Number(row.value) : 0;
  if (Date.now() - last < VACUUM_INTERVAL_MS) return false;
  db.exec('VACUUM');
  db.prepare(`INSERT INTO meta (key, value) VALUES ('last_vacuum_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(Date.now()));
  return true;
}

module.exports = {
  open,
  get instance() { return db; },
  getOrCreatePeer,
  maybeVacuum,
};
