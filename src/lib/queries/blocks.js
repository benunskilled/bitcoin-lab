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
              pool_name AS poolName, pool_tag AS poolTag, pool_source AS poolSource,
              template_ms AS templateMs, template_tx AS templateTx, first_ping_ms AS firstPingMs
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
                  pool_name AS poolName, pool_tag AS poolTag, pool_source AS poolSource,
              template_ms AS templateMs, template_tx AS templateTx, first_ping_ms AS firstPingMs
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

/**
 * How many blocks could not be credited to one peer.
 *
 * Core credits each block to exactly one connection (last_block, set only
 * when the block was new to it), but in whole seconds. When another block
 * arrives moments apart - on the node this was written for, each time the
 * previous block 1-2 s earlier - two peers match and nothing here can tell
 * which last_block belongs to which block.
 * Since this version neither is credited (relay-profiler.js); the block is
 * kept and counted here. Blocks recorded before first_count existed have no
 * count, so for those the doubled First rows are what says so.
 *
 * A property of the node rather than of the app: close to never on one that
 * runs steadily (3 of 4,994 blocks on the node this was written for, each
 * with another block 1-2 s away).
 *
 * Lifetime rather than a recent window, and null before the first block - a
 * fresh install should not show "0 in 0". Cached against the newest block,
 * because it is asked on every /api/status poll and only a block changes it.
 */
let unclearCache = { raceId: null, value: null };

function unclearFirsts() {
  const newest = db.instance.prepare(`SELECT MAX(id) AS id FROM relay_race`).get().id;
  if (newest == null) return null;
  if (unclearCache.raceId === newest) return unclearCache.value;

  const races = db.instance.prepare(`SELECT COUNT(*) AS n FROM relay_race`).get().n;
  const unclear = db.instance
    .prepare(
      `SELECT COUNT(*) AS n FROM relay_race r
        WHERE r.first_count > 1
           OR (r.first_count IS NULL
               AND (SELECT COUNT(*) FROM relay_observation o WHERE o.race_id = r.id AND o.first = 1) > 1)`,
    )
    .get().n;
  const value = { races, unclear };
  unclearCache = { raceId: newest, value };
  return value;
}

/**
 * The route of the typical block: the median of every stop over the last
 * `limit` blocks, each counted from its own race's first job, the way Peer
 * Map draws a single block. One block's route scatters - a slow peer, a busy
 * Core, a pool that happened to be first - and the median is what shows
 * whether a change made anything shorter.
 *
 * Each stop takes its median over the blocks that have it, and says how many
 * that was: a block from before template timing existed still has a Core stop
 * and a pool stop, just no template one.
 *
 * Cheap enough to compute on request - a hundred indexed lookups - and cached
 * against the newest block, so it is worked out once per block at most.
 */
const ROUTE_MEDIAN_BLOCKS = 100;
let routeCache = { key: null, value: null };

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function routeMedian(limit = ROUTE_MEDIAN_BLOCKS) {
  // The newest block is written in steps - template time and the stratum race
  // land after the block itself - so the key follows those too, or the
  // newest block stayed out of the median until the next one came.
  const head = db.instance
    .prepare(`SELECT id, template_ms IS NOT NULL AS t, first_ping_ms IS NOT NULL AS p,
                     (SELECT MAX(rowid) FROM stratum_observation) AS obs
                FROM relay_race ORDER BY id DESC LIMIT 1`)
    .get();
  if (!head) return null;
  const key = `${head.id}:${head.t}:${head.p}:${head.obs}:${limit}`;
  if (routeCache.key === key) return routeCache.value;

  const races = db.instance
    .prepare(
      `SELECT block_hash AS blockHash, detected_at AS detectedAt,
              template_ms AS templateMs, template_tx AS templateTx, first_ping_ms AS firstPingMs
         FROM relay_race ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);

  const core = [], peer = [], template = [], own = [], tx = [];
  let ownLabel = null;
  for (const r of races) {
    const race = stratumForBlock(r.blockHash);
    if (!race || !race.createdAt) continue;
    const c = r.detectedAt - race.createdAt;
    core.push(c);
    if (r.firstPingMs != null) peer.push(c - r.firstPingMs);
    if (r.templateMs != null) template.push(c + r.templateMs);
    if (r.templateTx != null) tx.push(r.templateTx);
    const mine = race.entries.find((e) => e.own && e.latencyMs != null);
    if (mine) {
      own.push(mine.latencyMs);
      ownLabel = ownLabel || mine.label;
    }
  }
  const stop = (xs) => (xs.length ? { ms: median(xs), n: xs.length } : null);
  const value = core.length
    ? { blocks: core.length, core: stop(core), peer: stop(peer), template: stop(template), own: stop(own), tx: stop(tx), ownLabel }
    : null;
  routeCache = { key, value };
  return value;
}

/**
 * The connected peers that have ever been credited with delivering a block
 * first.
 *
 * For Peer Map, which tints those rows: the question it answers is "is this
 * one of the connections that has actually brought me a block", not how
 * strong it is, so it is a list and not a ranking. An address, not a host:
 * an inbound peer comes back on a new source port and is a new row here,
 * which is exactly how Peer Map sees it too.
 *
 * Connected now, not ever. Peer Map only tints the peers it is showing, so a
 * deliverer that has gone has no row there - and the list of everyone who
 * ever delivered only grows, by a few new inbound ports a day, while Peer Map
 * reads at most 64 KB of this reply. Unbounded, it would one day have cost
 * Peer Map the whole block card. This way it is bounded by the node's own
 * connection count.
 *
 * Not cached: the answer changes with every connection, not only with every
 * block, and the open-session index makes it a small read.
 */
function deliveredEver() {
  return db.instance
    .prepare(
      `SELECT p.address AS address FROM peer_relay_stats s JOIN peer p ON p.id = s.peer_id
        WHERE s.first > 0
          AND EXISTS (SELECT 1 FROM peer_session ps WHERE ps.peer_id = p.id AND ps.ended_at IS NULL)
        ORDER BY p.address`,
    )
    .all()
    .map((r) => r.address);
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
  latestBlock, blockDetail, stratumForBlock, routeMedian, ROUTE_MEDIAN_BLOCKS, deliveredEver, unclearFirsts, attributionHealth,
  ATTRIBUTION_SAMPLE, ATTRIBUTION_WINDOW_MS,
};
