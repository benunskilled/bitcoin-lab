'use strict';

const db = require('../db');
const poolId = require('../pool-id');
const prevhash = require('../prevhash');

// Latest relay race (newest block Bitcoin Core told us about via ZMQ) plus
// the peer(s) whose getpeerinfo.last_block matched the detection instant -
// i.e. whichever peer(s) actually delivered this block to us first. Used
// purely to drive the "new block" UI flash - never on the timing-critical
// write path itself (relay-profiler.js writes these rows independently).
function latestBlock() {
  const race = db.instance
    .prepare(
      `SELECT id, block_hash AS blockHash, block_height AS blockHeight, detected_at AS detectedAt,
              pool_name AS poolName, pool_tag AS poolTag, pool_source AS poolSource
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

  // Two different things, and the page has to be able to tell them apart:
  // `pool` is a pool we recognise, `poolTag` on its own is the text the miner
  // wrote about himself. A block with neither carries nothing at all.
  const pool = race.poolName ? poolId.shortName(race.poolName) : null;
  return { ...race, pool, firstPeers };
}

/**
 * Everything this app knows about one block, in the three roles that must not
 * be confused: who MINED it (the coinbase), who DELIVERED it here first (the
 * peers credited with First), and who turned it into fresh work first (the
 * Stratum race for the same block).
 *
 * Any of the three can be missing - an unlisted miner, a block nobody was
 * credited for, a race that was not recorded because Stratum Race was off -
 * and each is missing on its own. Nothing here fills a gap with a guess.
 */
function blockDetail(raceId = null) {
  const race = raceId == null
    ? latestBlock()
    : (() => {
      const row = db.instance
        .prepare(
          `SELECT id, block_hash AS blockHash, block_height AS blockHeight, detected_at AS detectedAt,
                  pool_name AS poolName, pool_tag AS poolTag, pool_source AS poolSource
           FROM relay_race WHERE id = ?`,
        )
        .get(raceId);
      if (!row) return null;
      const peers = db.instance
        .prepare(
          `SELECT p.address AS address, tp.label AS trustedLabel
             FROM relay_observation ro
             JOIN peer p ON p.id = ro.peer_id
             LEFT JOIN trusted_peer tp ON tp.address = p.address
            WHERE ro.race_id = ? AND ro.first = 1`,
        )
        .all(row.id);
      return { ...row, pool: row.poolName ? poolId.shortName(row.poolName) : null, firstPeers: peers };
    })();
  if (!race) return null;

  const eligible = db.instance
    .prepare(`SELECT COUNT(*) AS n FROM relay_observation WHERE race_id = ?`)
    .get(race.id).n;

  return { ...race, eligible, stratum: stratumForBlock(race.blockHash) };
}

/**
 * The Stratum race for one block, found through the encodings the same hash
 * can arrive in (see lib/prevhash.js). Returns null when no race was recorded
 * for it, which is the normal answer on a node with Stratum Race switched off.
 */
function stratumForBlock(blockHash) {
  const byPrevhash = db.instance.prepare(
    `SELECT id, created_at AS createdAt, prevhash FROM stratum_race WHERE prevhash = ?`,
  );
  let found = null;
  for (const candidate of prevhash.encodings(blockHash)) {
    const hit = byPrevhash.get(candidate);
    if (hit) { found = hit; break; }
  }
  if (!found) return null;

  const entries = db.instance
    .prepare(
      `SELECT sp.label AS label, sp.host AS host, sp.port AS port,
              sp.is_default AS isDefault,
              so.latency_ms AS latencyMs, so.rank AS rank
         FROM stratum_observation so
         JOIN stratum_pool sp ON sp.id = so.pool_id
        WHERE so.race_id = ?
        ORDER BY so.rank IS NULL, so.rank ASC, sp.label ASC`,
    )
    .all(found.id)
    .map((e) => ({
      label: e.label,
      host: e.host,
      port: e.port,
      // A pool the owner added himself rather than one of the public ones
      // this app ships with - the answer to "and how did mine do".
      own: !e.isDefault,
      latencyMs: e.latencyMs,
      rank: e.rank,
      // No job inside the race window. Kept as a row rather than dropped: a
      // pool that said nothing is a result too.
      miss: e.latencyMs === null,
    }));

  return { raceId: found.id, createdAt: found.createdAt, prevhash: found.prevhash, entries };
}

// How many blocks in a row with nobody credited before this says anything.
//
// Across 2,206 blocks recorded on a live node, the number where no peer was
// credited is zero. Not rare: none, and the longest run is zero. With nothing
// observed in that many tries the true rate sits under about 0.14% (the rule
// of three), which puts a run of three at odds of one in several thousand
// years per node.
//
// Two would also survive that arithmetic - one false alarm per ten years - and
// is still the wrong number, because the arithmetic assumes misses are
// independent and they are probably not. A slow getpeerinfo, an NTP step, a
// hiccup in Core: those hit adjacent blocks, which is exactly the case two
// cannot absorb and three can. A warning that cries wolf once gets dismissed
// forever after, and this one has to be believed the day it matters.
//
// Going the other way buys nothing either. This is not a condition that
// repairs itself, so learning about a wrong clock half an hour sooner changes
// nothing - it just has to arrive the same afternoon rather than the next
// week. Three blocks is about half an hour; twenty, where this started, was
// three and a half hours of a broken install looking perfectly fine.
//
// It doubles as the minimum sample: fewer than three recorded blocks is a
// fresh install, which has nothing to diagnose.
const ATTRIBUTION_SAMPLE = 3;

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
  latestBlock, blockDetail, stratumForBlock, attributionHealth, ATTRIBUTION_SAMPLE, ATTRIBUTION_WINDOW_MS,
};
