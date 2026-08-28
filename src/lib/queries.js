'use strict';

const db = require('./db');

function peerRanking() {
  const now = Date.now();
  const rows = db.instance
    .prepare(
      `SELECT
         p.id,
         p.address,
         p.first_seen_at AS firstSeenAt,
         tp.label AS trustedLabel,
         (tp.address IS NOT NULL) AS trusted,
         COALESCE(elig.cnt, 0) AS eligible,
         COALESCE(fst.cnt, 0) AS first,
         os.direction AS liveDirection,
         os.connection_type AS liveConnectionType,
         os.started_at AS liveStartedAt,
         os.min_ping_ms AS liveMinPingMs,
         os.last_ping_ms AS liveLastPingMs,
         COALESCE(sess.sessionsCount, 0) AS sessionsCount,
         COALESCE(sess.totalMs, 0) AS totalMs,
         latest.subver AS client
       FROM peer p
       LEFT JOIN trusted_peer tp ON tp.address = p.address
       LEFT JOIN (SELECT peer_id, COUNT(*) cnt FROM relay_observation GROUP BY peer_id) elig
         ON elig.peer_id = p.id
       LEFT JOIN (SELECT peer_id, COUNT(*) cnt FROM relay_observation WHERE first = 1 GROUP BY peer_id) fst
         ON fst.peer_id = p.id
       LEFT JOIN peer_session os ON os.peer_id = p.id AND os.ended_at IS NULL
       LEFT JOIN (
         SELECT peer_id, COUNT(*) sessionsCount, SUM(COALESCE(ended_at, @now) - started_at) totalMs
         FROM peer_session GROUP BY peer_id
       ) sess ON sess.peer_id = p.id
       LEFT JOIN (
         -- Most recent session's subver per peer, live or not, so even a
         -- currently-offline manual peer still shows the client it last ran.
         SELECT ps.peer_id, ps.subver
         FROM peer_session ps
         WHERE ps.id = (
           SELECT id FROM peer_session ps2
           WHERE ps2.peer_id = ps.peer_id
           ORDER BY started_at DESC LIMIT 1
         )
       ) latest ON latest.peer_id = p.id
       ORDER BY first DESC, eligible DESC, p.address ASC`,
    )
    .all({ now });

  return rows.map((r) => ({
    address: r.address,
    firstSeenAt: r.firstSeenAt,
    trusted: Boolean(r.trusted),
    trustedLabel: r.trustedLabel,
    eligible: r.eligible,
    first: r.first,
    firstPct: r.eligible > 0 ? (100 * r.first) / r.eligible : null,
    live: Boolean(r.liveDirection),
    direction: r.liveDirection,
    connectionType: r.liveConnectionType,
    client: r.client || null,
    currentSessionMs: r.liveDirection ? now - r.liveStartedAt : null,
    minPingMs: r.liveMinPingMs,
    lastPingMs: r.liveLastPingMs,
    sessionsCount: r.sessionsCount,
    totalConnectionMs: r.totalMs,
    status: statusFor(r),
    // Connection-type-only status, ignoring the manual/trusted override -
    // used where "MANUAL LIVE" would just be redundant noise (e.g. the
    // Outbound Peers panel, which already implies live).
    connectionStatus: r.liveDirection ? (r.liveConnectionType || r.liveDirection).toUpperCase() : 'OFFLINE',
  }));
}

function statusFor(r) {
  const trusted = Boolean(r.trusted);
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

// Time-range presets for the Stratum Race panel. '10' means "last 10 races"
// (by id, not wall-clock time - closer to "last 10 blocks" than any fixed
// window would be); everything else is a rolling wall-clock window;
// 'all' means no filter at all.
const STRATUM_RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function raceIdsForRange(range) {
  if (range === '10') {
    return db.instance.prepare(`SELECT id FROM stratum_race ORDER BY id DESC LIMIT 10`).all().map((r) => r.id);
  }
  if (range && range !== 'all' && STRATUM_RANGE_MS[range]) {
    const cutoff = Date.now() - STRATUM_RANGE_MS[range];
    return db.instance.prepare(`SELECT id FROM stratum_race WHERE created_at >= ?`).all(cutoff).map((r) => r.id);
  }
  return null; // no filter - all-time
}

function stratumRanking(range = '10') {
  const pools = db.instance.prepare(`SELECT * FROM stratum_pool ORDER BY is_default DESC, label ASC`).all();
  const raceIds = raceIdsForRange(range);

  // better-sqlite3 needs a concrete placeholder list for IN(); an empty
  // range (e.g. "last 10 races" before any race has happened yet) still
  // needs valid, always-false SQL rather than an empty IN() call.
  const raceFilterSql = raceIds ? `WHERE race_id IN (${raceIds.length ? raceIds.map(() => '?').join(',') : 'NULL'})` : '';
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
       ${raceFilterSql}
       GROUP BY pool_id`,
    )
    .all(...raceFilterParams);
  const statsByPool = new Map(stats.map((s) => [s.poolId, s]));

  // Median/P90 need the raw sorted samples - fetch per pool (fine at this scale).
  const samplesStmt = db.instance.prepare(
    `SELECT latency_ms FROM stratum_observation
     WHERE pool_id = ? AND latency_ms IS NOT NULL ${raceIds ? `AND race_id IN (${raceIds.length ? raceIds.map(() => '?').join(',') : 'NULL'})` : ''}
     ORDER BY latency_ms ASC`,
  );

  // Which pool (if any) won the single most recent race - drives the
  // "last winner" badge regardless of which time range is selected.
  const lastRace = db.instance.prepare(`SELECT id FROM stratum_race ORDER BY id DESC LIMIT 1`).get();
  const lastWinnerPoolId = lastRace
    ? db.instance.prepare(`SELECT pool_id FROM stratum_observation WHERE race_id = ? AND rank = 1`).get(lastRace.id)?.pool_id
    : null;

  return pools.map((pool) => {
    const s = statsByPool.get(pool.id);
    const samples = samplesStmt.all(pool.id, ...raceFilterParams).map((r) => r.latency_ms);
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
      medianMs: percentile(samples, 0.5),
      p90Ms: percentile(samples, 0.9),
      wonLastRace: pool.id === lastWinnerPoolId,
    };
  });
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
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

module.exports = { peerRanking, liveSummary, stratumRanking, latestBlock };
