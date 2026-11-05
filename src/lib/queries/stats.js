'use strict';

/**
 * Summary numbers for the funnel panel, which shows a handful of figures
 * rather than a table.
 */

const db = require('../db');
const config = require('../config');
const { sqlHostFromAddress } = require('../address');

/**
 * The outbound funnel: how many random peers Core has handed this node, how
 * many stayed long enough to be judged, how many ever delivered a block first,
 * and how many were kept.
 *
 * Counted by IP, not by address. Core reaches an outbound peer on its listening
 * port so its address is stable, but a peer that also dialled in appears under
 * a second address - the ephemeral source port it came from - and counting
 * addresses would count that host twice. The stripping is done in SQL, by the
 * same rule hostFromAddress applies one address at a time (see address.js), so
 * the de-duplication survives a table of any size and cannot disagree with the
 * spelling the rotation writes into promoted_peer.
 *
 * All four numbers are over one population: hosts this node has held an
 * OUTBOUND connection to. That is what makes it a funnel - each stage is a
 * subset of the one before it, and the panel it sits under is titled Outbound
 * Peers.
 *
 * "Kept" used to be a bare COUNT(*) over promoted_peer, which is a different
 * population: that table is also backfilled from the manual set, so a node with
 * eight hand-added peers - one of them an address Core never managed to connect
 * at all - read "3 seen, 2 tested, 1 delivered, 9 kept". A last stage larger
 * than the first is not a surprising statistic, it is a contradiction, and it
 * is read as one. promoted_peer stays the durable record of every host ever
 * kept (rotation_log holds thirty rows, so it cannot answer that); this query
 * asks it only about the hosts the other three numbers are about.
 */
function outboundFunnelSql() {
  const IP = sqlHostFromAddress('p.address');
  return `SELECT
         COUNT(DISTINCT ${IP})                                                       AS seen,
         COUNT(DISTINCT CASE WHEN s.eligible >= @bar THEN ${IP} END)                 AS tested,
         COUNT(DISTINCT CASE WHEN s.eligible >= @bar AND s.first > 0 THEN ${IP} END) AS delivered,
         COUNT(DISTINCT CASE WHEN EXISTS (
           SELECT 1 FROM promoted_peer pp WHERE pp.ip = ${IP}
         ) THEN ${IP} END)                                                           AS promoted
       FROM peer p
       LEFT JOIN peer_relay_stats s ON s.peer_id = p.id
       WHERE EXISTS (SELECT 1 FROM peer_session ps
                      WHERE ps.peer_id = p.id AND ps.direction = 'outbound')`;
}

/**
 * Cached against the newest block, exactly like routeMedian() in blocks.js and
 * for the same reason, only more so: this one runs on every /api/status poll,
 * and it is a scan of the peer table, which is deliberately never pruned for
 * any peer that has ever been around when a block landed. Ten milliseconds
 * after a week and hundreds after a year, several times a minute, for four
 * numbers that describe a lifetime and move by one at a time.
 *
 * A block is the right key because three of the four numbers can only change
 * when one is recorded. `seen` can also change when a peer connects, so a host
 * that arrives mid-block waits for the next one to be counted - up to ten
 * minutes on a lifetime total, which is not a number anybody reads that way.
 *
 * Before the first block there is nothing to key on and nothing cached: a fresh
 * install is exactly where peers arrive by the minute and where a frozen answer
 * would be most visible.
 */
let funnelCache = { raceId: null, value: null };
let funnelStmt = null;

function outboundFunnel() {
  if (!funnelStmt) funnelStmt = db.instance.prepare(outboundFunnelSql());
  const newest = db.instance.prepare(`SELECT MAX(id) AS id FROM relay_race`).get().id;
  if (newest != null && funnelCache.raceId === newest) return funnelCache.value;

  const row = funnelStmt.get({ bar: config.minEligibleForJudgement });
  const value = {
    seen: row.seen || 0,
    tested: row.tested || 0,
    delivered: row.delivered || 0,
    promoted: row.promoted || 0,
  };
  if (newest != null) funnelCache = { raceId: newest, value };
  return value;
}

module.exports = { outboundFunnel };
