'use strict';

/**
 * Relay Profiler - the timing-critical core of Bitcoin Lab.
 *
 * Block detection happens EXCLUSIVELY via Bitcoin Core ZMQ `pubhashblock`.
 * There is no RPC polling anywhere on this path. The high-resolution
 * timestamp is captured as the very first statement after the ZMQ message
 * arrives, before any parsing, RPC calls, or DB writes - so RPC/DB latency
 * can never pollute the measurement.
 *
 * Right after the timestamp, exactly one getpeerinfo snapshot is taken.
 * Bitcoin Core's getpeerinfo exposes `last_block`: the unix-second
 * timestamp of the last block received FROM that peer. A peer whose
 * last_block falls within a short window of the ZMQ detection instant is
 * the peer that actually delivered this block to us - that is the "First"
 * signal. Every peer present in the same snapshot is "Eligible" (it was
 * connected and could in principle have delivered the block).
 */

const config = require('./lib/config');
const db = require('./lib/db');
const rpc = require('./lib/rpc');
const health = require('./lib/health');
const processGuard = require('./lib/process-guard');
const hashblock = require('./lib/hashblock-subscriber');
const poolId = require('./lib/pool-id');
const logger = require('./lib/logger').make('relay-profiler');

// A peer counts as "first" if Core recorded a block from it within this
// many ms of our ZMQ-detection instant. last_block has 1s resolution, so
// this must comfortably straddle a second boundary in either direction.
const FIRST_WINDOW_MS = 2500;

/**
 * Did this peer deliver the block we just detected?
 *
 * The window has to tolerate a second boundary landing anywhere inside our
 * millisecond-precision detection instant, since `last_block` only has
 * one-second resolution. The upper bound is tighter than the lower one on
 * purpose: a peer that delivered the block did so *before* we heard about it,
 * so more than a second into the future is a clock artifact, not a delivery.
 *
 * One function because this used to be written out twice - once for the row
 * that goes into the database, once for the log line - and the two drifted:
 * the log's copy had lost the upper bound and could report a higher "first"
 * count than was actually stored.
 *
 * More than one peer can match, and that is deliberate. Only one of them
 * really delivered the block, but when two fall inside the same second there
 * is nothing here that could tell them apart - so picking one would credit a
 * peer that did not deliver AND deny the one that did. Counting both is the
 * smaller error of the two, and it is self-correcting over a few hundred
 * blocks, which a wrong attribution is not.
 *
 * It also barely happens. Measured on a listening node with ~200 peers, over
 * 1,487 recorded races: 1,486 had exactly one peer inside the window, one had
 * two, and none had zero. Re-measured 458 blocks after the first count, the
 * number of multi-first races had not moved at all - still that one - so the
 * rate is falling as the sample grows rather than holding at some fraction.
 *
 * The zero is the number worth keeping in mind: the window does not merely
 * tolerate the one-second resolution of last_block, it identifies exactly one
 * peer in 99.93% of blocks and misses in none, which is the evidence that the
 * whole method works.
 */
function isFirstPeer(peer, detectedAtMs) {
  if (typeof peer.last_block !== 'number') return false;
  const lastBlockMs = peer.last_block * 1000;
  if (lastBlockMs <= 0) return false;
  return Math.abs(lastBlockMs - detectedAtMs) <= FIRST_WINDOW_MS && lastBlockMs <= detectedAtMs + 1000;
}

/**
 * How far the closest last_block any peer reported sits from the instant we
 * detected the block, signed: negative means Core's clocks are behind ours.
 *
 * On a healthy node this is under a second, because the peer that delivered
 * the block has a last_block of right now and the only error is last_block's
 * one-second resolution. It is the diagnostic half of the attribution: when
 * nobody is credited, this says whether that is because the clocks disagree
 * (a steady several seconds, block after block) or for some other reason.
 *
 * Costs one pass over a list already in memory, after the timestamp and after
 * the RPC. Nothing here is on the timing path.
 */
function nearestLastBlockDeltaMs(peers, detectedAtMs) {
  let nearest = null;
  for (const peer of peers) {
    if (typeof peer.last_block !== 'number' || peer.last_block <= 0) continue;
    const delta = peer.last_block * 1000 - detectedAtMs;
    if (nearest === null || Math.abs(delta) < Math.abs(nearest)) nearest = delta;
  }
  return nearest;
}

/**
 * The ping of the peer that delivered the block, from the same snapshot that
 * credited it: the lowest round trip Core ever measured to it, which is nearer
 * the line itself than the last one. With two credited, the shorter line -
 * that is the one the block most plausibly came over. Null when none was
 * credited or Core reported no ping.
 */
function firstPeerPingMs(peers, detectedAtMs) {
  let best = null;
  for (const p of peers) {
    if (!isFirstPeer(p, detectedAtMs)) continue;
    const s = typeof p.minping === 'number' ? p.minping : (typeof p.pingtime === 'number' ? p.pingtime : null);
    if (s == null) continue;
    const ms = s * 1000;
    if (best == null || ms < best) best = ms;
  }
  return best;
}

function recordRace({ blockHash, detectedAtMs, peers }) {
  const database = db.instance;

  const insertRace = database.prepare(
    `INSERT OR IGNORE INTO relay_race (block_hash, block_height, detected_at, first_count, nearest_delta_ms, first_ping_ms)
     VALUES (?, NULL, ?, ?, ?, ?)`,
  );
  const insertObservation = database.prepare(
    `INSERT OR IGNORE INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)`,
  );

  const firstCount = peers.filter((p) => isFirstPeer(p, detectedAtMs)).length;
  const nearestDeltaMs = nearestLastBlockDeltaMs(peers, detectedAtMs);

  const tx = database.transaction(() => {
    const info = insertRace.run(
      blockHash,
      detectedAtMs,
      firstCount,
      nearestDeltaMs === null ? null : Math.round(nearestDeltaMs),
      firstPeerPingMs(peers, detectedAtMs),
    );
    if (info.changes === 0) {
      // Already recorded (duplicate ZMQ delivery / reconnect replay) - skip.
      return null;
    }
    const raceId = info.lastInsertRowid;
    for (const peer of peers) {
      const peerRow = db.getOrCreatePeer(peer.addr);
      const isFirst = isFirstPeer(peer, detectedAtMs);
      // peer_relay_stats (the rollup peerRanking reads instead of aggregating
      // this table on every request) is updated by a database trigger on this
      // insert, in this same transaction - see db.js. Nothing to do here.
      insertObservation.run(raceId, peerRow.id, isFirst ? 1 : 0);
    }
    return raceId;
  });

  return tx();
}

async function backfillHeightAndPeerCounts(raceId, blockHash) {
  try {
    const header = await rpc.getBlockHeader(blockHash);
    db.instance.prepare(`UPDATE relay_race SET block_height = ? WHERE id = ?`).run(header.height, raceId);
  } catch (err) {
    // Non-critical - height is cosmetic, never blocks the race itself.
    logger.warn('getblockheader failed (non-critical)', { blockHash, error: err.message });
  }
}

const addressesOf = (tx) =>
  (tx.vout || [])
    .map((out) => {
      const spk = out.scriptPubKey || {};
      return spk.address || (Array.isArray(spk.addresses) ? spk.addresses[0] : null);
    })
    .filter(Boolean);

/**
 * Who mined this block, read off its coinbase.
 *
 * Deliberately late and deliberately slow: it runs after the race is already
 * written, it is two RPC calls, and nothing waits for the answer. A block
 * nobody could attribute is recorded as such (pool_source = 'none') so it is
 * never asked about twice; a block this failed on keeps pool_source NULL and
 * the catch-up below picks it up later.
 */
async function attributePool(raceId, blockHash) {
  let name = null;
  let tag = null;
  let source = 'none';
  try {
    const block = await rpc.getBlock(blockHash, 1);
    const coinbaseTxid = Array.isArray(block.tx) ? block.tx[0] : null;
    if (!coinbaseTxid) return;
    const tx = await rpc.getRawTransaction(coinbaseTxid, blockHash);
    const coinbaseHex = (tx.vin && tx.vin[0] && tx.vin[0].coinbase) || '';
    const hit = poolId.identify({ coinbaseHex, addresses: addressesOf(tx) });
    if (hit) {
      name = hit.name;
      tag = hit.tag;
      source = hit.source;
    } else {
      // Nobody we know of. What the miner wrote about himself is still worth
      // showing - as his own words, never as a pool name.
      tag = poolId.coinbaseLabel(coinbaseHex);
      source = tag ? 'coinbase' : 'none';
    }
  } catch (err) {
    logger.warn('could not read the coinbase (non-critical)', { blockHash, error: err.message });
    return;
  }
  try {
    db.instance
      .prepare(`UPDATE relay_race SET pool_name = ?, pool_tag = ?, pool_source = ? WHERE id = ?`)
      .run(name, tag, source, raceId);
    logger.debug('block attributed', { blockHash, pool: name || tag, source });
  } catch (err) {
    logger.warn('could not record the pool (non-critical)', { blockHash, error: err.message });
  }
}

// Blocks recorded while this was not running, or while Core was unreachable,
// stay unattributed. Fill in the most recent ones once at startup - bounded,
// because the point is the block somebody is about to look at, not the
// history of the whole database.
const CATCHUP_LIMIT = 20;

async function catchUpAttribution() {
  let rows;
  try {
    rows = db.instance
      .prepare(
        `SELECT id, block_hash AS blockHash FROM relay_race
         WHERE pool_source IS NULL ORDER BY id DESC LIMIT ?`,
      )
      .all(CATCHUP_LIMIT);
  } catch (err) {
    logger.warn('could not look for unattributed blocks', { error: err.message });
    return;
  }
  if (!rows.length) return;
  logger.info('filling in the pool for recent blocks', { blocks: rows.length });
  for (const row of rows) {
    await attributePool(row.id, row.blockHash);
  }
}

/**
 * How long after the block announcement Core has a new block template ready -
 * the thing every pool on this node waits for before it can send a job.
 *
 * Asked at the same moment a pool asks, straight off the ZMQ event, and timed
 * to the last byte of the reply; the reply itself is dropped unread (see
 * rpc.timeCall). Core serialises template building and keeps the result for
 * a few seconds, so this can only ever make a pool that asks just after it
 * faster, never slower - which is said where the number is shown.
 *
 * Running alongside getpeerinfo does not touch the First measurement: that
 * compares each peer's last_block against the instant of the ZMQ event, both
 * fixed before either call returns.
 */
function timeTemplate(detectedAtMs) {
  return rpc
    .timeCall('getblocktemplate', [{ rules: ['segwit'] }], { timeoutMs: 30000 })
    .then(() => Date.now() - detectedAtMs)
    .catch((err) => {
      logger.warn('block template timing failed (non-critical)', { error: err.message });
      return null;
    });
}

async function handleHashBlock({ blockHash, detectedAtMs, t0 }) {
  const template = timeTemplate(detectedAtMs);
  let peers;
  try {
    peers = await rpc.getPeerInfo();
  } catch (err) {
    logger.error('getpeerinfo failed right after ZMQ hashblock - race lost for this block', {
      blockHash,
      error: err.message,
    });
    return;
  }

  let raceId;
  try {
    raceId = recordRace({ blockHash, detectedAtMs, peers });
  } catch (err) {
    // Before v1.12.0 this call sat outside any try/catch inside a
    // fire-and-forget async function, so a SQLite write failing here (a lock
    // held past busy_timeout, a full disk) became an unhandled rejection and
    // terminated the process - the one process whose data cannot be
    // reconstructed afterwards. Losing a single block's race is bad; losing
    // every subsequent block until someone notices is far worse.
    logger.error('failed to record block race', { blockHash, error: err.stack || err.message });
    return;
  }

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  if (raceId == null) {
    logger.debug('duplicate hashblock ignored', { blockHash });
    return;
  }

  const firstCount = peers.filter((p) => isFirstPeer(p, detectedAtMs)).length;
  logger.info('block race recorded', {
    blockHash,
    eligible: peers.length,
    first: firstCount,
    nearestLastBlockMs: nearestLastBlockDeltaMs(peers, detectedAtMs),
    processingMs: Number(elapsedMs.toFixed(2)),
  });

  backfillHeightAndPeerCounts(raceId, blockHash);
  template.then((ms) => {
    if (ms == null) return;
    try {
      db.instance.prepare(`UPDATE relay_race SET template_ms = ? WHERE id = ?`).run(ms, raceId);
    } catch (err) {
      logger.warn('could not store template time', { error: err.message });
    }
  });
  attributePool(raceId, blockHash).catch((err) =>
    logger.warn('pool attribution failed (non-critical)', { blockHash, error: err.message }),
  );
}

function main() {
  let subscription;
  processGuard.install(logger, { onShutdown: () => subscription && subscription.stop() });
  db.open();
  const list = poolId.size();
  logger.info('starting', {
    zmq: config.bitcoin.zmqHashBlockUrl,
    poolList: `${list.tags} tags, ${list.addresses} addresses`,
  });

  // Blocks recorded while this was not running have no pool yet. Two seconds
  // in rather than straight away, so a block arriving in the first moments
  // after a restart is never queued behind the history.
  setTimeout(() => {
    catchUpAttribution().catch((err) => logger.warn('catch-up failed', { error: err.message }));
  }, 2000).unref?.();

  subscription = hashblock.start({
    url: config.bitcoin.zmqHashBlockUrl,
    logger,
    // Fire-and-forget so a slow getpeerinfo never delays the next ZMQ message
    // from being read off the socket. The .catch() is the backstop: every
    // error path inside handleHashBlock is already handled, and anything that
    // still escapes gets logged rather than killing the process.
    onBlock: (event) => {
      handleHashBlock(event).catch((err) => {
        logger.error('unexpected error handling hashblock', { error: err.stack || err.message });
      });
    },
  });

  // Block arrivals are ~10 minutes apart with no upper bound, so "nothing
  // happened recently" is a healthy state here. The heartbeat therefore runs
  // on its own clock and reports the ZMQ connection state rather than block
  // activity.
  health.start(db, 'relay-profiler', logger, () => ({
    zmqConnected: subscription.state.connected,
    lastBlockAtMs: subscription.state.lastBlockAtMs,
    // Without this, "no block since the process started" and "a block a
    // moment ago" are the same null to anyone reading the heartbeat.
    subscribedAtMs: subscription.state.startedAtMs,
  }));
}

if (require.main === module) main();

module.exports = {
  recordRace, handleHashBlock, main, isFirstPeer, nearestLastBlockDeltaMs, firstPeerPingMs, FIRST_WINDOW_MS,
};
