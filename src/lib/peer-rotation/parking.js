'use strict';

/**
 * A manual peer that went dark, and the way back in.
 *
 * The two passes here are one story read forwards and backwards, which is why
 * they sit together: retiring a peer *parks* it, and the parked peers are
 * exactly what the revival pass knocks on. Split them apart and the single
 * most important property of the whole design - that losing a slot is
 * reversible, and that this is what lets the grace period be measured in hours
 * instead of never - stops being visible in either half.
 *
 * This file also owns the `parked_peer` table. Nothing else reads or writes
 * it except peer-sync's parkPeer (which puts rows in) and addTrustedPeer
 * (which clears a row when a peer comes back).
 */

const db = require('../db');
const config = require('../config');
const queries = require('../queries');
const peerSync = require('../peer-sync');
const manualPeer = require('../manual-peer');
const { wilsonLowerBound } = require('../score');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const {
  evictableTrusted,
  beatsHolder,
  offlineForMs,
  offlineGraceMs,
  probeIntervalCapMs,
  parkedRetentionMs,
  fmtHours,
  fmtPct,
} = require('./rules');

/**
 * Pass 2: reclaim the slot of a manual peer that has been offline longer than
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
 * is re-probed by reviveParkedPeers below, which is what lets the grace period
 * be measured in hours instead of never: the cost of being too quick is a
 * peer that returns on its own within the next few ticks, not a peer lost.
 *
 * That is also why there is no "don't retire too many at once" guard. The
 * pathological case - Bitcoin Core itself down for longer than the shortest
 * grace period, so every manual peer looks offline at once - resolves itself:
 * all eight are parked, all eight are re-probed, and the ones still out there
 * come straight back. A guard would only turn a self-healing situation into a
 * stuck one.
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
    const parked = peerSync.parkPeer(peer);
    retired += 1;
    logAction({
      action: 'park',
      address: peer.address,
      firstPct: peer.firstPct,
      eligible: peer.eligible,
      note: parked
        ? `offline ${fmtHours(offlineMs)} - past the ${fmtHours(grace)} its record earned; parked for re-testing`
        : `offline ${fmtHours(offlineMs)} - past the ${fmtHours(grace)} its record earned; no track record to park`,
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
 * Pass 3: knock on the door of the peers that were parked, and let the first
 * one that answers back in.
 *
 * A handful of TCP handshakes per tick (config.parkedPeerProbesPerTick),
 * oldest-checked first, with the interval backing off as failures accumulate -
 * so an address that has been dead for a week costs one handshake every twelve
 * hours, while one parked ten minutes ago is checked promptly. The port is the
 * one that answered when the peer was originally added, so this is a single
 * connect(), not a port search.
 *
 * A peer that answers still has to earn its slot the same way anyone else
 * does: straight in if a slot is free, otherwise only if it beats the current
 * weakest. A returning 40% peer displacing a 3% one is the entire point; a
 * returning 3% peer displacing a 12% one would not be.
 */
async function reviveParkedPeers(ranking) {
  const now = Date.now();
  // Forgetting a parked peer entirely is scaled the same way everything else
  // about that peer is: by what it actually did. Expressed in SQL so it stays
  // one pass over the table rather than a read-then-delete.
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

  const minInterval = config.parkedPeerMinProbeIntervalMinutes * 60 * 1000;
  const candidates = db.instance
    .prepare(
      `SELECT address, label, first_pct AS firstPct, eligible,
              last_probe_at AS lastProbeAt, probe_failures AS probeFailures
       FROM parked_peer
       ORDER BY last_probe_at IS NOT NULL, last_probe_at ASC
       LIMIT ?`,
    )
    .all(config.parkedPeerProbesPerTick);

  const trusted = ranking.filter((p) => p.trusted);
  let revived = 0;

  for (const parked of candidates) {
    // Exponential backoff on repeated failures, capped - a permanently dead
    // address must not cost the same as one that just dropped out for lunch -
    // and the cap itself depends on how much this peer is worth waiting for.
    const wait = Math.min(
      probeIntervalCapMs(parked.firstPct),
      minInterval * 2 ** parked.probeFailures,
    );
    if (parked.lastProbeAt != null && now - parked.lastProbeAt < wait) continue;

    const { addr, port } = manualPeer.resolveHostPort(parked.address);
    const reachable = port != null ? await manualPeer.probePort(addr, port) : false;

    if (!reachable) {
      db.instance
        .prepare(`UPDATE parked_peer SET last_probe_at = ?, probe_failures = probe_failures + 1 WHERE address = ?`)
        .run(now, parked.address);
      continue;
    }

    // It is back. Only one peer is let back in per tick, for the same reason
    // only one is promoted: the manual set should drift, not churn.
    if (revived > 0) {
      db.instance.prepare(`UPDATE parked_peer SET last_probe_at = ?, probe_failures = 0 WHERE address = ?`).run(now, parked.address);
      continue;
    }

    let replaced = null;
    if (trusted.length >= config.maxManualPeers) {
      const weakest = queries.weakestTrustedPeer(evictableTrusted(trusted));
      // Lifetime against lifetime here, on both sides, rather than the peer
      // score either side would otherwise be judged by.
      //
      // A parked peer has been offline by definition, so it has no recent
      // window at all - and a peer with an empty window scores exactly its
      // lifetime figure (see score.js). The parked side is therefore already a
      // lifetime figure whatever we choose to call it. The holder is the side
      // that has to be converted: it is live, its window is full, so its score
      // is what it has done in the last few days and nothing else. Comparing
      // those two as they stand would not be one peer against another, it
      // would be one peer's whole life against another's last three days -
      // and which of the two that flattered would depend on nothing but which
      // one happened to be parked.
      //
      // The counts are reconstructed from what parking stored (a percentage
      // and a sample size). That loses a fraction of a block to rounding and
      // decides nothing at this margin.
      const parkedLifetime = wilsonLowerBound(
        Math.round(((parked.firstPct || 0) / 100) * (parked.eligible || 0)),
        parked.eligible || 0,
      );
      if (!weakest || !beatsHolder(parkedLifetime, wilsonLowerBound(weakest.first, weakest.eligible))) {
        // Reachable but not worth a slot right now - reset the failure count
        // (it is alive, after all) and leave it parked for a better moment.
        // Also lands here when every slot is still inside its new-peer grace.
        db.instance.prepare(`UPDATE parked_peer SET last_probe_at = ?, probe_failures = 0 WHERE address = ?`).run(now, parked.address);
        continue;
      }
      await peerSync.removeTrustedPeer(weakest.address);
      peerSync.parkPeer(weakest);
      trusted.splice(trusted.indexOf(weakest), 1);
      replaced = weakest;
    }

    const label = parked.label || `back from parking (${fmtPct(parked.firstPct)} first)`;
    const result = await peerSync.addTrustedPeer(parked.address, label);
    if (!result.ok) {
      // The peer answered - this is not a probe failure, so the backoff must
      // not grow. Something else refused the add (the cap, seen from a
      // snapshot a moment out of date, or Core rejecting the address); note
      // the attempt and try again on the next tick.
      db.instance
        .prepare(`UPDATE parked_peer SET last_probe_at = ?, probe_failures = 0 WHERE address = ?`)
        .run(now, parked.address);
      logger.warn('rotation: a parked peer answered but could not be re-added', {
        address: parked.address,
        error: result.error,
      });
      continue;
    }

    // addTrustedPeer clears the parked_peer row itself, so there is nothing
    // to delete here - one owner for that fact, not two.
    revived += 1;
    trusted.push({
      address: parked.address,
      firstPct: parked.firstPct,
      eligible: parked.eligible,
      live: false,
      trusted: true,
    });
    logAction({
      action: 'revive',
      address: parked.address,
      firstPct: parked.firstPct,
      eligible: parked.eligible,
      replacedAddress: replaced ? replaced.address : null,
      replacedFirstPct: replaced ? replaced.firstPct : null,
      note: replaced
        ? 'answered again and beat the weakest manual peer'
        : 'answered again and took a free manual slot',
    });
    logger.info('rotation: a parked peer answered again and got its manual slot back', {
      address: parked.address,
      firstPct: parked.firstPct,
      replacedAddress: replaced ? replaced.address : null,
    });
  }

  return revived;
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

module.exports = { retireOfflineManualPeers, reviveParkedPeers, parkedPeers };
