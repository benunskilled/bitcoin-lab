'use strict';

/**
 * Everything asked about peers that is not the ranking: which manual peer is
 * the weakest, which of them are not here right now, and how the live
 * connections break down by direction and type.
 */

const db = require('../db');

/**
 * The weakest of a set of manual peers - i.e. whose slot is the one worth
 * reclaiming. Takes anything carrying `firstPct` and `live`, which in practice
 * means rows straight out of peerRanking().
 *
 * Being offline is deliberately not what makes a peer weakest: a strong peer
 * that dropped a minute ago must not lose its slot to a mediocre live one
 * (that is what the performance-scaled grace period in peer-rotation/rules.js is
 * for). It only breaks ties, where it is the obvious tiebreak - between two
 * peers with the same record, the one that is not even here should go first.
 * A peer with no record at all (firstPct null) sorts below 0%.
 *
 * Lives here, in one place, because three callers need the identical answer:
 * the rotation loop's swap branch, the manual "Add as Manual" flow when all
 * eight slots are taken, and the revival of a parked peer. Three private
 * copies of "weakest" would be three chances for the dashboard to explain one
 * rule while the code follows another.
 */
function weakestTrustedPeer(peers) {
  if (!peers || peers.length === 0) return null;
  // The peer score, not the lifetime rate: whose slot to take is a question
  // about who is worth holding now, and that is what the score is for. A peer
  // with no record at all still sorts below any measured one.
  const score = (p) => (p.score == null ? -1 : p.score);
  return peers.reduce((worst, p) => {
    if (score(p) !== score(worst)) return score(p) < score(worst) ? p : worst;
    if (!p.live && worst.live) return p;
    return worst;
  });
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

module.exports = { weakestTrustedPeer, offlineTrustedPeers, liveSummary };
