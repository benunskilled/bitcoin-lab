'use strict';

/**
 * Every read the app makes that is more than a single statement, grouped by
 * what it is asking about.
 *
 * What lives where:
 *
 *   peer-ranking.js   the ranking statement, the recent-window snapshot and
 *                     the order everything else reads peers in
 *   ranking-row.js    what one of those rows means - network, classification,
 *                     the two rates, the grace
 *   peers.js          the other peer questions: weakest manual peer, who is
 *                     offline, what is live right now
 *   stratum.js        the pool race: wins, latencies, percentiles, deletion
 *   blocks.js         the newest block and who delivered it
 *   stats.js          the widget's four numbers and the outbound funnel
 *   maintenance.js    pruning what may be pruned
 *
 * A directory rather than a single module so that every existing
 * require('./queries') keeps resolving unchanged - the split is invisible from
 * the outside, and the ten names below are exactly the ones the dashboard, the
 * profilers, the rotation and the tests already use.
 */

const { peerRanking } = require('./peer-ranking');
const { weakestTrustedPeer, offlineTrustedPeers, liveSummary } = require('./peers');
const { stratumRanking, deletePool } = require('./stratum');
const { latestBlock } = require('./blocks');
const { widgetStats, outboundFunnel } = require('./stats');
const { pruneOldData } = require('./maintenance');

module.exports = {
  peerRanking,
  weakestTrustedPeer,
  offlineTrustedPeers,
  liveSummary,
  stratumRanking,
  latestBlock,
  deletePool,
  pruneOldData,
  widgetStats,
  outboundFunnel,
};
