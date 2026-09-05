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
  -- Core's own name for the network this connection runs over: ipv4 | ipv6 |
  -- onion | i2p | cjdns | not_publicly_routable. Taken from getpeerinfo rather
  -- than guessed from the address, because the address does not carry it: an
  -- inbound Tor peer arrives from the local Tor proxy and shows up under that
  -- proxy's plain IPv4 address. Guessing from the string classified those as
  -- ordinary local peers. NULL on rows written before this column existed.
  network TEXT,
  subver TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  min_ping_ms REAL,
  last_ping_ms REAL
);
-- No standalone index on peer_session(peer_id): idx_peer_session_open below
-- starts with the same column, so SQLite already uses it for a plain
-- peer_id lookup. A second copy only cost write amplification on one of the
-- two busiest tables in the schema.
CREATE INDEX IF NOT EXISTS idx_peer_session_open ON peer_session(peer_id, ended_at);

CREATE INDEX IF NOT EXISTS idx_peer_session_peer_started ON peer_session(peer_id, started_at DESC);
-- Partial index over just the currently-open sessions. liveSummary() runs
-- a WHERE ended_at IS NULL filter on every /api/status poll and on every
-- widget refresh; without this it scanned the whole (permanently growing)
-- session table just to count a few dozen live rows.
CREATE INDEX IF NOT EXISTS idx_peer_session_live
  ON peer_session(peer_id, direction, connection_type) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS trusted_peer (
  address TEXT PRIMARY KEY,
  label TEXT,
  created_at INTEGER NOT NULL
);

-- Manual peers the rotation loop retired because they stayed offline past
-- their grace period, kept so they can earn their slot back.
--
-- Without this table, "offline too long" would be a one-way door: the peer
-- that delivered 40% of your blocks first for two months drops off the
-- network for an evening, loses its slot, and is then indistinguishable from
-- the thousands of addresses Core has ever seen. Parking it means the loop
-- can keep knocking on the door (a TCP handshake to the port that answered
-- last time) and hand the slot straight back when it opens - which is the
-- only reason retiring an offline peer relatively quickly is a safe thing to
-- do at all.
--
-- The address here is a real, dialable listening address (it was a manual peer,
-- so it had already survived a handshake), not an observed inbound address.
CREATE TABLE IF NOT EXISTS parked_peer (
  address TEXT PRIMARY KEY,
  label TEXT,
  first_pct REAL,                 -- lifetime record at the moment it was parked
  eligible INTEGER,
  parked_at INTEGER NOT NULL,
  last_probe_at INTEGER,          -- NULL until the first re-probe
  probe_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_parked_peer_probe ON parked_peer(last_probe_at ASC);

CREATE TABLE IF NOT EXISTS relay_race (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_hash TEXT NOT NULL UNIQUE,
  block_height INTEGER,
  detected_at INTEGER NOT NULL   -- ms since epoch, derived from the hrtime capture
);

CREATE TABLE IF NOT EXISTS relay_observation (
  race_id INTEGER NOT NULL REFERENCES relay_race(id),
  peer_id INTEGER NOT NULL REFERENCES peer(id),
  -- Always 1, and read by nothing: the presence of the row IS the
  -- eligibility, which is why peer_relay_stats counts rows rather than
  -- summing this. Kept because dropping a column would rewrite a table that
  -- holds millions of rows on a long-lived node, for no gain.
  eligible INTEGER NOT NULL DEFAULT 1,
  first INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (race_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_relay_obs_peer ON relay_observation(peer_id);

-- Running per-peer totals over relay_observation, maintained incrementally by
-- the relay profiler as each race is recorded.
--
-- relay_observation itself is never time-pruned (it IS the long-term ranking
-- data - see config.js), which is right, but it also means it grows without
-- bound: roughly one row per connected peer per block, so a node holding ~50
-- connections accumulates millions of rows a year. peerRanking() used to
-- GROUP BY across that entire table twice on every single poll, so the cost
-- of the main dashboard query grew linearly with the app's own lifetime.
-- Keeping the raw rows and reading one summary row per peer gives identical
-- numbers at constant cost. Backfilled once at startup (see runMigrations).
CREATE TABLE IF NOT EXISTS peer_relay_stats (
  peer_id INTEGER PRIMARY KEY REFERENCES peer(id),
  eligible INTEGER NOT NULL DEFAULT 0,
  first INTEGER NOT NULL DEFAULT 0
);

-- The rollup is maintained by the database itself rather than by the writer.
-- A summary table that some code path forgets to update is worse than no
-- summary at all - it is wrong data that looks authoritative - and
-- relay_observation is written from the relay profiler, from migrations and
-- from tests. With these triggers the invariant
--   peer_relay_stats == SELECT peer_id, COUNT(*), SUM(first) FROM relay_observation
-- holds by construction, in the same transaction as the row itself.
CREATE TRIGGER IF NOT EXISTS trg_relay_observation_insert
AFTER INSERT ON relay_observation
BEGIN
  INSERT INTO peer_relay_stats (peer_id, eligible, first)
  VALUES (NEW.peer_id, 1, NEW.first)
  ON CONFLICT(peer_id) DO UPDATE SET
    eligible = peer_relay_stats.eligible + 1,
    first = peer_relay_stats.first + NEW.first;
END;

CREATE TRIGGER IF NOT EXISTS trg_relay_observation_delete
AFTER DELETE ON relay_observation
BEGIN
  UPDATE peer_relay_stats
     SET eligible = eligible - 1, first = first - OLD.first
   WHERE peer_id = OLD.peer_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_relay_observation_update
AFTER UPDATE OF first ON relay_observation
BEGIN
  UPDATE peer_relay_stats
     SET first = first - OLD.first + NEW.first
   WHERE peer_id = NEW.peer_id;
END;

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
-- (pool_id, latency_ms) also serves every plain pool_id lookup, so there is
-- no separate index on pool_id alone. It puts each pool's samples in latency
-- order, which is what turns the median/P90 lookups into an ordered index
-- walk instead of a sort.
CREATE INDEX IF NOT EXISTS idx_stratum_obs_pool_latency ON stratum_observation(pool_id, latency_ms);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Audit trail for the automatic peer-rotation loop (src/lib/peer-rotation.js).
-- One row per action it actually takes (kick or promote/swap), so the
-- dashboard can show what the toggle has been doing without the user having
-- to dig through container logs. Deliberately NOT time-pruned by
-- queries.pruneOldData - this is a small, slow-growing table (at most a
-- couple of rows per 10-minute tick) and its history is the whole point.
CREATE TABLE IF NOT EXISTS rotation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,             -- kick | promote | swap | park | revive
  address TEXT NOT NULL,
  first_pct REAL,
  eligible INTEGER,
  replaced_address TEXT,            -- set only for 'swap'
  replaced_first_pct REAL,          -- set only for 'swap'
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_rotation_log_at ON rotation_log(at DESC);

-- Every IP the rotation has ever made manual, one row each, forever.
--
-- rotation_log cannot answer "how many peers were ever promoted": it is
-- trimmed to the last thirty actions on every write, so the count silently
-- shrinks as the loop keeps working. This table is the durable half of that
-- question and nothing else - no percentages, no timestamps beyond the first,
-- because the peer's own record already lives in peer_relay_stats.
--
-- Keyed by IP rather than by address on purpose. A promoted inbound peer joins
-- under its listening port, so the same host appears once as 203.0.113.5:51234
-- and again as 203.0.113.5:8333; counting addresses would count it twice. The
-- primary key makes the de-duplication a property of the schema rather than
-- something every reader has to remember.
CREATE TABLE IF NOT EXISTS promoted_peer (
  ip TEXT PRIMARY KEY,
  first_promoted_at INTEGER NOT NULL
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

// A VACUUM is only worth its exclusive lock if this share of the file is
// actually free space waiting to be reclaimed.
const VACUUM_MIN_FREE_FRACTION = 0.1;

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
  runMigrations();
  seedDefaultPools();
  logger.info('database ready', { path: config.sqlitePath });
  return db;
}

/**
 * One-time data migrations, each guarded by its own flag row in `meta` and
 * run inside a transaction, so all four processes can call this concurrently
 * at startup and exactly one of them does the work.
 *
 * The busy timeout is raised for the duration: a backfill over a database
 * that has been collecting for months is a single long write, and the other
 * three processes starting at the same moment must wait it out rather than
 * failing with SQLITE_BUSY at ten seconds.
 */
function runMigrations() {
  const previousTimeout = 10000;
  db.pragma('busy_timeout = 120000');
  try {
    migrate('rollup_backfill_v1', 'backfilled per-peer relay totals', () => {
      db.prepare(
        `INSERT INTO peer_relay_stats (peer_id, eligible, first)
         SELECT peer_id, COUNT(*), COALESCE(SUM(first), 0)
         FROM relay_observation
         GROUP BY peer_id
         ON CONFLICT(peer_id) DO UPDATE SET eligible = excluded.eligible, first = excluded.first`,
      ).run();
    });

    // v1.11.1 and earlier scored a pool as a "miss" whenever any pool
    // reported a stale prevhash while a race was still open (a lagging pool
    // re-sending the previous block's job would close the live race early and
    // mark everyone who had not yet reported). That inflated Win % for
    // whichever pool was fastest and inflated Miss for every other pool, so
    // the accumulated stratum statistics are not merely noisy but
    // systematically biased and cannot be corrected after the fact. Clearing
    // them once means Win %/Miss start from a correct baseline; the peer
    // ranking data is untouched and unaffected.
    migrate('stratum_history_reset_v1_12_0', 'cleared biased pre-v1.12.0 stratum race history', () => {
      db.prepare(`DELETE FROM stratum_observation`).run();
      db.prepare(`DELETE FROM stratum_race`).run();
    });

    // Both were exact prefixes of another index on the same table, so they
    // never served a query the wider index could not, and both sat on the two
    // most write-heavy tables in the schema. CREATE INDEX IF NOT EXISTS only
    // ever adds, so an install that already has them needs this to be rid of
    // them.
    migrate('drop_redundant_indexes_v1_13_0', 'dropped two redundant indexes', () => {
      db.prepare(`DROP INDEX IF EXISTS idx_peer_session_peer`).run();
      db.prepare(`DROP INDEX IF EXISTS idx_stratum_obs_pool`).run();
    });

    // peerRanking() is driven FROM peer, so a manual peer with no row there is
    // invisible to it - and therefore to every rotation pass. It can never be
    // retired however long it has been gone, is never a candidate for the
    // weakest slot, and is never displayed, while still counting against
    // MAX_MANUAL_PEERS. One addnode entry Core never manages to connect (a
    // non-Bitcoin service answering on 8333, a peer that rejects us, Core's
    // own slots full) silently costs a slot permanently.
    //
    // Both paths that create trusted peers now create the peer row alongside;
    // this gives the same treatment to the ones already sitting in installed
    // databases, so they become visible - and therefore retirable - too.
    migrate('trusted_peer_rows_v1_15_5', 'gave every manual peer a peer row so the rotation can see it', () => {
      db.prepare(
        `INSERT OR IGNORE INTO peer (address, first_seen_at)
         SELECT tp.address, tp.created_at FROM trusted_peer tp
         WHERE NOT EXISTS (SELECT 1 FROM peer p WHERE p.address = tp.address)`,
      ).run();
    });

    // promoted_peer starts empty, so an installed node would report "0 kept"
    // next to eight manual peers it has been keeping for weeks - a number that
    // is not merely incomplete but visibly wrong to the person reading it.
    //
    // Backfilled from both places a kept peer can be: the manual set, and the
    // parked list, which is where a peer that lost its slot while offline
    // waits. Both were kept at some point, which is what the count says.
    //
    // The address is stripped to its IP by the same rule the query uses -
    // brackets kept for IPv6, everything from the first colon dropped
    // otherwise - so a host that appears in both lists, or twice under
    // different ports, still counts once. INSERT OR IGNORE plus the primary
    // key does the rest. A fresh install finds nothing to copy and the flag
    // is set anyway, so this never runs twice.
    migrate('promoted_peer_backfill_v1_15_10', 'counted the peers already kept before the record existed', () => {
      db.prepare(
        `INSERT OR IGNORE INTO promoted_peer (ip, first_promoted_at)
         SELECT CASE WHEN instr(address, ']') > 0
                     THEN substr(address, 1, instr(address, ']'))
                     ELSE substr(address, 1, instr(address, ':') - 1) END,
                created_at
           FROM trusted_peer
         UNION ALL
         SELECT CASE WHEN instr(address, ']') > 0
                     THEN substr(address, 1, instr(address, ']'))
                     ELSE substr(address, 1, instr(address, ':') - 1) END,
                parked_at
           FROM parked_peer`,
      ).run();
    });

    // The first column this schema has ever added to an existing table. The
    // CREATE TABLE above carries it for fresh installs, so this has to check
    // before it adds - an unconditional ALTER would throw "duplicate column"
    // on every install created after this version.
    //
    // Existing rows keep NULL, and the ranking falls back to reading the
    // network out of the address for those, exactly as it did before. So old
    // sessions are no worse off than they were, and every session written from
    // now on is classified by what Core says rather than by what the address
    // looks like.
    migrate('peer_session_network_v1_15_13', 'added the network column to peer_session', () => {
      const hasColumn = db
        .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('peer_session') WHERE name = 'network'`)
        .get().n > 0;
      if (!hasColumn) db.prepare(`ALTER TABLE peer_session ADD COLUMN network TEXT`).run();
    });
  } finally {
    db.pragma(`busy_timeout = ${previousTimeout}`);
  }
}

function migrate(flag, description, work) {
  const done = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`migration:${flag}`);
  if (done) return;
  const tx = db.transaction(() => {
    // Re-check inside the transaction: another process may have finished this
    // same migration between our read above and acquiring the write lock.
    const raced = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`migration:${flag}`);
    if (raced) return false;
    work();
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run(`migration:${flag}`, String(Date.now()));
    return true;
  });
  if (tx()) logger.info(`migration: ${description}`, { flag });
}

function seedDefaultPools() {
  const already = db.prepare(`SELECT value FROM meta WHERE key = 'pools_seeded'`).get();
  if (already) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 1, ?)`,
  );
  const now = Date.now();
  const tx = db.transaction(() => {
    // Re-check inside the transaction, exactly like migrate() above and for
    // the same reason: all four processes call open() at once, and on a fresh
    // install all four read "not seeded yet". meta.key is a PRIMARY KEY, so
    // without this the losers of that race threw SQLITE_CONSTRAINT_PRIMARYKEY
    // straight out of open() and died on first boot - the relay profiler
    // included, whose downtime is the one thing that cannot be reconstructed
    // afterwards.
    const raced = db.prepare(`SELECT value FROM meta WHERE key = 'pools_seeded'`).get();
    if (raced) return false;
    for (const [label, host, port] of DEFAULT_POOLS) insert.run(label, host, port, now);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('pools_seeded', '1')`).run();
    return true;
  });
  if (tx()) logger.info('seeded default stratum pools', { count: DEFAULT_POOLS.length });
}

// Held for the life of the process rather than compiled per call. This is on
// two hot paths - once per connected peer per 15-second poll, and once per
// connected peer inside the relay profiler's per-block write transaction - so
// at ~200 peers it was compiling 400 statements every poll. Measured: the peer
// poll went 4.58ms -> 1.45ms and the block write transaction 8.25ms -> 4.00ms,
// which is time this process holds the write lock against the other three.
//
// Lazily initialised because `db` does not exist until open() runs. Reading
// first is deliberate: after the first sighting of a peer the row is always
// already there, so the common path is a single indexed SELECT and no write.
let getPeerStmt = null;
let insertPeerStmt = null;
function getOrCreatePeer(address) {
  if (!getPeerStmt) {
    getPeerStmt = db.prepare(`SELECT * FROM peer WHERE address = ?`);
    insertPeerStmt = db.prepare(`INSERT OR IGNORE INTO peer (address, first_seen_at) VALUES (?, ?)`);
  }
  const existing = getPeerStmt.get(address);
  if (existing) return existing;
  insertPeerStmt.run(address, Date.now());
  return getPeerStmt.get(address);
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

  // A calendar is the wrong trigger for this. VACUUM rewrites the entire file
  // under an exclusive lock, and this file is append-only in every way that
  // matters: relay_observation and relay_race are deliberately never pruned
  // (they ARE the ranking), so the only deletions are transient peer sessions
  // and expired stratum history - a rounding error against the relay data.
  // Measured on a year-old database: freelist_count was 0, and the VACUUM took
  // eleven seconds on NVMe to reclaim nothing. On the SD or USB storage an
  // Umbrel usually runs on, considerably longer.
  //
  // That matters beyond wasted I/O. The exclusive lock outlasts the 10s
  // busy_timeout that db.js sets *because of* this VACUUM, so a block landing
  // inside the window loses its race - the one kind of data this app cannot
  // reconstruct. Ask the file whether there is anything to reclaim instead,
  // which makes this a no-op in the normal case and lets it run after an
  // unusually large prune, the only case it was ever for.
  const freePages = db.pragma('freelist_count', { simple: true });
  const totalPages = db.pragma('page_count', { simple: true });
  if (!totalPages || freePages / totalPages < VACUUM_MIN_FREE_FRACTION) {
    // Still stamp it, so this check runs weekly rather than on every prune.
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_vacuum_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(Date.now()));
    logger.debug('skipped VACUUM - nothing worth reclaiming', { freePages, totalPages });
    return false;
  }
  logger.info('running VACUUM', { freePages, totalPages });
  db.exec('VACUUM');
  db.prepare(`INSERT INTO meta (key, value) VALUES ('last_vacuum_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(Date.now()));
  return true;
}

// Recomputes the rollup from the raw observations. Not used on any hot path -
// it exists so the invariant is testable, and as a repair hatch.
function rebuildRelayStats() {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM peer_relay_stats`).run();
    db.prepare(
      `INSERT INTO peer_relay_stats (peer_id, eligible, first)
       SELECT peer_id, COUNT(*), COALESCE(SUM(first), 0) FROM relay_observation GROUP BY peer_id`,
    ).run();
  });
  tx();
}

/**
 * Throw away all peer measurement data and start counting again, keeping the
 * manual peers themselves.
 *
 * The point of the feature: after changing something that invalidates the
 * history - switching Core to clearnet-only, moving the node, fixing a bug in
 * how blocks were timed - the lifetime percentages describe a world that no
 * longer exists, and there is no honest way to read them. The eight peers
 * found the hard way should not have to be found again for that.
 *
 * `trusted_peer` is untouched, so the manual set survives. Their peer rows are
 * recreated empty, which is what makes the reset safe rather than disruptive:
 * a manual peer at 0 of 0 blocks sits inside the new-peer grace and inside
 * MIN_ELIGIBLE_FOR_JUDGEMENT, so the rotation will not touch anyone for the
 * first day while the new record builds.
 *
 * relay_observation is emptied with the delete trigger dropped for the
 * duration. It maintains peer_relay_stats one row at a time, which is right
 * for a handful of rows and wrong for a hundred thousand - and pointless here,
 * since the rollup is being cleared in the same breath.
 */
function resetPeerData() {
  const before = storageBreakdown().peerData;
  const tx = db.transaction(() => {
    db.prepare(`DROP TRIGGER IF EXISTS trg_relay_observation_delete`).run();
    try {
      db.prepare(`DELETE FROM relay_observation`).run();
      db.prepare(`DELETE FROM peer_relay_stats`).run();
      db.prepare(`DELETE FROM relay_race`).run();
      db.prepare(`DELETE FROM peer_session`).run();
      db.prepare(`DELETE FROM parked_peer`).run();
      db.prepare(`DELETE FROM rotation_log`).run();
      // Goes with the rest, not on its own. Everything the funnel shows -
      // seen, judged, delivered - is derived from the tables above and returns
      // to zero here; a "kept" count that survived would leave the header
      // reading "0 seen, 0 judged, 0 delivered, 8 kept", which is not a
      // statistic but a contradiction.
      db.prepare(`DELETE FROM promoted_peer`).run();
      db.prepare(`DELETE FROM peer`).run();
    } finally {
      // Recreated inside the same transaction, so a failure anywhere above
      // rolls the whole thing back and cannot leave the rollup unmaintained.
      db.prepare(
        `CREATE TRIGGER trg_relay_observation_delete
         AFTER DELETE ON relay_observation
         BEGIN
           UPDATE peer_relay_stats
              SET eligible = eligible - 1, first = first - OLD.first
            WHERE peer_id = OLD.peer_id;
         END`,
      ).run();
    }
    // Give every surviving manual peer its (empty) peer row back, so it shows
    // up in the ranking immediately instead of only once Core reconnects it.
    const addresses = db.prepare(`SELECT address FROM trusted_peer`).all();
    const insert = db.prepare(`INSERT OR IGNORE INTO peer (address, first_seen_at) VALUES (?, ?)`);
    for (const row of addresses) insert.run(row.address, Date.now());
    return addresses.length;
  });
  const keptManualPeers = tx();
  logger.warn('peer measurement data reset', { keptManualPeers, freedBytes: before.bytes, deletedRows: before.rows });
  return { keptManualPeers, freedBytes: before.bytes, deletedRows: before.rows };
}

/**
 * Throw away the stratum pool history. The configured pools themselves stay -
 * only their measured races and latencies go.
 */
function resetPoolHistory() {
  const before = storageBreakdown().poolHistory;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM stratum_observation`).run();
    db.prepare(`DELETE FROM stratum_race`).run();
  });
  tx();
  logger.warn('stratum pool history reset', { freedBytes: before.bytes, deletedRows: before.rows });
  return { freedBytes: before.bytes, deletedRows: before.rows };
}

/**
 * How much disk this app's data actually occupies, write-ahead log included.
 *
 * Worth surfacing rather than leaving to be discovered: relay_observation is
 * deliberately never pruned - it is the ranking - so the file only ever grows,
 * at roughly four megabytes a day on a node with a couple of hundred peers -
 * measured, 23 MB over 5.7 days and 864 blocks at about 200 peers, so a gigabyte
 * and a half a year. That is a fine price for the measurement, but nobody should
 * have to find it out by running out of disk.
 *
 * The WAL is counted because it is real disk usage and can be a large fraction
 * of the total between checkpoints. A missing file is simply zero - the sizes
 * are for display, and a failed stat must never take the status endpoint down.
 */
function sizeBytes() {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(config.sqlitePath + suffix).size;
    } catch { /* not there (yet) - contributes nothing */ }
  }
  return total;
}

// The two groups the user can clear independently, and what each is made of.
// Everything not listed here is configuration or the manual peers themselves,
// and is never touched by a reset.
const PEER_DATA_TABLES = [
  'relay_race', 'relay_observation', 'peer_relay_stats',
  'peer', 'peer_session', 'parked_peer', 'rotation_log', 'promoted_peer',
];
const POOL_HISTORY_TABLES = ['stratum_race', 'stratum_observation'];

/**
 * Bytes on disk per group, plus row counts, so the reset dialog can say what
 * it is about to delete instead of asking for blind confirmation.
 *
 * Uses SQLite's dbstat virtual table, which is exact - it reports the pages
 * actually occupied, indexes included - and expensive: it walks every page in
 * the file. That is why this is its own endpoint rather than part of the
 * status poll. Called when someone opens the reset panel, not every twenty
 * seconds.
 *
 * Indexes are charged to the table they belong to, which is the whole point:
 * relay_observation's index is a large part of what deleting it would free.
 */
function storageBreakdown() {
  const owner = new Map();
  for (const row of db.prepare(`SELECT name, tbl_name FROM sqlite_schema WHERE type IN ('table','index')`).all()) {
    owner.set(row.name, row.tbl_name);
  }

  const bytesByTable = new Map();
  for (const row of db.prepare(`SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`).all()) {
    const table = owner.get(row.name) || row.name;
    bytesByTable.set(table, (bytesByTable.get(table) || 0) + row.bytes);
  }

  const group = (tables) => {
    let bytes = 0;
    let rows = 0;
    for (const t of tables) {
      bytes += bytesByTable.get(t) || 0;
      try {
        rows += db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      } catch { /* table not present in an older schema - contributes nothing */ }
    }
    return { bytes, rows };
  };

  return {
    peerData: group(PEER_DATA_TABLES),
    poolHistory: group(POOL_HISTORY_TABLES),
    totalBytes: sizeBytes(),
  };
}

module.exports = {
  open,
  get instance() { return db; },
  getOrCreatePeer,
  maybeVacuum,
  sizeBytes,
  storageBreakdown,
  resetPeerData,
  resetPoolHistory,
  PEER_DATA_TABLES,
  POOL_HISTORY_TABLES,
  rebuildRelayStats,
  // Exported so the suite can run them a second time and assert they are
  // genuinely no-ops. Asserting a list of flag names instead proved nothing:
  // the guard could be removed and the test stayed green, over a migration
  // that deletes the user's whole stratum history.
  runMigrations,
  seedDefaultPools,
};
