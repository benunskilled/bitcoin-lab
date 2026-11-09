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
 * Switched off, nothing is left half done: a candidate on trial is kept if
 * Core already holds a working connection to it, and otherwise taken out
 * again, with the peer it replaced brought back.
 */
async function settleOnSwitchOff() {
  if (!fill.currentTrial()) return;
  try {
    const [peers, chain] = await Promise.all([rpc.getPeerInfo(), rpc.getBlockchainInfo()]);
    await fill.settle(peers, chain, Date.now(), { force: true });
  } catch (err) {
    // Core not answering: the next time the slot fill runs, it settles then.
    logger.warn('slot fill: could not settle the trial on switching off', { error: err.message });
  }
}

/**
 * One pass - a complete no-op unless the toggle is on.
 *
 *   settle  keeps the candidate on trial if Core holds a working connection
 *           to it, or undoes the move once the trial is over.
 *   retire  frees the slot of a manual peer that has not been there for
 *           longer than its record buys it, and parks it - never the
 *           candidate still on trial, which is the trial's to judge.
 *   start   puts the next candidate on trial if a slot is free or a region
 *           is missing, and nothing is on trial.
 *
 * Settling comes first: a trial that outlived a pause (Core down, the app
 * stopped) would otherwise have its candidate retired as offline, and the
 * peer it replaced would never come back.
 *
 * All read the same getpeerinfo, taken first: whether a candidate works and
 * whether a holder is one of Core's high-bandwidth peers are Core's answers
 * of this minute, not of the last snapshot.
 */
async function tick() {
  const idle = { enabled: false, retired: 0, started: 0, confirmed: 0, reverted: 0, deduped: 0 };
  if (!isEnabled()) return idle;
  let peers;
  let chain;
  try {
    [peers, chain] = await Promise.all([rpc.getPeerInfo(), rpc.getBlockchainInfo()]);
  } catch (err) {
    logger.debug('slot fill: Core not answering, skipping this pass', { error: err.message });
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
  const settled = await fill.settle(peers, chain);
  forgetExpiredParked();
  const onTrial = fill.currentTrial();
  const ranking = queries.peerRanking();
  const retired = await retireOfflineManualPeers(ranking, onTrial && onTrial.address);
  // One move per pass: nothing new while a candidate is on trial, nor in the
  // pass that just brought a replaced peer back.
  const started = onTrial || settled === 'reverted'
    ? 0
    : await fill.start(retired > 0 ? queries.peerRanking() : ranking, peers, chain);
  return {
    enabled: true, retired, deduped, started, confirmed: settled === 'confirmed' ? 1 : 0, reverted: settled === 'reverted' ? 1 : 0,
  };
}

module.exports = {
  isEnabled,
  setEnabled,
  settleOnSwitchOff,
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
