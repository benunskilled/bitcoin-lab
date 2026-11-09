'use strict';

/**
 * A manual peer that went dark gives its slot back.
 *
 * Retiring used to park the peer, to be knocked on again and let back in. The
 * slot fill takes its candidates from Core's address book instead, which holds
 * thousands, the retired peer among them while Core still knows it - so
 * retiring is simply removing.
 */

const config = require('../config');
const db = require('../db');
const rpc = require('../rpc');
const peerSync = require('../peer-sync');
const { addressKey } = require('../address');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const { offlineForMs, offlineGraceMs, fmtHours } = require('./rules');

const keyOf = (address) => addressKey(address, config.bitcoin.network);

// Asked again right before the remove: the pass's getpeerinfo is seconds old,
// and the remove would cut a manual connection Core has made since. A padlock
// put on meanwhile counts as well. If Core does not answer, nothing goes.
async function stillToRetire(peer) {
  let peers;
  try {
    peers = await rpc.getPeerInfo();
  } catch {
    return false;
  }
  if (peers.some((p) => p.connection_type === 'manual' && keyOf(p.addr) === keyOf(peer.address))) return false;
  const row = db.instance.prepare('SELECT kept FROM trusted_peer WHERE address = ?').get(peer.address);
  return Boolean(row) && !(row.kept && peer.everManual);
}

/**
 * Reclaim the slot of a manual peer that has been offline longer than its
 * record has earned it.
 *
 * Without this, eight manual peers that all went dark held the entire list
 * hostage: Core kept redialling addresses that were not answering, and no
 * working peer could take their place.
 *
 * There is no "don't retire too many at once" guard: the pass does not run
 * while Core does not answer (index.js), which is the case that would make
 * every peer look offline at once.
 *
 * `onTrial` is the slot fill's candidate, which its trial judges, not this.
 * `peers` is getpeerinfo from this pass: the ranking is the database's
 * picture, a few seconds old, and Core may have reconnected the peer since -
 * removing it then would cut a connection that works again.
 */
async function retireOfflineManualPeers(ranking, onTrial = null, peers = []) {
  const connectedNow = new Set(peers.filter((p) => p.connection_type === 'manual').map((p) => keyOf(p.addr)));
  const now = Date.now();
  let retired = 0;
  // The padlock also covers being offline. Holding the slot costs nothing that
  // matters: Core keeps trying to reach an addnode address by itself, which is
  // exactly what was wanted. Take the padlock off and the peer is treated like
  // any other from the next pass on - no fresh grace period, no exception.
  //
  // But only for a peer Core has actually managed to hold as a manual
  // connection at least once. An address that never stood up is not a peer
  // you are keeping, it is an address that does not work. Without this, one
  // such address would sit on one of eight slots forever, protected.
  for (const peer of ranking.filter((p) => p.trusted && !p.live && !(p.kept && p.everManual) && p.address !== onTrial)) {
    if (connectedNow.has(keyOf(peer.address))) continue;
    const offlineMs = offlineForMs(peer, now);
    if (offlineMs == null) continue;
    const grace = offlineGraceMs(peer.firstPct);
    if (offlineMs < grace) continue;
    if (!(await stillToRetire(peer))) continue;

    await peerSync.removeTrustedPeer(peer.address);
    retired += 1;
    logAction({
      action: 'retire',
      address: peer.address,
      firstPct: peer.firstPct,
      eligible: peer.eligible,
      note: `offline ${fmtHours(offlineMs)}, allowed ${fmtHours(grace)}`,
    });
    logger.info('slot fill: retired a manual peer that stayed offline past its grace period', {
      address: peer.address,
      firstPct: peer.firstPct,
      offlineHours: Math.round(offlineMs / 3600000),
      graceHours: Math.round(grace / 3600000),
    });
  }
  return retired;
}

module.exports = { retireOfflineManualPeers };
