'use strict';

/**
 * Manual slot fill: one pass every ten minutes, and the toggle that decides
 * whether any of it runs at all. (The directory keeps its old name,
 * peer-rotation, so every existing require keeps resolving; in the app it is
 * no longer a rotation. It fills the manual slots and spreads them, and once
 * they are spread it leaves them be.)
 *
 * What lives where:
 *
 *   rules.js     who may lose a slot at all, and how long an offline peer
 *                keeps one. No database, no RPC.
 *   spread.js    where the manual peers are, and whether a peer improves that.
 *   addrbook.js  candidates from Core's address book, the networks they may
 *                come from, and Core's bans.
 *   fill.js      the trial: a candidate goes in, Core connects to it or it
 *                goes again and the peer it replaced comes back.
 *   parking.js   retire a manual peer that went dark, and keep it as a
 *                candidate for later. Owns the parked_peer table.
 *   log.js       the audit trail: rotation_log and promoted_peer.
 */

const config = require('../config');
const db = require('../db');
const rpc = require('../rpc');
const queries = require('../queries');
const peerSync = require('../peer-sync');
const logger = require('../logger').make('peer-rotation');
const { logAction, recentLog } = require('./log');
const { retireOfflineManualPeers, forgetExpiredParked, parkedPeers } = require('./parking');
const fill = require('./fill');
const { offlineGraceMs, probeIntervalCapMs, parkedRetentionMs } = require('./rules');

const META_KEY = 'peer_rotation_enabled';

function isEnabled() {
  if (config.readOnly) return false;
  const row = db.instance.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY);
  return row ? row.value === '1' : false;
}

function setEnabled(enabled) {
  db.instance
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(META_KEY, enabled ? '1' : '0');
  logger.info('manual slot fill toggled', { enabled: Boolean(enabled) });
}

/**
 * One pass - a complete no-op unless the toggle is on.
 *
 *   retire  frees the slot of a manual peer that has not been there for
 *           longer than its record buys it, and parks it.
 *   fill    settles the candidate on trial, and puts the next one on trial
 *           if a slot is free or a region is missing.
 *
 * Both read the same getpeerinfo, taken first: whether a candidate works and
 * whether a holder is one of Core's high-bandwidth peers are Core's answers
 * of this minute, not of the last snapshot.
 */
async function tick() {
  const idle = { enabled: false, retired: 0, started: 0, confirmed: 0, reverted: 0, deduped: 0 };
  if (!isEnabled()) return idle;
  let peers;
  try {
    peers = await rpc.getPeerInfo();
  } catch (err) {
    logger.debug('slot fill: getpeerinfo failed, skipping this pass', { error: err.message });
    return { ...idle, enabled: true };
  }
  // A host held as a manual peer that is ALSO connected inbound. The other
  // node dialled in and will dial in again, so clearing this once when the
  // peer was added does not hold. Left alone, the pair splits that peer's
  // record over two rows and only the connection that carried a block is
  // credited with it.
  let deduped = 0;
  try {
    deduped = await peerSync.dropDuplicateInboundSessions(peers);
  } catch (err) {
    logger.debug('could not check for duplicate inbound sessions', { error: err.message });
  }
  forgetExpiredParked();
  const ranking = queries.peerRanking();
  const retired = await retireOfflineManualPeers(ranking);
  const result = await fill.step(retired > 0 ? queries.peerRanking() : ranking, peers);
  return { enabled: true, retired, deduped, ...result };
}

module.exports = {
  isEnabled,
  setEnabled,
  logAction,
  recentLog,
  retireOfflineManualPeers,
  currentTrial: fill.currentTrial,
  offlineGraceMs,
  probeIntervalCapMs,
  parkedRetentionMs,
  parkedPeers,
  tick,
};
