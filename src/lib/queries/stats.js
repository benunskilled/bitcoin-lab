'use strict';

/**
 * Summary numbers for the two places that show a handful of figures rather
 * than a table: Umbrel's home-screen widget and the funnel panel.
 */

const db = require('../db');
const config = require('../config');
const { liveSummary } = require('./peers');
const { recentRelayStats } = require('./peer-ranking');
const { peerScore } = require('../score');
const stratumRace = require('../stratum-race-toggle');

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
/**
 * The peer the home screen calls "best", by the same rule the dashboard ranks
 * by - the recent window, as a Wilson lower bound (see score.js).
 *
 * It used to be the raw lifetime rate straight out of peer_relay_stats, and
 * when 1.16.0 moved the ranking to the window that was simply left behind. The
 * widget then quietly disagreed with the app's own table: a peer delivering
 * 46.8% of the last 500 blocks showed up on the home screen as 29.5%, its
 * average over a much longer and much worse past. The same mistake had already
 * been made once here with the eligibility bar, one level down.
 *
 * Still deliberately not peerRanking(). This runs around the clock on every
 * install whether or not anyone has the dashboard open, and the ranking is the
 * expensive query in this app. What it costs instead is one small read over
 * the currently-open sessions, plus the window snapshot - which the ranking
 * has usually already cached against the newest race id.
 *
 * Restricted to peers that are connected right now, which the ranking is too.
 * Without that the home screen could name a peer that did well last week and
 * left on Tuesday.
 */
function bestPeerNow() {
  const recent = recentRelayStats();
  const rows = db.instance
    .prepare(
      `SELECT p.id, p.address, prs.first, prs.eligible
         FROM peer_relay_stats prs
         JOIN peer p ON p.id = prs.peer_id
        WHERE prs.eligible >= ?
          AND EXISTS (SELECT 1 FROM peer_session ps WHERE ps.peer_id = p.id AND ps.ended_at IS NULL)`,
    )
    .all(config.minEligibleForJudgement);

  let best = null;
  for (const r of rows) {
    const window = recent.get(r.id);
    const recentFirst = window ? window.first : 0;
    const recentEligible = window ? window.eligible : 0;
    const score = peerScore({
      first: r.first,
      eligible: r.eligible,
      recentFirst,
      recentEligible,
    });
    if (score == null) continue;
    // Shown as the window rate, because that is the number beside this peer in
    // the dashboard's table. The score decides the order; the percentage is
    // what a person reads.
    const firstPct = recentEligible > 0
      ? (100 * recentFirst) / recentEligible
      : (100 * r.first) / r.eligible;
    if (!best || score > best.score) {
      best = { address: r.address, first: recentFirst, eligible: recentEligible, firstPct, score };
    }
  }
  return best;
}

function widgetStats() {
  const bestPeer = bestPeerNow();

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
    // Nothing rather than the last thing measured, when the race is switched
    // off. Umbrel polls this around the clock, so a pool left in here would sit
    // on the home screen for as long as the app is installed, looking like a
    // live measurement of something that stopped weeks ago.
    bestPool: stratumRace.isEnabled() ? bestPool || null : null,
    trustedTotal: trusted.total,
    trustedOnline: trusted.online || 0,
  };
}

/**
 * The outbound funnel: how many random peers Core has handed this node, how
 * many stayed long enough to be judged, how many ever delivered a block first,
 * and how many were kept.
 *
 * Counted by IP, not by address. Core reaches an outbound peer on its listening
 * port so its address is stable, but a promoted inbound peer joins under a
 * second address - the ephemeral source port it dialled from, then :8333 - and
 * counting addresses would count that host twice. rtrim/instr does the port
 * stripping in SQL so the de-duplication survives a table of any size; the
 * bracketed IPv6 form ([::1]:8333) keeps its brackets, which is fine because it
 * is stripped the same way every time.
 *
 * "Promoted" is the one number that cannot come from the tables the others use.
 * rotation_log holds thirty rows, so it would report a count that shrinks while
 * the loop works; promoted_peer exists for exactly this and nothing else.
 */
function outboundFunnel() {
  const IP = `CASE WHEN instr(p.address, ']') > 0
                   THEN substr(p.address, 1, instr(p.address, ']'))
                   ELSE substr(p.address, 1, instr(p.address, ':') - 1) END`;
  const OUTBOUND = `EXISTS (SELECT 1 FROM peer_session ps
                             WHERE ps.peer_id = p.id AND ps.direction = 'outbound')`;

  const row = db.instance
    .prepare(
      `SELECT
         COUNT(DISTINCT ${IP})                                                    AS seen,
         COUNT(DISTINCT CASE WHEN s.eligible >= @bar THEN ${IP} END)              AS tested,
         COUNT(DISTINCT CASE WHEN s.eligible >= @bar AND s.first > 0 THEN ${IP} END) AS delivered
       FROM peer p
       LEFT JOIN peer_relay_stats s ON s.peer_id = p.id
       WHERE ${OUTBOUND}`,
    )
    .get({ bar: config.minEligibleForJudgement });

  const promoted = db.instance.prepare(`SELECT COUNT(*) AS n FROM promoted_peer`).get().n;

  return {
    seen: row.seen || 0,
    tested: row.tested || 0,
    delivered: row.delivered || 0,
    promoted: promoted || 0,
  };
}

module.exports = { widgetStats, outboundFunnel };
