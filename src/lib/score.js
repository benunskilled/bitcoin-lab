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
 *
 * All of the above was an argument. It has since been measured, against 2,206
 * recorded blocks on a real node, replayed in order so that at every point the
 * score saw only what the app would have known then (scripts/backtest-score.js
 * runs it against any database with enough history). Of 1,604 evaluable blocks,
 * asking each rule to rank the peers connected at that moment and looking up
 * where the peer that actually delivered came out:
 *
 *   rule                 top-1    top-3    top-8   mean rank
 *   this one             34.7 %   64.2 %   96.1 %      4.30
 *   lifetime only        25.4 %   66.8 %   96.3 %      4.45
 *   recent, raw rate     33.7 %   63.5 %   95.9 %      4.47
 *
 * So the window earns its place: against lifetime alone it ranked the real
 * deliverer better on 615 blocks and worse on 270, which is not a coincidence
 * anybody needs to argue about. Wilson earns its place too, though by less -
 * 126 to 98 against the raw recent rate, which is the right direction and not
 * yet proof.
 *
 * Two things that came out of it and are worth knowing. The first is that
 * lifetime-only is BETTER at top-3 and top-8. The lifetime record finds the
 * solid field; the recent window finds the one peer. The rotation needs the
 * one peer, so this is the right trade, but it is a trade and not a rout.
 *
 * The second is the rule this file nearly grew instead: "once a peer has 50
 * observations in the window, judge it on the window alone and drop the
 * lifetime part". It changed the ranking on 19 blocks out of 1,604, and of
 * those it was better on 7 and worse on 12. It is not an improvement, and the
 * reason is that it is barely a different rule - a peer with enough history to
 * be judged has usually filled most of the window too, so `filled` is already
 * near 1 and the blend is already nearly all window.
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

module.exports = { wilsonLowerBound, peerScore };
