'use strict';

/**
 * The peer ranking: one statement, one snapshot of the recent window, and the
 * order the rest of the app reads peers in.
 *
 * Both caches here exist for the same reason - this is asked for several times
 * a minute, by the dashboard and by the rotation, and it is the only query in
 * the app whose cost would otherwise grow with the node's own lifetime.
 */

const db = require('../db');
const config = require('../config');
const { mapRankingRow } = require('./ranking-row');

// The ranking statement is 60 lines of joins and is re-run several times a
// minute; parsing and planning it every time was measurable, unlike the
// small statements elsewhere in this file. Prepared once, on first use, and
// held for the life of the process (see nthLatencyStmt below for the same
// pattern).
let peerRankingStmt = null;

/**
 * Per-peer totals over the last N races, for the recent half of the peer score.
 *
 * Cached against the newest race id, which is the only thing that can change
 * the answer. Measured on a synthetic four-million-row observation table the
 * query itself takes about 17ms - fine once per block, wasteful several times
 * a minute, which is how often the ranking is asked for. Reading MAX(id) to
 * check is a primary-key lookup and costs nothing.
 *
 * Bounded by "the newest N race ids that exist" rather than "MAX(id) minus N",
 * because deleting the measurement data leaves gaps in the sequence and the
 * second form would then silently shrink the window.
 */
let recentStatsCache = { raceId: null, byPeer: new Map() };

function recentRelayStats() {
  const newest = db.instance.prepare(`SELECT MAX(id) AS id FROM relay_race`).get().id;
  if (newest == null) return new Map();
  if (recentStatsCache.raceId === newest) return recentStatsCache.byPeer;

  const rows = db.instance
    .prepare(
      `SELECT peer_id AS peerId, COUNT(*) AS eligible, COALESCE(SUM(first), 0) AS first
         FROM relay_observation
        WHERE race_id >= (SELECT MIN(id) FROM (SELECT id FROM relay_race ORDER BY id DESC LIMIT ?))
        GROUP BY peer_id`,
    )
    .all(config.recentScoreWindowBlocks);

  const byPeer = new Map(rows.map((r) => [r.peerId, r]));
  recentStatsCache = { raceId: newest, byPeer };
  return byPeer;
}

/**
 * When the new-slot-holder grace period starts: the moment the block
 * `newManualGraceBlocks` back was detected. A manual peer added after that has
 * not yet been through its grace.
 *
 * Counted in blocks rather than measured in hours because the thing being
 * granted is a fair sample, and a sample is blocks. Read as one row - the Nth
 * newest race - rather than counted per peer, which would be a scan of the
 * whole race table for every row of the ranking.
 *
 * Zero when the node has not seen that many blocks at all: nobody can have
 * been through a grace that has not elapsed, so everything with a start date
 * is still inside it.
 */
function newManualGraceStartedAt() {
  const row = db.instance
    .prepare(`SELECT detected_at AS at FROM relay_race ORDER BY id DESC LIMIT 1 OFFSET ?`)
    .get(Math.max(0, config.newManualGraceBlocks - 1));
  return row ? row.at : 0;
}

function peerRanking() {
  const now = Date.now();
  if (!peerRankingStmt) {
    peerRankingStmt = db.instance.prepare(peerRankingSql());
  }
  const recent = recentRelayStats();
  const graceFrom = newManualGraceStartedAt();
  const rows = peerRankingStmt.all({ now }).map(mapRankingRow(now, recent, graceFrom));

  // Ordered here rather than in SQL: the score combines two windows and one of
  // them is not in that statement. The set is the live peers plus the manual
  // ones - a couple of hundred rows - so sorting them in JavaScript costs
  // nothing worth measuring, and the tiebreakers are the same ones the query
  // used: a peer with any measured record beats one with none, then the lower
  // ping, then the larger sample, then the address so the order never wobbles
  // between two identical peers.
  return rows.sort((a, b) => {
    const sa = a.score == null ? -1 : a.score;
    const sb = b.score == null ? -1 : b.score;
    if (sa !== sb) return sb - sa;
    const pa = a.minPingMs == null ? Infinity : a.minPingMs;
    const pb = b.minPingMs == null ? Infinity : b.minPingMs;
    if (pa !== pb) return pa - pb;
    if (a.eligible !== b.eligible) return b.eligible - a.eligible;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });
}

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
function peerRankingSql() {
  return `SELECT
         p.id,
         p.address,
         tp.label AS trustedLabel,
         tp.created_at AS trustedSince,
         (tp.address IS NOT NULL) AS trusted,
         COALESCE(tp.kept, 0) AS kept,
         COALESCE(prs.eligible, 0) AS eligible,
         COALESCE(prs.first, 0) AS first,
         os.direction AS liveDirection,
         os.connection_type AS liveConnectionType,
         -- Core's network for the live session, falling back to the most
         -- recent closed one so an offline manual peer keeps its label.
         COALESCE(os.network, latest.network) AS coreNetwork,
         os.started_at AS liveStartedAt,
         os.min_ping_ms AS liveMinPingMs,
         os.last_ping_ms AS liveLastPingMs,
         -- Correlated rather than a derived table: as a GROUP BY over the
         -- whole of peer_session it was computed for every peer that table
         -- has ever held, then thrown away by the join.
         (SELECT COUNT(*) FROM peer_session s WHERE s.peer_id = p.id) AS sessionsCount,
         -- Has Core ever actually held a manual connection to this peer? Not
         -- the same as being in the manual set: an address can sit there for
         -- days without Core ever getting a connection to stand up, which is
         -- what a peer that only ever dialled IN looks like. The star's
         -- protection against parking hangs on this, so a bad address cannot
         -- hold one of eight slots forever.
         EXISTS (SELECT 1 FROM peer_session s WHERE s.peer_id = p.id AND s.connection_type = 'manual') AS everManual,
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
         SELECT ps.peer_id, ps.subver, ps.network, ps.ended_at AS latestEndedAt
         FROM peer_session ps
         WHERE ps.id = (
           SELECT id FROM peer_session ps2
           WHERE ps2.peer_id = ps.peer_id
           ORDER BY started_at DESC LIMIT 1
         )
       ) latest ON latest.peer_id = p.id
       -- Only what anything actually consumes: live peers and manual ones.
       --
       -- Written as a subquery on p.id rather than as a predicate reading
       -- "os.peer_id IS NOT NULL OR tp.address IS NOT NULL", which reads more
       -- naturally and is a trap: as a predicate on the join result it can only be applied AFTER
       -- the join, so SQLite walked every row of the peer table - which by
       -- design never shrinks - doing five index seeks each, to return ~200
       -- rows. The plan opened with SCAN p, and the cost tracked the number of
       -- peers the node had ever seen: 1.6ms on a fresh install, 8ms after a
       -- year, 23ms on a busy one. This form drives the query from the two
       -- small sets instead, and the plan opens with a primary-key search.
       WHERE p.id IN (
         SELECT peer_id FROM peer_session WHERE ended_at IS NULL
         UNION
         SELECT id FROM peer WHERE address IN (SELECT address FROM trusted_peer)
       )
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

module.exports = { peerRanking };
