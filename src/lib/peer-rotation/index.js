'use strict';

/**
 * The automatic peer rotation: one tick, three passes, and the toggle that
 * decides whether any of it runs at all.
 *
 * What lives where:
 *
 *   rules.js    every decision, as arithmetic - who may be displaced, whether
 *               a challenger is enough better, how long a peer's record buys
 *               it before its slot is reclaimed. No database, no RPC.
 *   log.js      the audit trail: rotation_log (a window, trimmed on write)
 *               and promoted_peer (permanent).
 *   spread.js   where the manual peers are, and whether a peer improves that.
 *   parking.js  passes 1 and 2 - retire a manual peer that went dark, and let
 *               it back in when it answers again. Owns the parked_peer table.
 *   promote.js  pass 3 - give a free slot, or a surplus one, to the live
 *               candidate that does the most for the spread.
 *
 * This file is a directory rather than a single module so that every existing
 * `require('./lib/peer-rotation')` keeps resolving unchanged - the split is
 * invisible from the outside, and the public surface below is exactly the one
 * the dashboard, the profiler and the tests already use.
 */

const config = require('../config');
const db = require('../db');
const rpc = require('../rpc');
const queries = require('../queries');
const peerSync = require('../peer-sync');
const logger = require('../logger').make('peer-rotation');
const { logAction, recentLog } = require('./log');
const { retireOfflineManualPeers, reviveParkedPeers, parkedPeers } = require('./parking');
const { promoteBestCandidate } = require('./promote');
const { fillFromAddressBook, trialInRegion } = require('./addrbook');
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
  logger.info('peer rotation toggled', { enabled: Boolean(enabled) });
}

/**
 * One rotation cycle - a complete no-op unless the toggle is on.
 *
 * The order is deliberate and is where the three passes stop being independent.
 * (A fourth, kick, dropped outbound peers that never delivered first so Core
 * would dial fresh ones. It went with the spread: a peer far away seldom is
 * first, and Core picks and spreads its own outbound peers anyway.)
 *
 *   retire  frees a MANUAL slot held by a peer that is not there any more.
 *   revive  offers that slot first to a parked peer that answers again, if
 *           it fits the spread.
 *   promote fills what is still free, or spreads a full set, with a live
 *           candidate - skipped
 *           entirely if a revival already used this tick's one move, so the
 *           manual set never gains two peers in the same pass.
 *
 * The first three passes read one shared peerRanking() snapshot; `retire`
 * hands its own result forward by removing rows, so `revive` re-derives the
 * manual set from what it was given rather than re-querying, and `promote`
 * gets a snapshot that predates both. That is safe because each pass only
 * ever moves the count of manual peers in the direction the next one can
 * absorb: retire only removes, revive and promote each add at most one, and
 * addTrustedPeer re-checks the real count against the cap before writing
 * anything - so a stale snapshot can cost a tick, never a broken invariant.
 */
async function tick() {
  if (!isEnabled()) return { enabled: false, retired: 0, revived: 0, promoted: 0, trialled: 0, deduped: 0 };
  // Before anything else: a host held as a manual peer that is ALSO connected
  // inbound. The other node dialled in and will dial in again, so clearing
  // this once when the peer was added does not hold. Left alone, the pair
  // splits that peer's record over two rows and only the connection that
  // carried a block is credited with it - so the manual slot reads as
  // worthless while its twin does the work, and the loop would eventually
  // draw exactly the wrong conclusion from that.
  let deduped = 0;
  try {
    deduped = await peerSync.dropDuplicateInboundSessions(await rpc.getPeerInfo());
  } catch (err) {
    logger.debug('could not check for duplicate inbound sessions', { error: err.message });
  }
  const ranking = queries.peerRanking();
  const retired = await retireOfflineManualPeers(ranking);
  const stillTrusted = retired > 0 ? queries.peerRanking() : ranking;
  const revived = await reviveParkedPeers(stillTrusted);
  // One peer joins the manual set per tick, at most. A revival already used it.
  let promoted = revived > 0 ? 0 : await promoteBestCandidate(stillTrusted);
  // Gaps the live peers cannot fill come from Core's address book, and a
  // region whose peer delivers nothing gets its daily trial - each only when
  // nothing else moved this tick.
  if (!revived && !promoted) promoted = await fillFromAddressBook(stillTrusted);
  const trialled = revived || promoted ? 0 : await trialInRegion(stillTrusted);
  return { enabled: true, retired, revived, promoted, trialled, deduped };
}

module.exports = {
  isEnabled,
  setEnabled,
  logAction,
  recentLog,
  promoteBestCandidate,
  retireOfflineManualPeers,
  reviveParkedPeers,
  offlineGraceMs,
  probeIntervalCapMs,
  parkedRetentionMs,
  parkedPeers,
  tick,
};
