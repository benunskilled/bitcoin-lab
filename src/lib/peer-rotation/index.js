'use strict';

/**
 * Manual slot fill: one pass every ten minutes, and the toggle that decides
 * whether any of it runs at all. (The directory keeps its old name,
 * peer-rotation, so every existing require keeps resolving; in the app it is
 * no longer a rotation. It fills free manual slots and spreads them, and
 * never moves a working peer out.)
 *
 * What lives where:
 *
 *   rules.js     who may lose a slot when a person adds a peer to a full
 *                set, and how long an offline peer keeps one. No database,
 *                no RPC.
 *   spread.js    where the manual peers are, and which region a free slot
 *                should go to.
 *   addrbook.js  candidates from Core's address book, the networks they may
 *                come from, and Core's bans.
 *   fill.js      the trial: a candidate goes into a free slot, and Core
 *                connects to it or it goes again.
 *   retire.js    frees the slot of a manual peer that went dark.
 *   log.js       the audit trail: rotation_log and promoted_peer.
 */

const config = require('../config');
const db = require('../db');
const rpc = require('../rpc');
const queries = require('../queries');
const logger = require('../logger').make('peer-rotation');
const { logAction, recentLog } = require('./log');
const { retireOfflineManualPeers } = require('./retire');
const fill = require('./fill');
const { offlineGraceMs } = require('./rules');

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
 * again.
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
 *           to it, or takes it out once the trial is over.
 *   retire  frees the slot of a manual peer that has not been there for
 *           longer than its record buys it - never the candidate still on
 *           trial, which is the trial's to judge.
 *   start   puts the next candidate into a free slot, if nothing is on trial.
 *
 * All read the same getpeerinfo, taken first. If Core does not answer,
 * nothing happens: every peer would look offline.
 */
async function tick() {
  const idle = { enabled: false, retired: 0, started: 0, confirmed: 0, reverted: 0 };
  if (!isEnabled()) return idle;
  let peers;
  let chain;
  try {
    [peers, chain] = await Promise.all([rpc.getPeerInfo(), rpc.getBlockchainInfo()]);
  } catch (err) {
    logger.debug('slot fill: Core not answering, skipping this pass', { error: err.message });
    return { ...idle, enabled: true };
  }
  const settled = await fill.settle(peers, chain);
  const onTrial = fill.currentTrial();
  const ranking = queries.peerRanking();
  const retired = await retireOfflineManualPeers(ranking, onTrial && onTrial.address);
  // One move per pass: nothing new while a candidate is on trial, nor in the
  // pass that just took one out.
  let started = onTrial || settled === 'reverted'
    ? 0
    : await fill.start(retired > 0 ? queries.peerRanking() : ranking, peers, chain);
  // Switched off while this pass was adding: the switch-off could not see the
  // row yet, so the candidate is taken out here, rather than left in a slot
  // no later pass would look at.
  if (started && !isEnabled()) {
    await fill.abandon(started);
    started = 0;
  }
  return {
    enabled: true, retired, started: started ? 1 : 0, confirmed: settled === 'confirmed' ? 1 : 0, reverted: settled === 'reverted' ? 1 : 0,
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
  tick,
};
