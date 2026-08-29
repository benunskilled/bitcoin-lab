'use strict';

/**
 * Stratum Race - measures which pool delivers a new job (mining.notify with
 * a new prevhash) fastest. Completely independent of Bitcoin Core/ZMQ:
 * every pool is timed purely from its own TCP `data` events. The first
 * pool to report a given prevhash defines 0ms; everyone else is measured
 * relative to that instant. No pool is treated specially.
 */

const config = require('./lib/config');
const db = require('./lib/db');
const logger = require('./lib/logger').make('stratum-race');
const { StratumPoolConnection } = require('./lib/stratum-client');

const POOL_REFRESH_INTERVAL_MS = 30000;

/** @type {Map<number, {conn: StratumPoolConnection, pool: object}>} */
const active = new Map();

/** Currently open race, if any: { id, prevhash, startHr, timer } */
let currentRace = null;
let reportedPoolIds = new Set();

function loadEnabledPools() {
  return db.instance.prepare(`SELECT * FROM stratum_pool WHERE enabled = 1`).all();
}

function syncConnections() {
  const pools = loadEnabledPools();
  const wanted = new Map(pools.map((p) => [p.id, p]));

  // Stop connections for pools that were disabled/removed.
  for (const [id, entry] of active) {
    if (!wanted.has(id)) {
      entry.conn.stop();
      active.delete(id);
      logger.info('stopped pool (disabled/removed)', { label: entry.pool.label });
    }
  }

  // Start connections for newly enabled pools.
  for (const pool of pools) {
    if (active.has(pool.id)) continue;
    const conn = new StratumPoolConnection({
      host: pool.host,
      port: pool.port,
      label: pool.label,
      idleTimeoutMs: config.stratumIdleTimeoutMs,
      authorizeAddress: config.stratumAuthorizeAddress,
    });
    conn.on('notify', ({ prevhash, receivedAtHr }) => handleNotify(pool, prevhash, receivedAtHr));
    conn.on('socketError', (err) => logger.debug('pool socket error', { label: pool.label, error: err.message }));
    conn.on('authorizeResult', ({ ok, error }) => {
      if (!ok) logger.warn('pool rejected mining.authorize - it will likely never send us a job', { label: pool.label, error });
    });
    // Visible, periodic proof of life per pool - the only way to tell "no
    // data because nothing has happened yet" apart from "no data because
    // something is silently wrong" without being able to test pool
    // connectivity live. Check `docker logs` for this if the race still
    // looks empty after a while.
    conn.on('heartbeat', ({ connectedMs, notifyCount, authorized }) => {
      logger.info('pool connection status', {
        label: pool.label,
        connectedMinutes: Math.round(connectedMs / 60000),
        notifyCount,
        authorized,
      });
    });
    conn.start();
    active.set(pool.id, { conn, pool });
    logger.info('watching pool', { label: pool.label, host: pool.host, port: pool.port });
  }
}

function finalizeCurrentRace() {
  if (!currentRace) return;
  const { id, timer } = currentRace;
  clearTimeout(timer);

  try {
    // Anyone still enabled who never reported for this race gets a miss.
    const insertMiss = db.instance.prepare(
      `INSERT OR IGNORE INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, NULL, NULL)`,
    );
    const tx = db.instance.transaction(() => {
      for (const poolId of active.keys()) {
        if (!reportedPoolIds.has(poolId)) insertMiss.run(id, poolId);
      }
    });
    tx();
  } catch (err) {
    // A DB error here must never crash this process - see db.js
    // busy_timeout for why it should now be rare, but losing the whole
    // event loop over one race's bookkeeping would silently drop every
    // pool connection, not just this race.
    logger.warn('failed to record miss(es) for finalized race', { raceId: id, error: err.message });
  }

  currentRace = null;
  reportedPoolIds = new Set();
}

function handleNotify(pool, prevhash, receivedAtHr) {
  if (!prevhash) return;

  if (!currentRace || currentRace.prevhash !== prevhash) {
    // A genuinely new prevhash starts a new race. Close out the old one
    // first so pools that never caught up get scored as a miss.
    finalizeCurrentRace();

    const createdAt = Date.now();
    const info = db.instance
      .prepare(`INSERT OR IGNORE INTO stratum_race (prevhash, created_at) VALUES (?, ?)`)
      .run(prevhash, createdAt);

    let raceId = info.lastInsertRowid;
    if (info.changes === 0) {
      // Race already exists (e.g. we saw this prevhash before, pool reconnect
      // replay). Reuse it but we've lost the original start instant, so bail
      // out rather than record a misleading latency.
      logger.debug('duplicate prevhash race, ignoring', { prevhash, label: pool.label });
      return;
    }

    currentRace = {
      id: raceId,
      prevhash,
      startHr: receivedAtHr,
      timer: setTimeout(finalizeCurrentRace, config.stratumRaceTimeoutMs),
    };
    reportedPoolIds = new Set();
  }

  if (reportedPoolIds.has(pool.id)) return; // only the first notify per pool counts
  reportedPoolIds.add(pool.id);

  const elapsedMs = Number(receivedAtHr - currentRace.startHr) / 1e6;
  const rank = reportedPoolIds.size;

  try {
    // Upsert rather than a plain INSERT OR IGNORE: if finalizeCurrentRace()
    // already recorded a miss for this (race, pool) - e.g. this notify's
    // write was delayed by DB lock contention past the race timeout - a
    // late-but-real report should still correct it rather than being
    // silently dropped by the earlier miss row. Never overwrites an
    // already-recorded real result (the WHERE guards on latency_ms IS NULL).
    db.instance
      .prepare(
        `INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(race_id, pool_id) DO UPDATE SET latency_ms = excluded.latency_ms, rank = excluded.rank
         WHERE stratum_observation.latency_ms IS NULL`,
      )
      .run(currentRace.id, pool.id, elapsedMs, rank);
    logger.info('pool reported job', { label: pool.label, rank, elapsedMs: Number(elapsedMs.toFixed(1)) });
  } catch (err) {
    // Same reasoning as finalizeCurrentRace(): never let a DB hiccup crash
    // this process and take every pool connection down with it.
    logger.warn('failed to record pool report', { label: pool.label, error: err.message });
  }
}

function main() {
  db.open();
  syncConnections();
  setInterval(syncConnections, POOL_REFRESH_INTERVAL_MS);
  logger.info('started', { timeoutMs: config.stratumRaceTimeoutMs });
}

main();

process.on('SIGTERM', () => {
  for (const { conn } of active.values()) conn.stop();
  process.exit(0);
});
