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
 */
function isFirstPeer(peer, detectedAtMs) {
  if (typeof peer.last_block !== 'number') return false;
  const lastBlockMs = peer.last_block * 1000;
  if (lastBlockMs <= 0) return false;
  return Math.abs(lastBlockMs - detectedAtMs) <= FIRST_WINDOW_MS && lastBlockMs <= detectedAtMs + 1000;
}

function recordRace({ blockHash, detectedAtMs, peers }) {
  const database = db.instance;

  const insertRace = database.prepare(
    `INSERT OR IGNORE INTO relay_race (block_hash, block_height, detected_at) VALUES (?, NULL, ?)`,
  );
  const insertObservation = database.prepare(
    `INSERT OR IGNORE INTO relay_observation (race_id, peer_id, eligible, first) VALUES (?, ?, 1, ?)`,
  );

  const tx = database.transaction(() => {
    const info = insertRace.run(blockHash, detectedAtMs);
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

async function handleHashBlock({ blockHash, detectedAtMs, t0 }) {
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
    processingMs: Number(elapsedMs.toFixed(2)),
  });

  backfillHeightAndPeerCounts(raceId, blockHash);
}

function main() {
  let subscription;
  processGuard.install(logger, { onShutdown: () => subscription && subscription.stop() });
  db.open();
  logger.info('starting', { zmq: config.bitcoin.zmqHashBlockUrl });

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
  }));
}

if (require.main === module) main();

module.exports = { recordRace, handleHashBlock, main, isFirstPeer, FIRST_WINDOW_MS };
