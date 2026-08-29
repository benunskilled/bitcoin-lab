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
const health = require('./lib/health');
const processGuard = require('./lib/process-guard');
const { isValidHost, isValidPort } = require('./lib/validate');
const logger = require('./lib/logger').make('stratum-race');
const { StratumPoolConnection } = require('./lib/stratum-client');

// Pools only ever change through the dashboard, and a few minutes' delay in
// noticing that is imperceptible - this used to run every 30 seconds, which
// was 2,880 pointless SELECTs a day to catch an event that happens maybe
// twice a month. Enabling or disabling a pool from the UI takes effect on
// the next pass.
const POOL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** @type {Map<number, {conn: StratumPoolConnection, pool: object}>} */
const active = new Map();

/**
 * Open races, keyed by prevhash: { id, startHr, timer, reported:Set<poolId> }.
 *
 * This used to be a single `currentRace` slot, which had a subtle but costly
 * failure mode. A pool that is a block behind still broadcasts jobs for the
 * PREVIOUS prevhash; when one of those arrived while the current race was
 * open, the old code called finalizeCurrentRace() first and only afterwards
 * discovered (via INSERT OR IGNORE reporting zero changes) that the prevhash
 * was stale and it should have done nothing at all. The live race was
 * already gone by then, and every pool that had not yet reported - however
 * healthy - was written down as a miss.
 *
 * The consequence was not random noise: it systematically inflated Win % for
 * whichever pool happened to be quickest and inflated Miss for everyone
 * else, i.e. it biased exactly the two numbers this feature exists to
 * produce. Keying races by prevhash removes the shared slot entirely, so a
 * stale job can no longer disturb a race it does not belong to, and two
 * genuinely overlapping races can both stay open.
 */
const openRaces = new Map();

// A stale notify must be recognised as stale without a database round-trip on
// every single message, and without growing forever. Prevhashes are only ever
// interesting for seconds, so a small ring of recently seen ones is enough.
const RECENT_PREVHASH_LIMIT = 64;
const recentPrevhashes = new Set();

function rememberPrevhash(prevhash) {
  recentPrevhashes.add(prevhash);
  if (recentPrevhashes.size > RECENT_PREVHASH_LIMIT) {
    const oldest = recentPrevhashes.values().next().value;
    recentPrevhashes.delete(oldest);
  }
}

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

    // Second line of defence behind the API's own validation (lib/validate.js).
    // net.connect() throws SYNCHRONOUSLY for a port outside 1-65535, and this
    // function runs on a timer - so before v1.12.0 a single malformed row
    // (a mistyped port, or one written directly into the database) killed
    // this process on every tick, including immediately after each restart.
    // A bad row now disables just itself, loudly, and the race keeps running
    // for every other pool.
    if (!isValidHost(pool.host) || !isValidPort(pool.port)) {
      logger.error('pool has an invalid host/port and was disabled - fix it in the dashboard and re-enable', {
        id: pool.id,
        label: pool.label,
        host: pool.host,
        port: pool.port,
      });
      try {
        db.instance.prepare(`UPDATE stratum_pool SET enabled = 0 WHERE id = ?`).run(pool.id);
      } catch (err) {
        logger.warn('could not disable invalid pool', { id: pool.id, error: err.message });
      }
      continue;
    }

    try {
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
      // Per-pool proof of life. Demoted from info to debug in v1.12.0: at
      // one line per pool every 15 minutes this was ~32 lines an hour of
      // "still fine", which buried the warnings worth reading. The same
      // information is available at a glance in the dashboard, and
      // LOG_LEVEL=debug brings it back when actually diagnosing a pool.
      conn.on('heartbeat', ({ connectedMs, notifyCount, authorized }) => {
        logger.debug('pool connection status', {
          label: pool.label,
          connectedMinutes: Math.round(connectedMs / 60000),
          notifyCount,
          authorized,
        });
      });
      conn.start();
      active.set(pool.id, { conn, pool });
      logger.info('watching pool', { label: pool.label, host: pool.host, port: pool.port });
    } catch (err) {
      logger.error('could not start pool connection - skipping it this round', {
        label: pool.label,
        host: pool.host,
        port: pool.port,
        error: err.message,
      });
    }
  }
}

function finalizeRace(prevhash) {
  const race = openRaces.get(prevhash);
  if (!race) return;
  openRaces.delete(prevhash);
  clearTimeout(race.timer);

  try {
    // Anyone still enabled who never reported for this race gets a miss.
    const insertMiss = db.instance.prepare(
      `INSERT OR IGNORE INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, NULL, NULL)`,
    );
    const tx = db.instance.transaction(() => {
      for (const poolId of active.keys()) {
        if (!race.reported.has(poolId)) insertMiss.run(race.id, poolId);
      }
    });
    tx();
  } catch (err) {
    // A DB error here must never crash this process - see db.js busy_timeout
    // for why it should now be rare, but losing the whole event loop over one
    // race's bookkeeping would silently drop every pool connection, not just
    // this race.
    logger.warn('failed to record miss(es) for finalized race', { raceId: race.id, error: err.message });
  }
}

function finalizeAllRaces() {
  for (const prevhash of [...openRaces.keys()]) finalizeRace(prevhash);
}

function handleNotify(pool, prevhash, receivedAtHr) {
  if (!prevhash) return;

  let race = openRaces.get(prevhash);

  if (!race) {
    // Not an open race. Either this is a genuinely new block, or it is a
    // lagging pool re-sending a job for a prevhash that has already been
    // raced and closed. Crucially, this decision is made WITHOUT touching any
    // other open race - a stale job is simply ignored.
    if (recentPrevhashes.has(prevhash)) {
      logger.debug('stale prevhash from a lagging pool, ignoring', { prevhash, label: pool.label });
      return;
    }

    let info;
    try {
      info = db.instance
        .prepare(`INSERT OR IGNORE INTO stratum_race (prevhash, created_at) VALUES (?, ?)`)
        .run(prevhash, Date.now());
    } catch (err) {
      logger.warn('failed to open race', { prevhash, label: pool.label, error: err.message });
      return;
    }

    if (info.changes === 0) {
      // Already in the database from an earlier run or an earlier race - we
      // have lost the original start instant, so any latency we computed now
      // would be meaningless. Remember it so the next lagging notify is
      // answered from memory.
      rememberPrevhash(prevhash);
      logger.debug('duplicate prevhash race, ignoring', { prevhash, label: pool.label });
      return;
    }

    rememberPrevhash(prevhash);
    race = {
      id: info.lastInsertRowid,
      prevhash,
      startHr: receivedAtHr,
      reported: new Set(),
      timer: setTimeout(() => finalizeRace(prevhash), config.stratumRaceTimeoutMs),
    };
    openRaces.set(prevhash, race);
  }

  if (race.reported.has(pool.id)) return; // only the first notify per pool counts
  race.reported.add(pool.id);

  const elapsedMs = Number(receivedAtHr - race.startHr) / 1e6;
  const rank = race.reported.size;

  try {
    // Upsert rather than a plain INSERT OR IGNORE: if finalizeRace() already
    // recorded a miss for this (race, pool) - e.g. this notify's write was
    // delayed by DB lock contention past the race timeout - a late-but-real
    // report should still correct it rather than being silently dropped by
    // the earlier miss row. Never overwrites an already-recorded real result
    // (the WHERE guards on latency_ms IS NULL).
    db.instance
      .prepare(
        `INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(race_id, pool_id) DO UPDATE SET latency_ms = excluded.latency_ms, rank = excluded.rank
         WHERE stratum_observation.latency_ms IS NULL`,
      )
      .run(race.id, pool.id, elapsedMs, rank);
    logger.info('pool reported job', { label: pool.label, rank, elapsedMs: Number(elapsedMs.toFixed(1)) });
  } catch (err) {
    // Same reasoning as finalizeRace(): never let a DB hiccup crash this
    // process and take every pool connection down with it.
    logger.warn('failed to record pool report', { label: pool.label, error: err.message });
  }
}

function stopAllConnections() {
  for (const { conn } of active.values()) conn.stop();
}

function main() {
  processGuard.install(logger, {
    onShutdown: () => {
      finalizeAllRaces();
      stopAllConnections();
    },
  });
  db.open();
  health.start(db, 'stratum-race', logger, () => ({ pools: active.size, openRaces: openRaces.size }));
  syncConnections();
  setInterval(syncConnections, POOL_REFRESH_INTERVAL_MS);
  logger.info('started', { timeoutMs: config.stratumRaceTimeoutMs, pools: active.size });
}

// Only run as a service when executed directly, so the race logic above can
// be exercised by the test suite instead of being unreachable behind a
// module-load side effect. The stale-prevhash regression in particular was
// only ever reproducible end to end; now it has a test.
if (require.main === module) main();

module.exports = { handleNotify, finalizeRace, finalizeAllRaces, syncConnections, active, openRaces, main };
