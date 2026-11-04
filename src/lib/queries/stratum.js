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

// The ranking only changes with a new race, a new observation or a change to
// the pools; between those the dashboard asks every 20 seconds for the same
// answer. Over a year of races "all" takes about 150 ms, on the one thread
// that also serves the live stream - so it is kept until something changed.
const rankingCache = new Map();

function stratumRanking(range = '10') {
  const pools = db.instance.prepare(`SELECT * FROM stratum_pool ORDER BY is_default DESC, label ASC`).all();
  // The newest race and the newest observation row, both read off the end of
  // their table: a race finished after a newer one opened still changes it.
  const head = db.instance
    .prepare(`SELECT (SELECT MAX(id) FROM stratum_race) AS race, (SELECT MAX(rowid) FROM stratum_observation) AS obs`)
    .get();
  const key = `${head.race}:${head.obs}:${JSON.stringify(pools)}`;
  const hit = rankingCache.get(range);
  if (hit && hit.key === key) return hit.value;
  const value = computeRanking(range, pools);
  // A handful of ranges is all the page asks for; any number can be typed
  // into the URL, so the cache does not grow with them.
  if (rankingCache.size >= 8) rankingCache.clear();
  rankingCache.set(range, { key, value });
  return value;
}

function computeRanking(range, pools) {
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

  // The single most recent race, whatever the range: which pool won it (the
  // badge) and how far behind each pool was in it (the "Last block" column,
  // beside the average over the range - 04.11.2026, in place of median and
  // P90, which nobody read).
  const lastRace = db.instance.prepare(`SELECT id FROM stratum_race ORDER BY id DESC LIMIT 1`).get();
  const lastRows = lastRace
    ? db.instance.prepare(`SELECT pool_id AS poolId, latency_ms AS latencyMs, rank FROM stratum_observation WHERE race_id = ?`).all(lastRace.id)
    : [];
  const lastByPool = new Map(lastRows.map((r) => [r.poolId, r]));
  const lastWinnerPoolId = lastRows.find((r) => r.rank === 1)?.poolId ?? null;

  const ranked = pools.map((pool) => {
    const s = statsByPool.get(pool.id);
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
      lastMs: lastByPool.get(pool.id)?.latencyMs ?? null,
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
    const removed = db.instance.prepare(`DELETE FROM stratum_pool WHERE id = ?`).run(poolId).changes;
    // Races in which this pool was the only participant now have no
    // observations at all. Left in place they still occupy slots in the
    // "last N races" windows, so the range selector would quietly show fewer
    // data points than it claims. Drop the empty shells with the pool.
    // Older than a minute only: a race the worker has just opened has no
    // observations yet either.
    db.instance
      .prepare(`DELETE FROM stratum_race WHERE id NOT IN (SELECT DISTINCT race_id FROM stratum_observation) AND created_at < ?`)
      .run(Date.now() - 60_000);
    return removed;
  });
  return tx(id) > 0;
}

module.exports = { stratumRanking, deletePool };
