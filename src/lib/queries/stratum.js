'use strict';

/**
 * The Stratum Race side: which pool reports a new job first, how often, and
 * how fast - plus removing a pool without tripping over its history.
 */

const db = require('../db');

// Range presets for the Stratum Race panel are block-count based ("last N
// races"), not wall-clock windows - blocks (and therefore races) don't
// arrive on a schedule, so "last 100 blocks" is a far more meaningful,
// pool-comparable window than "last 24 hours" (which might hold 2 blocks
// or 20 depending on luck). 'all' means no filter at all.
function raceIdsForRange(range) {
  if (range === 'all') return null;
  const n = Number(range);
  if (Number.isFinite(n) && n > 0) {
    return db.instance.prepare(`SELECT id FROM stratum_race ORDER BY id DESC LIMIT ?`).all(n).map((r) => r.id);
  }
  return null; // unrecognized value - fail open to all-time rather than showing nothing
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

// Two prepared seeks reused for the all-time path below. With the covering
// index on (pool_id, latency_ms) each is an index walk that materialises a
// single row - SQLite skips the OFFSET entries inside the index rather than
// handing them to us.
let nthLatencyStmt = null;
function nthLatency(poolId, offset) {
  if (!nthLatencyStmt) {
    nthLatencyStmt = db.instance.prepare(
      `SELECT latency_ms FROM stratum_observation
        WHERE pool_id = ? AND latency_ms IS NOT NULL
        ORDER BY latency_ms ASC LIMIT 1 OFFSET ?`,
    );
  }
  const row = nthLatencyStmt.get(poolId, offset);
  return row ? row.latency_ms : null;
}

/**
 * Median and P90 per pool, without ever loading a pool's full latency history
 * into JavaScript - which is what v1.11.1 did, once per pool, on an endpoint
 * the dashboard polls every 20 seconds. At a full retention window that was
 * hundreds of thousands of rows marshalled and sorted per request.
 *
 * Two shapes, because the right plan genuinely differs:
 *
 *  - A bounded range ("last 10/100 races") is answered by one query for all
 *    pools at once. race_id leads the primary key, so this is a handful of
 *    rows, and sorting them here is free.
 *
 *  - All-time has no selective filter, so instead of reading every row we ask
 *    the index directly for the nth smallest value. The sample count comes
 *    from the aggregate that has already been computed (seen minus misses),
 *    so this costs two index seeks per pool and nothing else.
 *
 * Both paths pick exactly the row the previous implementation did: 0-based
 * index min(n - 1, floor(p * n)) over the ascending samples.
 */
function percentilesByPool({ pools, statsByPool, raceIds, raceFilterSql, raceFilterParams }) {
  const result = new Map();

  if (raceIds) {
    const rows = db.instance
      .prepare(
        `SELECT pool_id AS poolId, latency_ms AS latencyMs
           FROM stratum_observation
          WHERE latency_ms IS NOT NULL ${raceFilterSql}
          ORDER BY pool_id, latency_ms ASC`,
      )
      .all(...raceFilterParams);
    const byPool = new Map();
    for (const row of rows) {
      if (!byPool.has(row.poolId)) byPool.set(row.poolId, []);
      byPool.get(row.poolId).push(row.latencyMs);
    }
    for (const pool of pools) {
      const samples = byPool.get(pool.id) || [];
      result.set(pool.id, { medianMs: percentile(samples, 0.5), p90Ms: percentile(samples, 0.9) });
    }
    return result;
  }

  for (const pool of pools) {
    const s = statsByPool.get(pool.id);
    const n = s ? s.seen - s.misses : 0;
    if (n <= 0) {
      result.set(pool.id, { medianMs: null, p90Ms: null });
      continue;
    }
    result.set(pool.id, {
      medianMs: nthLatency(pool.id, Math.min(n - 1, Math.floor(0.5 * n))),
      p90Ms: nthLatency(pool.id, Math.min(n - 1, Math.floor(0.9 * n))),
    });
  }
  return result;
}

function stratumRanking(range = '10') {
  const pools = db.instance.prepare(`SELECT * FROM stratum_pool ORDER BY is_default DESC, label ASC`).all();
  const raceIds = raceIdsForRange(range);

  // better-sqlite3 needs a concrete placeholder list for IN(); an empty range
  // (e.g. "last 10 races" before any race has happened yet) still needs valid,
  // always-false SQL rather than an empty IN() call.
  const raceFilterSql = raceIds
    ? `AND race_id IN (${raceIds.length ? raceIds.map(() => '?').join(',') : 'NULL'})`
    : '';
  const raceFilterParams = raceIds || [];

  const stats = db.instance
    .prepare(
      `SELECT
         pool_id AS poolId,
         COUNT(*) AS seen,
         SUM(CASE WHEN latency_ms IS NULL THEN 1 ELSE 0 END) AS misses,
         SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS wins,
         AVG(latency_ms) AS avgMs
       FROM stratum_observation
       WHERE 1 = 1 ${raceFilterSql}
       GROUP BY pool_id`,
    )
    .all(...raceFilterParams);
  const statsByPool = new Map(stats.map((s) => [s.poolId, s]));

  const percentiles = percentilesByPool({ pools, statsByPool, raceIds, raceFilterSql, raceFilterParams });

  // Which pool (if any) won the single most recent race - drives the
  // "last winner" badge regardless of which time range is selected.
  const lastRace = db.instance.prepare(`SELECT id FROM stratum_race ORDER BY id DESC LIMIT 1`).get();
  const lastWinnerPoolId = lastRace
    ? db.instance.prepare(`SELECT pool_id FROM stratum_observation WHERE race_id = ? AND rank = 1`).get(lastRace.id)?.pool_id
    : null;

  const ranked = pools.map((pool) => {
    const s = statsByPool.get(pool.id);
    const pct = percentiles.get(pool.id);
    return {
      id: pool.id,
      label: pool.label,
      host: pool.host,
      port: pool.port,
      enabled: Boolean(pool.enabled),
      isDefault: Boolean(pool.is_default),
      seen: s ? s.seen : 0,
      misses: s ? s.misses : 0,
      wins: s ? s.wins : 0,
      winPct: s && s.seen > 0 ? (100 * s.wins) / s.seen : null,
      avgMs: s ? s.avgMs : null,
      medianMs: pct ? pct.medianMs : null,
      p90Ms: pct ? pct.p90Ms : null,
      wonLastRace: pool.id === lastWinnerPoolId,
    };
  });

  // Same two-level ranking as peerRanking(): win% first (how often this
  // pool is the fastest to report a new job, not just how long it's been
  // watched), avg latency ("ping") as the tiebreaker - lower is better, and
  // a pool with no wins/samples yet sorts to the bottom rather than winning
  // ties by default.
  ranked.sort((a, b) => {
    const aRate = a.winPct ?? -1;
    const bRate = b.winPct ?? -1;
    if (aRate !== bRate) return bRate - aRate;
    const aAvg = a.avgMs ?? Infinity;
    const bAvg = b.avgMs ?? Infinity;
    if (aAvg !== bAvg) return aAvg - bAvg;
    return a.label.localeCompare(b.label);
  });

  return ranked;
}

// stratum_observation.pool_id has no ON DELETE CASCADE and foreign keys are
// enforced (see db.js) - a pool that has ever raced (even just recorded a
// "miss") has observation rows referencing it, so a bare DELETE on
// stratum_pool throws a FOREIGN KEY constraint failure. Delete its
// observation history first, in one transaction, so removing a pool always
// works regardless of whether it ever produced data.
function deletePool(id) {
  const tx = db.instance.transaction((poolId) => {
    db.instance.prepare(`DELETE FROM stratum_observation WHERE pool_id = ?`).run(poolId);
    db.instance.prepare(`DELETE FROM stratum_pool WHERE id = ?`).run(poolId);
    // Races in which this pool was the only participant now have no
    // observations at all. Left in place they still occupy slots in the
    // "last N races" windows, so the range selector would quietly show fewer
    // data points than it claims. Drop the empty shells with the pool.
    db.instance
      .prepare(`DELETE FROM stratum_race WHERE id NOT IN (SELECT DISTINCT race_id FROM stratum_observation)`)
      .run();
  });
  tx(id);
}

module.exports = { stratumRanking, deletePool };
