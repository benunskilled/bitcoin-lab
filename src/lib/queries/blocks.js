'use strict';

const db = require('../db');

// Latest relay race (newest block Bitcoin Core told us about via ZMQ) plus
// the peer(s) whose getpeerinfo.last_block matched the detection instant -
// i.e. whichever peer(s) actually delivered this block to us first. Used
// purely to drive the "new block" UI flash - never on the timing-critical
// write path itself (relay-profiler.js writes these rows independently).
function latestBlock() {
  const race = db.instance
    .prepare(
      `SELECT id, block_hash AS blockHash, block_height AS blockHeight, detected_at AS detectedAt
       FROM relay_race ORDER BY id DESC LIMIT 1`,
    )
    .get();
  if (!race) return null;

  const firstPeers = db.instance
    .prepare(
      `SELECT p.address AS address, tp.label AS trustedLabel
       FROM relay_observation ro
       JOIN peer p ON p.id = ro.peer_id
       LEFT JOIN trusted_peer tp ON tp.address = p.address
       WHERE ro.race_id = ? AND ro.first = 1`,
    )
    .all(race.id);

  return { ...race, firstPeers };
}

// How many blocks in a row with nobody credited before this says anything.
//
// Five, and that is not a cautious number - it is already far past what the
// evidence needs. Across 2,206 blocks recorded on a live node, the number of
// blocks where no peer was credited is zero. Not rare: none. The matching
// window identifies exactly one peer essentially every time, so a single miss
// is already odd and five in a row cannot happen by chance on a node whose
// clocks agree.
//
// The cost of a larger number is the only thing it buys, and it buys nothing:
// twenty blocks would be three and a half hours of a broken install looking
// perfectly fine before it admits anything. Five is fifty minutes.
//
// It doubles as the minimum sample. Fewer than five recorded blocks is a
// fresh install, and a fresh install has nothing to diagnose.
const ATTRIBUTION_SAMPLE = 5;

// The same window the relay profiler matches last_block against. Repeated here
// rather than imported, because requiring the profiler from a query module
// would drag in the RPC client and the ZMQ socket for one number. A test
// asserts the two stay equal, so this cannot drift unnoticed.
const ATTRIBUTION_WINDOW_MS = 2500;

/**
 * Is block attribution actually working, and if not, does the data say why?
 *
 * The failure this exists for is the quiet one. Point this app at a Core on
 * another machine whose clock is a few seconds out, and every block is
 * recorded with nobody credited: the peer tables fill up, the block counter
 * climbs, First % stays at 0 for every peer forever, and nothing anywhere
 * connects the two. The README has carried it as a known limitation for
 * exactly that reason - it was not detectable from inside.
 *
 * The symptom is first_count. One peer credited per block is the normal case,
 * and a run of zeroes is the fault. The cause is nearest_delta_ms: the closest
 * last_block any peer reported, relative to when the block was detected. Under
 * a second when the clocks agree, a steady several seconds when they do not,
 * with the sign saying which way round.
 *
 * Deliberately cautious about blaming the clock. A run of zeroes with a small
 * delta is a real fault too, just not this one, and telling somebody whose
 * clock is fine to go and check their clock costs them an afternoon.
 */
function attributionHealth() {
  const rows = db.instance
    .prepare(
      `SELECT first_count AS firstCount, nearest_delta_ms AS deltaMs
         FROM relay_race
        WHERE first_count IS NOT NULL
        ORDER BY id DESC LIMIT ?`,
    )
    .all(ATTRIBUTION_SAMPLE);

  const healthy = { ok: true, blocks: rows.length, reason: null, skewMs: null };
  if (rows.length < ATTRIBUTION_SAMPLE) return healthy;
  if (rows.some((r) => r.firstCount > 0)) return healthy;

  // Nobody credited across the whole sample. Is the clock the explanation?
  const deltas = rows
    .map((r) => r.deltaMs)
    .filter((d) => typeof d === 'number')
    .sort((a, b) => a - b);
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;
  const clockIsTheCause = median !== null && Math.abs(median) > ATTRIBUTION_WINDOW_MS;

  return {
    ok: false,
    blocks: rows.length,
    reason: clockIsTheCause ? 'clock' : 'unknown',
    skewMs: clockIsTheCause ? median : null,
  };
}

module.exports = {
  latestBlock, attributionHealth, ATTRIBUTION_SAMPLE, ATTRIBUTION_WINDOW_MS,
};
