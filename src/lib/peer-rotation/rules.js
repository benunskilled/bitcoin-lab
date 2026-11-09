'use strict';

/**
 * The rules the slot fill decides by - and nothing else.
 *
 * No database, no RPC, no sockets: everything here takes numbers or plain
 * ranking rows and returns an answer. The passes next door are about *doing*
 * things, and keeping the two apart is what makes the arithmetic that decides
 * who keeps a scarce slot readable on its own.
 */

const config = require('../config');

/**
 * The manual peers that may be evicted right now to make room for a better
 * one - everybody except those still inside their new-peer grace.
 *
 * A peer that has only just taken a slot has barely any record yet, so it
 * reads as the weakest of the eight no matter how good it actually is. Both
 * eviction paths would then hand its slot to anyone with a longer history,
 * which drops the newcomer back into the candidate pool - where its own full
 * history counts again and immediately wins the slot back. That loop ran for
 * hours on a real node, one disconnect and one addnode every ten minutes,
 * between two peers 0.2 points apart.
 *
 * Note this only shields against being out-ranked. A peer that never connects
 * at all is still retired by retireOfflineManualPeers on the offline grace -
 * otherwise a bad address would hold a scarce slot for fifty blocks it was
 * never present for.
 *
 * With every slot inside the grace this returns nothing, and no swap happens
 * this pass. That is the intended outcome, not a failure: there is no one it
 * would be fair to displace yet.
 *
 * The other half of "who loses the slot" is queries.weakestTrustedPeer, which
 * lives over there because the interactive "Add as Manual" at capacity has to
 * reclaim a slot by exactly the same standard this does. Both eviction paths
 * compose the two: the weakest *of the evictable ones*.
 */
function evictableTrusted(trusted) {
  // A peer with the star set is never a candidate for displacement, at any
  // record. That is what the star means: this one stays, whatever the
  // measurement says, because the reason for keeping it is not something this
  // app can measure - a friend's node, a second node of your own.
  return trusted.filter((p) => !p.kept && !p.withinNewManualGrace);
}

/**
 * How long this manual peer has been unreachable *as a manual peer*.
 *
 * Two clocks, and the answer is whichever started later. The obvious one is
 * the time since its last session closed. The other is the time since it
 * joined the manual set, and leaving it out was a genuine bug: a peer whose
 * last session ended five hours ago but which was added to the manual set one
 * minute ago is not five hours overdue, it is one minute old. Core has not
 * even had a chance to dial it yet.
 *
 * Reading only the session clock made the rotation loop eat itself. Retiring
 * parks the peer; the revival pass probes it, finds it answering, and puts it
 * straight back; the next tick reads the same stale session end and retires it
 * again - park, revive, park, revive, every ten minutes forever. Since only
 * one peer may join the manual set per tick, that loop consumed the tick's one
 * move every single time, so no genuine candidate was ever promoted while it
 * ran. Taking the later of the two clocks is what stops it: being (re-)added
 * restarts the grace period, which is what "grace" means.
 *
 * Returns null when neither clock is known - "no evidence it is offline".
 */
function offlineForMs(peer, now) {
  if (peer.live) return null;
  const sinceLastSeen = peer.offlineSinceMs;
  const sinceAdded = peer.trustedSince != null ? now - peer.trustedSince : null;
  if (sinceLastSeen == null) return sinceAdded;
  if (sinceAdded == null) return sinceLastSeen;
  return Math.min(sinceLastSeen, sinceAdded);
}

/**
 * How long a manual peer may stay offline before its slot is reclaimed.
 *
 * Two things decide this together, and they pull in opposite directions.
 *
 * A single flat timeout is the obvious design and the wrong one: it treats the
 * peer delivering 40% of your blocks first exactly like the one delivering
 * 0.8%, when the whole point of the ranking is that those are not the same
 * peer. So the wait is bought with performance - roughly an hour per
 * percentage point - which turns "how long do we wait?" into a question the
 * peer has already answered itself.
 *
 * But it is bought cheaply, because the decision is reversible: Core's
 * address book still has the peer, and the slot fill can pick it again.
 * Waiting days for a peer that might return only makes sense if losing the
 * slot were final; it is not. What the wait actually
 * has to cover is the outages that fix themselves within the hour - a node
 * restarting, a network blip - not "might be back next week". So the ceiling
 * is a day rather than a week, and the floor an hour rather than six.
 *
 * See config.js for the numbers and the worked examples.
 */
function offlineGraceMs(firstPct) {
  const hours = Math.min(
    config.offlineGraceMaxHours,
    Math.max(config.offlineGraceMinHours, (firstPct == null ? 0 : firstPct) * config.offlineGraceHoursPerPct),
  );
  return hours * 60 * 60 * 1000;
}

// Both only ever appear in a rotation-log note or a peer label, where a reader
// wants "3h" and "12.4%", not a millisecond count and fifteen decimal places.
function fmtHours(ms) {
  const hours = ms / 3600000;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function fmtPct(pct) {
  return pct == null ? 'no record' : `${pct.toFixed(1)}%`;
}

module.exports = {
  evictableTrusted,
  offlineForMs,
  offlineGraceMs,
  fmtHours,
  fmtPct,
};
