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
         COALESCE(sess.totalMs, 0) AS totalMs
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
    currentSessionMs: r.liveDirection ? now - r.liveStartedAt : null,
    minPingMs: r.liveMinPingMs,
    lastPingMs: r.liveLastPingMs,
    sessionsCount: r.sessionsCount,
    totalConnectionMs: r.totalMs,
    status: statusFor(r),
  }));
}

function statusFor(r) {
  const trusted = Boolean(r.trusted);
  const live = Boolean(r.liveDirection);
  if (trusted && live) return 'MANUAL LIVE';
  if (trusted && !live) return 'TRUSTED (OFFLINE)';
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

function stratumRanking() {
  const pools = db.instance.prepare(`SELECT * FROM stratum_pool ORDER BY is_default DESC, label ASC`).all();
  const stats = db.instance
    .prepare(
      `SELECT
         pool_id AS poolId,
         COUNT(*) AS seen,
         SUM(CASE WHEN latency_ms IS NULL THEN 1 ELSE 0 END) AS misses,
         SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS wins,
         AVG(latency_ms) AS avgMs
       FROM stratum_observation
       GROUP BY pool_id`,
    )
    .all();
  const statsByPool = new Map(stats.map((s) => [s.poolId, s]));

  // Median/P90 need the raw sorted samples - fetch per pool (fine at this scale).
  const samplesStmt = db.instance.prepare(
    `SELECT latency_ms FROM stratum_observation WHERE pool_id = ? AND latency_ms IS NOT NULL ORDER BY latency_ms ASC`,
  );

  return pools.map((pool) => {
    const s = statsByPool.get(pool.id);
    const samples = samplesStmt.all(pool.id).map((r) => r.latency_ms);
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
    };
  });
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

module.exports = { peerRanking, liveSummary, stratumRanking };
