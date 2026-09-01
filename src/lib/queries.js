'use strict';

const db = require('./db');
const config = require('./config');
const { ipv4HostFromAddress, ipv4InCidr } = require('./address');

// A subver like "/electrs:0.11.1/" -> "electrs" - just enough to name which
// local app a same-host peer connection belongs to.
function localAppNameFromSubver(subver) {
  if (!subver) return null;
  const stripped = String(subver).replace(/^\/+|\/+$/g, '');
  const name = stripped.split(':')[0];
  return name || null;
}

// The ranking statement is 60 lines of joins and is re-run several times a
// minute; parsing and planning it every time was measurable, unlike the
// small statements elsewhere in this file. Prepared once, on first use, and
// held for the life of the process (see nthLatencyStmt below for the same
// pattern).
let peerRankingStmt = null;

/**
 * The peer table is deliberately never pruned for any peer that has ever been
 * connected when a block landed (see config.js) - it only grows. This query
 * therefore has to say what it wants: peers that are connected right now, or
 * that are manual. Nothing else is displayed by the dashboard or acted on by
 * the rotation loop, and without the filter every request materialised, sorted
 * and serialised every peer the node had ever seen in order to render ten rows.
 *
 * The two aggregate joins are correlated subqueries rather than derived tables
 * for the same reason: as derived tables SQLite computed them across the whole
 * of peer_session before the join could discard them again.
 */
function peerRanking() {
  const now = Date.now();
  if (!peerRankingStmt) {
    peerRankingStmt = db.instance.prepare(peerRankingSql());
  }
  const rows = peerRankingStmt.all({ now });
  return rows.map(mapRankingRow(now));
}

function peerRankingSql() {
  return `SELECT
         p.id,
         p.address,
         tp.label AS trustedLabel,
         (tp.address IS NOT NULL) AS trusted,
         COALESCE(prs.eligible, 0) AS eligible,
         COALESCE(prs.first, 0) AS first,
         os.direction AS liveDirection,
         os.connection_type AS liveConnectionType,
         os.started_at AS liveStartedAt,
         os.min_ping_ms AS liveMinPingMs,
         os.last_ping_ms AS liveLastPingMs,
         -- Correlated rather than a derived table: as a GROUP BY over the
         -- whole of peer_session it was computed for every peer that table
         -- has ever held, then thrown away by the join.
         (SELECT COUNT(*) FROM peer_session s WHERE s.peer_id = p.id) AS sessionsCount,
         (SELECT COALESCE(SUM(COALESCE(s.ended_at, @now) - s.started_at), 0)
            FROM peer_session s WHERE s.peer_id = p.id) AS totalMs,
         latest.subver AS client,
         latest.latestEndedAt AS latestEndedAt
       FROM peer p
       LEFT JOIN trusted_peer tp ON tp.address = p.address
       -- Two GROUP BY passes over the whole of relay_observation used to sit
       -- here. That table is deliberately never pruned, so their cost grew
       -- with every block the node ever saw; peer_relay_stats holds the same
       -- totals as one row per peer, kept exact by triggers on
       -- relay_observation itself (see db.js), so it cannot drift.
       LEFT JOIN peer_relay_stats prs ON prs.peer_id = p.id
       LEFT JOIN peer_session os ON os.peer_id = p.id AND os.ended_at IS NULL
       LEFT JOIN (
         -- Most recent session's subver + end time per peer, live or not, so
         -- a currently-offline manual peer still shows the client it last
         -- ran, and how long ago it dropped (ended_at is NULL for the
         -- session actually still live, in which case there's nothing to
         -- report here - offline duration only ever comes from a peer's
         -- most recent CLOSED session).
         SELECT ps.peer_id, ps.subver, ps.ended_at AS latestEndedAt
         FROM peer_session ps
         WHERE ps.id = (
           SELECT id FROM peer_session ps2
           WHERE ps2.peer_id = ps.peer_id
           ORDER BY started_at DESC LIMIT 1
         )
       ) latest ON latest.peer_id = p.id
       -- Only what anything actually consumes: live peers and manual ones.
       -- Without this the query walked every peer the node had ever seen -
       -- a table that, by design, never shrinks - to render ten rows.
       WHERE os.peer_id IS NOT NULL OR tp.address IS NOT NULL
       -- Rank by how OFTEN a peer is first, not how often it's merely been
       -- around (a peer online forever racks up a high raw "first" count
       -- at a mediocre rate) - percentage first. Ping is the 2nd-level
       -- tiebreaker (lower is better; peers with no live ping sort after
       -- ones that have one, rather than winning ties by default), then raw
       -- eligible count, then address as the final, purely deterministic
       -- tiebreaker.
       ORDER BY
         CASE WHEN COALESCE(prs.eligible, 0) > 0 THEN (1.0 * COALESCE(prs.first, 0) / prs.eligible) ELSE -1 END DESC,
         CASE WHEN os.min_ping_ms IS NULL THEN 1 ELSE 0 END ASC,
         os.min_ping_ms ASC,
         COALESCE(prs.eligible, 0) DESC,
         p.address ASC`;
}

function mapRankingRow(now) {
  return (r) => {
    // "Trusted" isn't only what's in our own trusted_peer table - Core
    // itself reports connection_type 'manual' for ANY addnode'd peer,
    // including ones added outside this app entirely (bitcoin-cli addnode,
    // -addnode= in bitcoin.conf, or a peer added before this table
    // existed). Treating those as untrusted was the bug behind a manual
    // peer showing up in the Outbound panel with an "Add as Manual" button
    // instead of "Remove" - Core already considers it manual, so we should
    // too, immediately, without waiting for the background adoption sync
    // (see peer-sync.js adoptExternalManualPeers) to catch up.
    const trusted = Boolean(r.trusted) || r.liveConnectionType === 'manual';
    // An inbound IPv6 peer relayed through Docker's docker-proxy shows up in
    // Core's own getpeerinfo as the Docker bridge gateway address, not the
    // peer's real one - Core itself never learns the true source, so there
    // is no real address for us to recover or act on here (see config.js).
    // Flag it so the UI can label it honestly instead of displaying (or
    // letting the user try to manually add/probe) a meaningless local IP.
    const sourceObscured = r.address.startsWith(`${config.dockerProxyMaskedAddressHost}:`);
    // Everything else inside Umbrel's shared internal Docker network isn't
    // an external peer at all - it's another app on the same host (electrs,
    // mempool's indexer, etc.) connecting to Core's P2P port directly, the
    // same way a real peer would. Its address is perfectly real (unlike
    // sourceObscured above), just not "a peer" in any useful sense - it's
    // already connected via the host's own network, so there's nothing to
    // manually add and nothing worth disconnecting on purpose either.
    const ipv4Host = ipv4HostFromAddress(r.address);
    const localUmbrelPeer = !sourceObscured
      && ipv4Host != null
      && ipv4InCidr(ipv4Host, config.umbrelInternalNetworkCidr);
    return {
      address: r.address,
      sourceObscured,
      localUmbrelPeer,
      localAppName: localUmbrelPeer ? localAppNameFromSubver(r.client) : null,
      trusted,
      trustedLabel: r.trustedLabel,
      eligible: r.eligible,
      first: r.first,
      firstPct: r.eligible > 0 ? (100 * r.first) / r.eligible : null,
      live: Boolean(r.liveDirection),
      direction: r.liveDirection,
      connectionType: r.liveConnectionType,
      client: r.client || null,
      currentSessionMs: r.liveDirection ? now - r.liveStartedAt : null,
      // How long a trusted-but-not-currently-live peer has been offline -
      // Core reconnects manuals on its own, but that can fail silently
      // (peer went dark, network hiccup, slot contention) and a peer that's
      // been offline for hours is worth surfacing, not just a flat pill.
      // Only meaningful for a trusted peer that isn't live and has actually
      // had a session before (never null-vs-0 ambiguity: a peer trusted but
      // never yet seen connecting has no latestEndedAt at all).
      offlineSinceMs: !r.liveDirection && r.latestEndedAt != null ? now - r.latestEndedAt : null,
      minPingMs: r.liveMinPingMs,
      lastPingMs: r.liveLastPingMs,
      sessionsCount: r.sessionsCount,
      totalConnectionMs: r.totalMs,
      status: statusFor(r, trusted),
      // Connection-type-only status, ignoring the manual/trusted override -
      // used where "MANUAL LIVE" would just be redundant noise (e.g. the
      // Outbound Peers panel, which already implies live).
      connectionStatus: r.liveDirection ? (r.liveConnectionType || r.liveDirection).toUpperCase() : 'OFFLINE',
    };
  };
}

/**
 * Trusted peers that are not currently connected, with how long they have
 * been gone. Previously this was derived by building the entire ranking and
 * filtering it in JavaScript, every ten minutes, purely to write a log line.
 * The question is narrow, so the query is too.
 */
function offlineTrustedPeers() {
  const now = Date.now();
  return db.instance
    .prepare(
      `SELECT tp.address, tp.label AS trustedLabel,
              (SELECT MAX(ended_at) FROM peer_session ps
                 JOIN peer p ON p.id = ps.peer_id
                WHERE p.address = tp.address) AS lastEndedAt
       FROM trusted_peer tp
       WHERE NOT EXISTS (
         SELECT 1 FROM peer_session ps
           JOIN peer p ON p.id = ps.peer_id
          WHERE p.address = tp.address AND ps.ended_at IS NULL
       )
       ORDER BY tp.address`,
    )
    .all()
    .map((r) => ({
      address: r.address,
      trustedLabel: r.trustedLabel,
      offlineSinceMs: r.lastEndedAt != null ? now - r.lastEndedAt : null,
    }));
}

function statusFor(r, trusted) {
  const live = Boolean(r.liveDirection);
  if (trusted && live) return 'MANUAL LIVE';
  if (trusted && !live) return 'MANUAL OFFLINE';
  if (live) return `${(r.liveConnectionType || r.liveDirection || 'LIVE').toUpperCase()}`;
  return 'OFFLINE';
}

function liveSummary() {
  const rows = db.instance
    .prepare(
      `SELECT direction, connection_type AS connectionType, COUNT(*) AS cnt
       FROM peer_session WHERE ended_at IS NULL
       GROUP BY direction, connection_type`,
    )
    .all();
  const summary = {
    total: 0,
    inbound: 0,
    outbound: 0,
    manual: 0,
    outboundFullRelay: 0,
    blockRelayOnly: 0,
  };
  for (const r of rows) {
    summary.total += r.cnt;
    if (r.direction === 'inbound') summary.inbound += r.cnt;
    if (r.direction === 'outbound') summary.outbound += r.cnt;
    if (r.connectionType === 'manual') summary.manual += r.cnt;
    if (r.connectionType === 'outbound-full-relay') summary.outboundFullRelay += r.cnt;
    if (r.connectionType === 'block-relay-only') summary.blockRelayOnly += r.cnt;
  }
  return summary;
}

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

// Latest relay race (newest block Bitcoin Core told us about via ZMQ) plus
// the peer(s) whose getpeerinfo.last_block matched the detection instant -
// i.e. whichever peer(s) actually delivered this block to us first. Used
// purely to drive the "new block" UI flash - never on the timing-critical
// write path itself (relay-profiler.js writes these rows independently).
function latestBlock() {
  const race = db.instance
    .prepare(
      `SELECT id, block_hash AS blockHash, block_height AS blockHeight, detected_at AS detectedAt
       FROM relay_race ORDER BY id DESC LIMIT 1`,
    )
    .get();
  if (!race) return null;

  const firstPeers = db.instance
    .prepare(
      `SELECT p.address AS address, tp.label AS trustedLabel
       FROM relay_observation ro
       JOIN peer p ON p.id = ro.peer_id
       LEFT JOIN trusted_peer tp ON tp.address = p.address
       WHERE ro.race_id = ? AND ro.first = 1`,
    )
    .all(race.id);

  return { ...race, firstPeers };
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

// Caps unbounded growth WITHOUT touching the two things that give this app
// its long-term value: relay_race/relay_observation (the actual
// peer-ranking data - never time-pruned, see config.js) and any peer that
// has ever appeared in it, or is manually trusted (kept forever, sessions
// included). Only "feeler" peers - no relay history, ever, not trusted -
// and old stratum-pool history are pruned by age. Runs as one transaction,
// in dependency order, so a crash mid-prune never leaves an orphaned or
// FK-violating row behind. Returns how many rows of each kind were
// removed, purely for logging.
function pruneOldData({
  feelerPeerRetentionDays = config.feelerPeerRetentionDays,
  stratumHistoryRetentionDays = config.stratumHistoryRetentionDays,
} = {}) {
  const feelerCutoff = Date.now() - feelerPeerRetentionDays * 24 * 60 * 60 * 1000;
  const stratumCutoff = Date.now() - stratumHistoryRetentionDays * 24 * 60 * 60 * 1000;

  const tx = db.instance.transaction(() => {
    db.instance
      .prepare(`DELETE FROM stratum_observation WHERE race_id IN (SELECT id FROM stratum_race WHERE created_at < ?)`)
      .run(stratumCutoff);
    const stratumRacesDeleted = db.instance.prepare(`DELETE FROM stratum_race WHERE created_at < ?`).run(stratumCutoff).changes;

    // Only a CLOSED session (ended_at IS NOT NULL - a currently-live one is
    // never touched regardless of age) belonging to a "feeler" peer - one
    // with NO relay_observation row, ever, and not (or never) manually
    // trusted - gets removed here, and only once it's older than the much
    // shorter feeler window. A peer with real relay history, or a trusted
    // one, keeps every session forever, no matter its age.
    //
    // "Has relay history" is asked of peer_relay_stats rather than of
    // relay_observation: db.js's triggers keep exactly one row there per peer
    // that appears in relay_observation, so it is the same set of peers - one
    // row each, instead of scanning a table that is never pruned and holds one
    // row per peer per block (millions, on a node that has run for months).
    const feelerSessionsDeleted = db.instance
      .prepare(
        `DELETE FROM peer_session
         WHERE ended_at IS NOT NULL AND ended_at < ?
           AND peer_id IN (
             SELECT id FROM peer p
             WHERE p.id NOT IN (SELECT peer_id FROM peer_relay_stats)
               AND p.address NOT IN (SELECT address FROM trusted_peer)
           )`,
      )
      .run(feelerCutoff).changes;

    // A peer left with no session and no relay-observation history after
    // the delete above is pure dead weight - drop it, unless it's (or ever
    // was) manually trusted, since trusted_peer keys on address
    // independently of this table.
    const peersDeleted = db.instance
      .prepare(
        `DELETE FROM peer
         WHERE id NOT IN (SELECT DISTINCT peer_id FROM peer_session)
           AND id NOT IN (SELECT peer_id FROM peer_relay_stats)
           AND address NOT IN (SELECT address FROM trusted_peer)`,
      )
      .run().changes;

    // Rollup rows only ever exist for peers that appear in relay_observation,
    // and those peers are never pruned - so this should always be a no-op.
    // It runs anyway so the summary table can never outlive its peer and
    // silently resurrect a stale row under a recycled id.
    db.instance.prepare(`DELETE FROM peer_relay_stats WHERE peer_id NOT IN (SELECT id FROM peer)`).run();

    return { stratumRacesDeleted, feelerSessionsDeleted, peersDeleted };
  });
  return tx();
}

/**
 * The four numbers behind Umbrel's home-screen widget, as four small queries.
 *
 * Umbrel polls the widget endpoint on the schedule declared in the manifest's
 * widgets: block, whether or not anyone has the dashboard open - so this runs
 * around the clock on every install. It used to build the entire peer ranking
 * AND the entire stratum ranking - including a median and a P90 for every pool
 * - and then read four values out of them.
 *
 * The "best peer" threshold is config.minEligibleForJudgement, the same bar
 * the rotation loop uses before it will act on a peer's percentage. It was 5
 * blocks here, which is how a peer that happened to be first in 3 of its
 * first 5 blocks could sit on the home screen as the node's "best peer" at
 * 60% while rotation, correctly, still considered it unproven.
 */
function widgetStats() {
  const bestPeer = db.instance
    .prepare(
      `SELECT p.address, prs.first, prs.eligible, (100.0 * prs.first / prs.eligible) AS firstPct
       FROM peer_relay_stats prs
       JOIN peer p ON p.id = prs.peer_id
       WHERE prs.eligible >= ?
       ORDER BY firstPct DESC, prs.eligible DESC, p.address ASC
       LIMIT 1`,
    )
    .get(config.minEligibleForJudgement);

  const bestPool = db.instance
    .prepare(
      `SELECT sp.label, AVG(so.latency_ms) AS avgMs, COUNT(so.latency_ms) AS seen
       FROM stratum_pool sp
       JOIN stratum_observation so ON so.pool_id = sp.id AND so.latency_ms IS NOT NULL
       GROUP BY sp.id
       HAVING seen >= 3
       ORDER BY avgMs ASC
       LIMIT 1`,
    )
    .get();

  const trusted = db.instance
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM peer_session ps JOIN peer p ON p.id = ps.peer_id
                WHERE p.address = tp.address AND ps.ended_at IS NULL
              ) THEN 1 ELSE 0 END) AS online
       FROM trusted_peer tp`,
    )
    .get();

  return {
    live: liveSummary(),
    bestPeer: bestPeer || null,
    bestPool: bestPool || null,
    trustedTotal: trusted.total,
    trustedOnline: trusted.online || 0,
  };
}

module.exports = {
  peerRanking,
  offlineTrustedPeers,
  liveSummary,
  stratumRanking,
  latestBlock,
  deletePool,
  pruneOldData,
  widgetStats,
};
