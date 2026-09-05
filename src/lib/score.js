'use strict';

const config = require('./config');

/**
 * How good a peer looks, as one number the rotation can order by.
 *
 * The raw rate - first divided by eligible - was that number for a long time,
 * and it is wrong in two ways that pull in opposite directions.
 *
 * It believes small samples. Four blocks out of fifty-five reads as 7.3% and
 * outranks sixty-one out of nine hundred at 6.8%, even though the second peer
 * has proven something and the first has barely been observed. Lowering the
 * judgement threshold from 144 blocks to 50 made this worse, not better: more
 * peers now reach the ranking on thin evidence.
 *
 * And it never forgets. Every figure is a lifetime figure with no decay, so a
 * peer whose routing changed months ago keeps the record it earned before
 * that. Four hundred out of two thousand still reads as 20% while the peer has
 * delivered nothing at all for the last two hundred blocks.
 */

// 95% confidence. Not a knob: it is the conventional level, and the number
// only has to be consistent across peers for the ordering to mean something.
const Z = 1.96;

/**
 * Wilson score interval, lower bound, as a percentage.
 *
 * "What rate can this peer be relied on for, given how little we have seen?"
 * With few observations the answer sits well below the raw rate; with many it
 * converges on it. That is the whole point - it costs an unproven peer
 * something to be unproven, without ever ruling it out.
 *
 * Preferred over a plain normal approximation because it stays sane at the
 * edges, which is exactly where peers live: at 0 of 40 the normal formula puts
 * the interval at zero width, claiming certainty from an absence of evidence.
 */
function wilsonLowerBound(successes, trials) {
  if (!trials || trials <= 0) return 0;
  const p = successes / trials;
  const denominator = 1 + (Z * Z) / trials;
  const centre = p + (Z * Z) / (2 * trials);
  const margin = Z * Math.sqrt((p * (1 - p)) / trials + (Z * Z) / (4 * trials * trials));
  // Clamped: with zero successes the arithmetic lands a whisker below zero
  // (-6.3e-16 at 0 of 40), and a value that is negative only in the last bits
  // sorts below a true zero for no reason anyone could see or explain.
  return Math.max(0, (100 * (centre - margin)) / denominator);
}

/**
 * One score from two windows: what the peer has done lately, and what it has
 * done ever.
 *
 * The rule is that the recent window decides, and the lifetime figure only
 * fills in the part of that window we do not have yet. A peer that has been
 * around for all of the last five hundred blocks is judged on those five
 * hundred blocks and nothing else; one that has been around for fifty of them
 * is judged one tenth on those fifty and nine tenths on its whole record.
 *
 * This started life as a fixed blend - a weight you could turn, set at 0.6 -
 * and the decay case it was written for is exactly the case it failed. Compare
 * a peer that delivered 400 of 2000 and has since gone quiet for five hundred
 * blocks against one at 40 of 2000 that is delivering 10% right now: under
 * 60/40 the dead peer still wins, 7.3 to 5.2. It only loses above a weight of
 * 0.69, and no honest argument picks 0.7 over 0.6 - the number was never
 * derived from anything, it was just a number. A weight that has to be tuned
 * until one hand-picked example comes out right is not a rule.
 *
 * Full weight on a full window needs no tuning and no defending. Five hundred
 * blocks of silence is not a bad streak, it is three and a half days of a peer
 * doing nothing while connected, and a record it earned last month cannot
 * explain that. Nothing is lost by dropping the history: the peer whose
 * routing recovers rebuilds a recent window in a few hours and comes straight
 * back, because the lifetime record is still there for the ranking to show and
 * for the parking rules to use.
 *
 * Both halves still go through Wilson, and the short-window half needs it more
 * than ever. A peer that has been present for twenty of the last five hundred
 * blocks contributes a twentieth of its score from a sample of twenty - and
 * that sample's own bound is wide, so a quiet stretch that short moves almost
 * nothing.
 *
 * Returns null for a peer with no lifetime record at all, which is not the
 * same as a measured zero: everything downstream already treats a missing
 * record as sorting below any measured one (see beatsHolder), and a peer that
 * has simply never been present for a block should not be confused with one
 * that has been present for five hundred and delivered none of them.
 */
function peerScore({ first, eligible, recentFirst, recentEligible }) {
  if (!eligible || eligible <= 0) return null;
  const lifetime = wilsonLowerBound(first || 0, eligible);
  const recent = wilsonLowerBound(recentFirst || 0, recentEligible || 0);
  // How much of the recent window this peer was actually there for. Capped at
  // 1 because the window can hold more observations than blocks if a race is
  // ever recorded twice, and a fraction above 1 would push the lifetime share
  // negative.
  const filled = Math.min(1, (recentEligible || 0) / config.recentScoreWindowBlocks);
  return filled * recent + (1 - filled) * lifetime;
}

module.exports = { wilsonLowerBound, peerScore, Z };
