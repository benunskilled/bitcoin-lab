'use strict';

/**
 * The rules the rotation decides by - and nothing else.
 *
 * No database, no RPC, no sockets: everything here takes numbers or plain
 * ranking rows and returns an answer. That is the point of the file. The four
 * passes next door are about *doing* things, and keeping the two apart is what
 * makes the arithmetic that decides who keeps a scarce slot readable on its
 * own, without a socket or a table in sight.
 */

const config = require('../config');

// A peer's lifetime First/Eligible ranking only means something once it has
// been through roughly a full day of blocks - judging a peer after two or
// three blocks would kick or promote on pure noise. Applied identically by the
// kick and the promote pass, so nothing is acted on before it has had a fair,
// day-scale sample to earn (or fail to earn) its ranking. Lives in config.js
// because the widget has to agree with it (see minEligibleForJudgement).
const MIN_ELIGIBLE_FOR_JUDGEMENT = config.minEligibleForJudgement;

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
 * Is the challenger enough better than the peer holding the slot to be worth
 * the swap? A missing record scores below zero, so a peer with any measured
 * percentage still beats one with none.
 *
 * Strictly-better was the old rule and it churned slots for nothing: taking a
 * slot costs a real disconnect and a real addnode, and 0.6% against 0.4% is a
 * difference of one block in five hundred.
 */
function beatsHolder(challengerPct, holderPct) {
  const score = (pct) => (pct == null ? -1 : pct);
  return score(challengerPct) - score(holderPct) > config.minSwapMarginPct;
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
 * But it is bought cheaply, because parking makes the decision reversible.
 * Waiting days for a peer that might return only makes sense if losing the
 * slot were final; it is not (see reviveParkedPeers). What the wait actually
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

/**
 * The longest gap between two knocks on a parked peer's door.
 *
 * Not one number for everyone. The peers worth waiting for get knocked on at
 * full speed indefinitely; the ones that were barely better than random get
 * knocked on progressively more rarely, because even a successful answer from
 * them is worth very little. Full speed from parkedPeerFullSpeedPct upwards,
 * sliding linearly down to the slow ceiling at a record of zero.
 *
 * Deliberately the opposite direction from probing everyone equally often and
 * simply keeping the list shorter: knocking harder on a peer that delivered
 * 40% of your blocks costs three sockets a tick and can save you days of a
 * worse peer set, while knocking on a 1% peer twice a day for a month is pure
 * noise for a reward you would not notice.
 */
function probeIntervalCapMs(firstPct) {
  const fast = config.parkedPeerMaxProbeIntervalHours * 60 * 60 * 1000;
  const slow = config.parkedPeerSlowProbeIntervalHours * 60 * 60 * 1000;
  const share = Math.min(1, (firstPct == null ? 0 : firstPct) / config.parkedPeerFullSpeedPct);
  return slow + (fast - slow) * share;
}

/**
 * How long a parked peer is remembered at all, before its address is dropped
 * and it becomes just another peer the node has seen. Same shape as the
 * offline grace period: bought with the peer's own record.
 *
 * Kept in JavaScript as well as in the DELETE statement's SQL because the
 * dashboard and the tests both need to be able to ask the question without
 * running the deletion.
 */
function parkedRetentionMs(firstPct) {
  const days = Math.min(
    config.parkedPeerMaxRetentionDays,
    Math.max(config.parkedPeerMinRetentionDays, (firstPct == null ? 0 : firstPct) * config.parkedPeerRetentionDaysPerPct),
  );
  return days * 24 * 60 * 60 * 1000;
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
  MIN_ELIGIBLE_FOR_JUDGEMENT,
  evictableTrusted,
  beatsHolder,
  offlineForMs,
  offlineGraceMs,
  probeIntervalCapMs,
  parkedRetentionMs,
  fmtHours,
  fmtPct,
};
