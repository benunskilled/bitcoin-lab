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

const zmq = require('zeromq');
const config = require('./lib/config');
const db = require('./lib/db');
const rpc = require('./lib/rpc');
const logger = require('./lib/logger').make('relay-profiler');

// A peer counts as "first" if Core recorded a block from it within this
// many ms of our ZMQ-detection instant. last_block has 1s resolution, so
// this must comfortably straddle a second boundary in either direction.
const FIRST_WINDOW_MS = 2500;

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
      const lastBlockMs = typeof peer.last_block === 'number' ? peer.last_block * 1000 : 0;
      const isFirst = lastBlockMs > 0 && Math.abs(lastBlockMs - detectedAtMs) <= FIRST_WINDOW_MS && lastBlockMs <= detectedAtMs + 1000;
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

async function handleHashBlock(msg) {
  // Capture the timestamp FIRST, before any parsing or async work.
  const t0 = process.hrtime.bigint();
  const detectedAtMs = Date.now();

  // pubhashblock payload is the 32-byte block hash in internal (little-endian)
  // byte order; reverse for the conventional display/RPC hex string.
  const blockHash = Buffer.from(msg).reverse().toString('hex');

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

  const raceId = recordRace({ blockHash, detectedAtMs, peers });
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  if (raceId == null) {
    logger.debug('duplicate hashblock ignored', { blockHash });
    return;
  }

  const firstCount = peers.filter((p) => typeof p.last_block === 'number' && Math.abs(p.last_block * 1000 - detectedAtMs) <= FIRST_WINDOW_MS).length;
  logger.info('block race recorded', {
    blockHash,
    eligible: peers.length,
    first: firstCount,
    processingMs: Number(elapsedMs.toFixed(2)),
  });

  backfillHeightAndPeerCounts(raceId, blockHash);
}

async function main() {
  db.open();
  logger.info('starting', { zmq: config.bitcoin.zmqHashBlockUrl });

  for (;;) {
    const sock = new zmq.Subscriber();
    sock.connect(config.bitcoin.zmqHashBlockUrl);
    sock.subscribe('hashblock');
    logger.info('subscribed to hashblock', { url: config.bitcoin.zmqHashBlockUrl });

    try {
      // eslint-disable-next-line no-await-in-loop
      for await (const [, msg] of sock) {
        // Fire-and-forget so a slow getpeerinfo never delays the next
        // ZMQ message from being read off the socket, but errors are
        // caught inside handleHashBlock itself.
        handleHashBlock(msg);
      }
    } catch (err) {
      logger.error('zmq subscriber error, reconnecting in 5s', { error: err.message });
      sock.close();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

main().catch((err) => {
  logger.error('fatal', { error: err.stack || err.message });
  process.exit(1);
});
