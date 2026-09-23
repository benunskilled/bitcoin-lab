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
const toggle = require('./lib/stratum-race-toggle');

// Pools only ever change through the dashboard, and a few minutes' delay in
// noticing that is imperceptible - this used to run every 30 seconds, which
// was 2,880 pointless SELECTs a day to catch an event that happens maybe
// twice a month. Enabling or disabling a pool from the UI takes effect on
// the next pass.
const POOL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// The master switch is checked far more often than the pool list, and for a
// different reason. The pool list changes maybe twice a month, so noticing it
// five minutes late is imperceptible. The switch is a button somebody just
// pressed: "off" that takes five minutes to close the sockets reads as broken.
// It costs one single-row read of `meta` every 30 seconds, and only does
// anything at all when the answer changed.
const TOGGLE_CHECK_INTERVAL_MS = 30 * 1000;

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

// See handleNotify for why ten is already absurdly generous.
const MAX_OPEN_RACES = 10;

// A stale notify must be recognised as stale without a database round-trip on
// every single message, and without growing forever. Prevhashes are only ever
// interesting for seconds, so a small ring of recently seen ones is enough.
const RECENT_PREVHASH_LIMIT = 64;
const recentPrevhashes = new Set();

/**
 * The three statements this worker runs, compiled once.
 *
 * They used to be built with db.instance.prepare(...) at the point of use -
 * and two of those points sit on the timing-critical path: the open and the
 * insert both happen inside the socket's own `data` handler, microseconds
 * after the timestamp that the whole measurement is taken from. prepare() is
 * a fresh compile every time - nothing behind it is keyed on the SQL text -
 * so every notify paid for parsing and planning the same statement again
 * before the race's own bookkeeping could finish. That work is not part of
 * what is being measured, and it is very much part of what delays the next
 * pool's chunk being read off the event loop.
 *
 * Lazily, not at module load: db.open() happens in main(), and the tests
 * require this module before opening the database.
 */
let stmts = null;
function statements() {
  if (!stmts) {
    stmts = {
      openRace: db.instance.prepare(`INSERT OR IGNORE INTO stratum_race (prevhash, created_at) VALUES (?, ?)`),
      recordReport: db.instance.prepare(
        `INSERT INTO stratum_observation (race_id, pool_id, latency_ms, rank)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(race_id, pool_id) DO UPDATE SET latency_ms = excluded.latency_ms, rank = excluded.rank
         WHERE stratum_observation.latency_ms IS NULL`,
      ),
      recordMiss: db.instance.prepare(
        `INSERT OR IGNORE INTO stratum_observation (race_id, pool_id, latency_ms, rank) VALUES (?, ?, NULL, NULL)`,
      ),
    };
  }
  return stmts;
}

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
  // Switched off: hold nothing open, and do not start anything for a pool that
  // was added in the meantime. Cheap and idempotent, so the periodic pass can
  // run unchanged whichever way the switch is set.
  if (!toggle.isEnabled()) {
    shutDownRace();
    return;
  }

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
      conn.on('notify', ({ prevhash, receivedAtHr, receivedAtMs, firstAfterConnect }) =>
        handleNotify(pool, prevhash, receivedAtHr, receivedAtMs, firstAfterConnect));
      conn.on('socketError', (err) => logger.debug('pool socket error', { label: pool.label, error: err.message }));
      conn.on('protocolError', (info) => logger.warn('pool sent something unusable', { label: pool.label, ...info }));
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

  // Anyone still enabled who never reported for this race gets a miss.
  //
  // Deliberately one statement per pool rather than all of them in a single
  // transaction. `active` is only reconciled with stratum_pool every
  // POOL_REFRESH_INTERVAL_MS, so for a few minutes after the user deletes a
  // pool it still holds that pool's id - and an insert referencing a deleted
  // pool violates the foreign key. ON CONFLICT resolution does NOT cover
  // foreign-key violations (SQLite applies OR IGNORE to uniqueness, NOT NULL
  // and CHECK only), so that insert throws, and inside one transaction it took
  // every other pool's miss down with it on rollback: the race ended up with
  // rows only for the pools that reported, which is precisely the Win%/Miss
  // bias the stratum_history_reset_v1_12_0 migration had to erase once
  // already. Per-row failure now costs exactly that row.
  const insertMiss = statements().recordMiss;
  for (const poolId of active.keys()) {
    if (race.reported.has(poolId) || race.excused.has(poolId)) continue;
    try {
      insertMiss.run(race.id, poolId);
    } catch (err) {
      // A DB error here must never crash this process - losing the whole event
      // loop over one race's bookkeeping would silently drop every pool
      // connection, not just this row.
      logger.warn('failed to record a miss for finalized race', {
        raceId: race.id,
        poolId,
        error: err.message,
      });
    }
  }
}

function finalizeAllRaces() {
  for (const prevhash of [...openRaces.keys()]) finalizeRace(prevhash);
}

/**
 * A pool's job has arrived.
 *
 * `firstAfterConnect` says this is the first mining.notify of a freshly opened
 * connection (the client counts them, see stratum-client.js), and it is not
 * timeable. A pool sends the job it is working on the moment a subscriber
 * authorizes, so that notify is a state dump answering "what is current?", not
 * an announcement answering "what just happened?" - its arrival is timed from
 * our own TCP connect, not from the block.
 *
 * Left alone, that is the most misleading measurement this worker can make. On
 * a fresh start every pool sends one within milliseconds of its handshake, the
 * first socket to complete opens the race and is credited 0ms, everyone else
 * is charged whatever their connect happened to cost - and any pool whose
 * handshake takes longer than stratumRaceTimeoutMs is written down as a miss
 * for a block it reported perfectly well. The figure produced is TCP connect
 * order, presented as which pool heard about the block first.
 *
 * So a first-after-connect job opens no race and is recorded nowhere. It only
 * marks its prevhash as seen, which is the honest thing to do with it: that
 * hash IS old news, and remembering it keeps the next pool's catch-up job from
 * opening a race for it either. Everything this worker then records is a job
 * that arrived on a connection that was already open and already listening,
 * where the difference between two pools is the pools.
 *
 * What it costs: if a block lands in the same instant a pool is reconnecting,
 * that pool's catch-up job may carry a genuinely new prevhash, and the race
 * for that block is then skipped entirely. That is a race lost, not a race
 * mismeasured, and nobody is charged a miss for it - which is the right way
 * round. The alternative is timing a socket handshake and calling it a pool.
 */
function handleNotify(pool, prevhash, receivedAtHr, receivedAtMs = Date.now(), firstAfterConnect = false) {
  if (!prevhash) return;

  let race = openRaces.get(prevhash);

  if (!race && firstAfterConnect) {
    rememberPrevhash(prevhash);
    logger.debug('first job after connect is the current one, not news - not racing it', { prevhash, label: pool.label });
    return;
  }
  // A catch-up job for a race that IS open comes from a pool that finished
  // connecting in the middle of one. Its timing measures the handshake just
  // the same, so it is not recorded - but it is excused rather than ignored:
  // the pool plainly has the job, and charging it a miss at finalize would
  // blame it for a socket of ours that happened to be down. It is not added
  // to `reported` either, because that would take a rank off the pools that
  // were actually timed.
  if (race && firstAfterConnect) {
    race.excused.add(pool.id);
    logger.debug('pool connected mid-race - neither timed nor charged', { prevhash, label: pool.label });
    return;
  }

  if (!race) {
    // Not an open race. Either this is a genuinely new block, or it is a
    // lagging pool re-sending a job for a prevhash that has already been
    // raced and closed. Crucially, this decision is made WITHOUT touching any
    // other open race - a stale job is simply ignored.
    if (recentPrevhashes.has(prevhash)) {
      logger.debug('stale prevhash from a lagging pool, ignoring', { prevhash, label: pool.label });
      return;
    }

    // One race per block, and a block every ten minutes against an eight
    // second window - so two open at once is already a coincidence and three
    // is not a thing that happens. The client only lets through a well-formed
    // 64-hex prevhash, which is the real guard; this is the second one, for
    // the case where a pool sends hashes that are shaped right and still made
    // up. Refusing to open the eleventh costs a block nothing, because a
    // genuine new block would have to arrive while ten others are still
    // unresolved.
    if (openRaces.size >= MAX_OPEN_RACES) {
      logger.warn('too many races open at once, ignoring this prevhash', {
        open: openRaces.size,
        label: pool.label,
      });
      return;
    }

    let info;
    try {
      // When the first job ARRIVED, not when it had been parsed and got this
      // far. The race's own offsets were always measured from the arrival
      // (startHr below); created_at used to be taken here, a step later, which
      // put the race's zero slightly late - and Peer Map lays this zero next
      // to the moment Core announced the block, so a late zero made "Core to
      // your pool" look longer than it was.
      info = statements().openRace.run(prevhash, receivedAtMs);
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
      // Pools that turned up mid-race with a job they could not be timed on -
      // see handleNotify's doc comment. No result, and no miss either.
      excused: new Set(),
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
    // report corrects it rather than being silently dropped by the earlier
    // miss row. Never overwrites an already-recorded real result (the WHERE
    // guards on latency_ms IS NULL).
    //
    // Honest scope note: the case this was written for - a notify arriving
    // after its own race was finalised - can no longer reach here, because
    // handleNotify marks the prevhash as seen before building the race and
    // takes the stale-prevhash early return on the way back in. What the
    // upsert still protects is the same collision arising any other way (a
    // retry, a second connection to the same pool, a finalize racing this
    // write inside the busy_timeout window), which is cheap insurance for one
    // clause. It is kept deliberately, not by accident - and the test named
    // for it asserts what actually happens now, which is that the miss
    // stands.
    statements().recordReport.run(race.id, pool.id, elapsedMs, rank);
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

/**
 * Drop every open race WITHOUT recording a miss for anyone.
 *
 * The difference from finalizeRace() is the whole point. A miss means "this
 * pool had its chance and said nothing" - a fact about the pool. A race that
 * is cut short because somebody switched the feature off is a fact about the
 * user, and charging every pool a miss for it would bias Win % and Miss in
 * exactly the way the comments above spend so long guarding against. The race
 * row stays with whatever really did report; nobody is charged for the rest.
 */
function abandonOpenRaces() {
  for (const race of openRaces.values()) clearTimeout(race.timer);
  openRaces.clear();
}

// Everything the worker holds, released. Idempotent: with nothing open and
// nothing connected this does nothing at all.
function shutDownRace() {
  abandonOpenRaces();
  stopAllConnections();
  active.clear();
}

/**
 * Act on the master switch, and only when it has actually moved.
 *
 * `null` on the first pass, so the first check always logs and always acts -
 * which is what makes the state after a restart correct without a special
 * case for it.
 */
let lastToggleState = null;

function applyToggle() {
  const enabled = toggle.isEnabled();
  if (enabled === lastToggleState) return;
  lastToggleState = enabled;
  if (enabled) {
    logger.info('stratum race switched on');
    syncConnections();
  } else {
    logger.info('stratum race switched off - closing every pool connection');
    shutDownRace();
  }
}

/**
 * The process is going away - a container restart, an app update, SIGTERM.
 *
 * The same release path as the master switch, for the same reason. A race cut
 * short by a restart says nothing about the pools that had not answered yet,
 * so nobody is charged a miss for it; abandonOpenRaces above has the whole
 * argument.
 *
 * This used to call finalizeAllRaces(), which does charge them. A restart
 * landing inside the eight-second race window therefore wrote misses that were
 * the restart's fault and not the pool's - the exact Win%/Miss bias the rest of
 * this file goes to some length to avoid. Rare, because that window is eight
 * seconds out of a ten-minute block interval, but wrong every time it happened
 * and in a direction nothing later could correct.
 */
function handleProcessShutdown() {
  shutDownRace();
}

function main() {
  processGuard.install(logger, { onShutdown: handleProcessShutdown });
  db.open();
  // The heartbeat runs whether or not the race does. A worker that is switched
  // off is healthy, not wedged, and its healthcheck has to be able to tell the
  // two apart.
  health.start(db, 'stratum-race', logger, () => ({
    enabled: toggle.isEnabled(),
    pools: active.size,
    openRaces: openRaces.size,
  }));
  applyToggle();
  setInterval(applyToggle, TOGGLE_CHECK_INTERVAL_MS);
  setInterval(syncConnections, POOL_REFRESH_INTERVAL_MS);
  logger.info('started', {
    enabled: toggle.isEnabled(),
    timeoutMs: config.stratumRaceTimeoutMs,
    pools: active.size,
  });
}

// Only run as a service when executed directly, so the race logic above can
// be exercised by the test suite instead of being unreachable behind a
// module-load side effect. The stale-prevhash regression in particular was
// only ever reproducible end to end; now it has a test.
if (require.main === module) main();

module.exports = {
  handleNotify,
  finalizeRace,
  finalizeAllRaces,
  abandonOpenRaces,
  shutDownRace,
  handleProcessShutdown,
  applyToggle,
  syncConnections,
  active,
  openRaces,
  main,
};
