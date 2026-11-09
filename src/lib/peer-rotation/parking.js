'use strict';

/**
 * A manual peer that went dark, and the way back in.
 *
 * Retiring a peer *parks* it, and the parked peers are the first candidates
 * the slot fill offers Core when a slot is wanted in their region (fill.js).
 * That is what lets the grace period be measured in hours instead of never:
 * losing a slot is reversible.
 *
 * Nothing here dials a parked peer. It used to be knocked on from this
 * container every so often, which showed this node's address to it in a
 * handshake no Bitcoin node sends; now Core is asked to connect to it, the
 * same way as to any other candidate, and the backoff below decides how
 * often.
 *
 * This file also owns the `parked_peer` table. Nothing else reads or writes
 * it except peer-sync's parkPeer (which puts rows in) and addTrustedPeer
 * (which clears a row when a peer comes back).
 */

const db = require('../db');
const config = require('../config');
const peerSync = require('../peer-sync');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const { unreachableNetwork } = require('../address');
const {
  offlineForMs,
  offlineGraceMs,
  probeIntervalCapMs,
  parkedRetentionMs,
  fmtHours,
} = require('./rules');

/**
 * Reclaim the slot of a manual peer that has been offline longer than
 * its record has earned it, and park the address so it can come back.
 *
 * This is the pass that makes the manual list self-maintaining in the
 * direction it could never previously go. Before it, a manual peer only ever
 * lost its slot by being beaten by a live candidate, so eight peers that all
 * went dark held the entire list hostage - Core kept redialling addresses that
 * were not answering, and every genuinely good peer that turned up in the
 * meantime was rejected for want of a slot.
 *
 * Retiring is not deleting. Every peer retired here goes into parked_peer and
 * is offered to Core again when its region wants one, which is what lets the
 * grace period be measured in hours instead of never: the cost of being too
 * quick is a peer that comes back, not a peer lost.
 *
 * That is also why there is no "don't retire too many at once" guard. The
 * pathological case - Bitcoin Core itself down for longer than the shortest
 * grace period, so every manual peer looks offline at once - resolves itself:
 * all eight are parked, the slot fill offers them to Core again one by one,
 * and the ones still out there come back. A guard would only turn a
 * self-healing situation into a stuck one.
 */
async function retireOfflineManualPeers(ranking) {
  const now = Date.now();
  let retired = 0;
  // The star also covers being offline, which is the other way a manual peer
  // loses its slot. Holding it costs nothing that matters: Core keeps trying
  // to reach an addnode address by itself, which is exactly what was wanted.
  // Take the star off and the peer is treated like any other from the next
  // pass on - no fresh grace period, no exception.
  //
  // But only for a peer Core has actually managed to hold as a manual
  // connection at least once. An address that never stood up is not a peer
  // you are keeping, it is an address that does not work: a node that dialled
  // in, answered the port probe, and then could not sustain a connection the
  // other way round - which is the common case, not a rare one. Without this,
  // one such address would sit on one of eight slots forever, protected.
  for (const peer of ranking.filter((p) => p.trusted && !p.live && !(p.kept && p.everManual))) {
    const offlineMs = offlineForMs(peer, now);
    if (offlineMs == null) continue;
    const grace = offlineGraceMs(peer.firstPct);
    if (offlineMs < grace) continue;

    await peerSync.removeTrustedPeer(peer.address);
    // parkPeer refuses a Tor or I2P peer (see there); the address book has
    // more where it came from.
    const parked = peerSync.parkPeer(peer);
    retired += 1;
    logAction({
      action: 'park',
      address: peer.address,
      firstPct: peer.firstPct,
      eligible: peer.eligible,
      note: parked
        ? `offline ${fmtHours(offlineMs)}, allowed ${fmtHours(grace)}; parked to re-test`
        : `offline ${fmtHours(offlineMs)}, allowed ${fmtHours(grace)}; nothing to park`,
    });
    logger.info('rotation: retired a manual peer that stayed offline past its grace period', {
      address: peer.address,
      firstPct: peer.firstPct,
      offlineHours: Math.round(offlineMs / 3600000),
      graceHours: Math.round(grace / 3600000),
      parked,
    });
  }
  return retired;
}

/**
 * Forget the parked peers whose own retention is up - scaled the same way
 * everything else about a peer is, by what it actually did. In SQL so it
 * stays one pass over the table rather than a read-then-delete.
 */
function forgetExpiredParked(now = Date.now()) {
  db.instance
    .prepare(
      `DELETE FROM parked_peer
       WHERE parked_at < @now - 86400000 * MIN(@maxDays, MAX(@minDays, COALESCE(first_pct, 0) * @daysPerPct))`,
    )
    .run({
      now,
      minDays: config.parkedPeerMinRetentionDays,
      maxDays: config.parkedPeerMaxRetentionDays,
      daysPerPct: config.parkedPeerRetentionDaysPerPct,
    });
  // Parked before Tor and I2P peers stopped being parked: let them go.
  for (const r of db.instance.prepare('SELECT address FROM parked_peer').all()) {
    if (unreachableNetwork(r.address)) db.instance.prepare('DELETE FROM parked_peer WHERE address = ?').run(r.address);
  }
}

/**
 * Parked peers it is time to offer Core again, oldest-offered first.
 *
 * The interval backs off as offers fail, capped - a permanently dead address
 * must not cost the same as one that dropped out for lunch - and the cap
 * depends on how much this peer is worth waiting for (probeIntervalCapMs).
 */
function dueParkedPeers(now = Date.now()) {
  forgetExpiredParked(now);
  const minInterval = config.parkedPeerMinProbeIntervalMinutes * 60 * 1000;
  const isDue = (parked) => parked.lastProbeAt == null
    || now - parked.lastProbeAt >= Math.min(probeIntervalCapMs(parked.firstPct), minInterval * 2 ** parked.probeFailures);
  return db.instance
    .prepare(
      `SELECT address, label, first_pct AS firstPct, eligible, parked_at AS parkedAt,
              last_probe_at AS lastProbeAt, probe_failures AS probeFailures
       FROM parked_peer
       ORDER BY last_probe_at IS NOT NULL, last_probe_at ASC`,
    )
    .all()
    .filter(isDue);
}

/**
 * Put a parked peer back after Core could not connect to it, one failure
 * further along its backoff. Its parked_at is kept: how long it is remembered
 * runs from when it lost its slot, not from the last try.
 */
function reparkAfterFailedTrial(row, now = Date.now()) {
  db.instance
    .prepare(
      `INSERT INTO parked_peer (address, label, first_pct, eligible, parked_at, last_probe_at, probe_failures)
       VALUES (@address, @label, @firstPct, @eligible, @parkedAt, @now, @failures)
       ON CONFLICT(address) DO UPDATE SET last_probe_at = excluded.last_probe_at, probe_failures = excluded.probe_failures`,
    )
    .run({
      address: row.address,
      label: row.label || null,
      firstPct: row.firstPct == null ? null : row.firstPct,
      eligible: row.eligible == null ? null : row.eligible,
      parkedAt: row.parkedAt || now,
      now,
      failures: (row.probeFailures || 0) + 1,
    });
}

function parkedPeers() {
  return db.instance
    .prepare(
      `SELECT address, label, first_pct AS firstPct, eligible,
              parked_at AS parkedAt, last_probe_at AS lastProbeAt, probe_failures AS probeFailures
       FROM parked_peer ORDER BY first_pct DESC NULLS LAST, parked_at DESC`,
    )
    .all()
    // How long this particular peer is being waited for, so the dashboard can
    // show that the good ones really are kept longer rather than asking anyone
    // to take that on trust.
    .map((p) => ({ ...p, forgottenAt: p.parkedAt + parkedRetentionMs(p.firstPct) }));
}

module.exports = { retireOfflineManualPeers, forgetExpiredParked, dueParkedPeers, reparkAfterFailedTrial, parkedPeers };
