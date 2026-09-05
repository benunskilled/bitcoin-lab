'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { wilsonLowerBound, peerScore } = require('../src/lib/score');
const config = require('../src/lib/config');

test('the lower bound sits below the raw rate, and closes on it as evidence accumulates', () => {
  // The whole reason this replaced the raw rate. Same 10%, three sample sizes:
  // the bound has to rise towards 10 as the sample grows, or it is not
  // measuring confidence at all.
  const small = wilsonLowerBound(2, 20);
  const medium = wilsonLowerBound(20, 200);
  const large = wilsonLowerBound(200, 2000);

  assert.ok(small < medium && medium < large, `expected ${small} < ${medium} < ${large}`);
  assert.ok(large < 10, 'still below the raw rate - a bound, not the estimate');
  assert.ok(large > 8.7, 'but close to it once there are two thousand blocks to go on');
});

test('a thin sample loses to a thick one at a higher raw rate', () => {
  // The concrete case from the review: 4 of 55 reads as 7.3% and outranks
  // 61 of 900 at 6.8%, on four blocks' worth of evidence.
  const thin = wilsonLowerBound(4, 55);
  const thick = wilsonLowerBound(61, 900);

  assert.ok(4 / 55 > 61 / 900, 'the raw rates really are the wrong way round');
  assert.ok(thin < thick, `the bounds put them right: ${thin.toFixed(1)} < ${thick.toFixed(1)}`);
});

test('no trials is zero, not an error and not a division by zero', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.equal(wilsonLowerBound(5, 0), 0);
});

test('zero successes still leaves room for doubt on a short sample', () => {
  // 0 of 40 is not proof of a useless peer. The bound is zero either way here,
  // but the SCORE must not treat forty blocks of silence like five hundred.
  const short = peerScore({ first: 0, eligible: 40, recentFirst: 0, recentEligible: 40 });
  const long = peerScore({ first: 0, eligible: 500, recentFirst: 0, recentEligible: 500 });
  assert.equal(short, 0);
  assert.equal(long, 0);
  // Which is why the kick rule stayed a plain count of blocks and did not move
  // to this score: at zero deliveries the bound cannot tell the two apart.
});

test('a peer that stopped delivering falls behind one that is delivering now', () => {
  // The decay case. Identical lifetime samples; one has done nothing for the
  // last five hundred blocks, the other is doing well right now.
  const faded = peerScore({ first: 400, eligible: 2000, recentFirst: 0, recentEligible: 500 });
  const rising = peerScore({ first: 40, eligible: 2000, recentFirst: 50, recentEligible: 500 });

  assert.ok(400 / 2000 > 40 / 2000, 'on lifetime alone the faded peer wins by a mile');
  assert.ok(rising > faded, `the score puts the live one first: ${rising.toFixed(1)} > ${faded.toFixed(1)}`);
});

test('a short bad streak is not enough to condemn a peer', () => {
  // The counterweight. Two peers, both around for two thousand blocks; one has
  // only been present for twenty of the recent window, which is noise, not a
  // verdict. Twenty of five hundred is a twenty-fifth of the score, so its
  // silence costs it a twenty-fifth of what it earned.
  const unlucky = peerScore({ first: 300, eligible: 2000, recentFirst: 0, recentEligible: 20 });
  const mediocre = peerScore({ first: 20, eligible: 2000, recentFirst: 1, recentEligible: 500 });

  assert.ok(unlucky > mediocre, `${unlucky.toFixed(1)} > ${mediocre.toFixed(1)}`);
});

test('a peer with no record at all is not the same as a measured zero', () => {
  assert.equal(peerScore({ first: 0, eligible: 0, recentFirst: 0, recentEligible: 0 }), null);
  assert.equal(peerScore({ first: 0, eligible: 100, recentFirst: 0, recentEligible: 100 }), 0);
});

test('a full window decides alone, whatever the lifetime record says', () => {
  // The rule in one assertion. Identical recent windows, opposite lifetimes:
  // once the window is full the lifetime figure has no vote left, so the two
  // scores are not merely close, they are the same number.
  const full = config.recentScoreWindowBlocks;
  const wasExcellent = peerScore({ first: 1000, eligible: 2000, recentFirst: 25, recentEligible: full });
  const wasUseless = peerScore({ first: 0, eligible: 2000, recentFirst: 25, recentEligible: full });

  assert.equal(wasExcellent, wasUseless);
  assert.equal(wasExcellent, wilsonLowerBound(25, full));
});

test('a half-filled window leans half on the lifetime record', () => {
  // The other half of the rule: the lifetime figure is not a weight, it is
  // what stands in for the part of the window we have not observed yet.
  const half = config.recentScoreWindowBlocks / 2;
  const lifetime = wilsonLowerBound(200, 2000);
  const score = peerScore({ first: 200, eligible: 2000, recentFirst: 0, recentEligible: half });

  assert.ok(Math.abs(score - 0.5 * lifetime) < 1e-9, `${score} vs ${0.5 * lifetime}`);
  assert.ok(score > 0, 'not written off on half a window of silence');
});

test('more observations than blocks in the window cannot invert the blend', () => {
  // Defensive: a race recorded twice would put recentEligible above the window
  // size, and an uncapped fraction would make the lifetime share negative -
  // i.e. a good history would start counting against the peer.
  const over = peerScore({
    first: 1000,
    eligible: 2000,
    recentFirst: 0,
    recentEligible: config.recentScoreWindowBlocks * 3,
  });

  // Both bounds matter. Below, because a two-thousand-block record of 50% must
  // contribute nothing once the window is full. And above zero, because that is
  // the failure the cap exists to prevent: uncapped, the fraction is 3, the
  // lifetime share is -2, and this peer scores -27 - worse than a peer that has
  // never delivered anything in its life.
  //
  // Not assert.equal(over, 0): the Wilson bound at zero successes lands within
  // a rounding error of zero rather than on it, and which side of zero that
  // error falls on depends on the trial count.
  assert.ok(over >= 0 && over < 1e-9, `${over}`);
});
