'use strict';

const db = require('./db');
const rpc = require('./rpc');
const config = require('./config');
const peerSync = require('./peer-sync');
const queries = require('./queries');
const manualPeer = require('./manual-peer');
const { hostFromAddress } = require('./address');
const logger = require('./logger').make('peer-rotation');

const META_KEY = 'peer_rotation_enabled';

// A peer's lifetime First/Eligible ranking only means something once it has
// been through roughly a full day of blocks - judging a peer after two or
// three blocks would kick or promote on pure noise. Applied identically to
// both passes below, so nothing is acted on before it has had a fair,
// day-scale sample to earn (or fail to earn) its ranking. Lives in config.js
// because the widget has to agree with it (see minEligibleForJudgement).
const MIN_ELIGIBLE_FOR_JUDGEMENT = config.minEligibleForJudgement;

/**
 * The manual peers that may be evicted right now to make room for a better
 * one - everybody except those still inside their new-peer grace.
 *
 * A peer that has only just taken a slot has barely any record yet, so it
 * reads as the weakest of the eight no matter how good it actually is. Both
 * eviction paths would then hand its slot to anyone with a longer history,
 * which drops the newcomer back into the candidate pool - where its own full
 * history counts again and immediately wins the slot back. That loop ran for
 * hours on a real node, one disconnect and one addnode every ten minutes,
 * between two peers 0.2 points apart.
 *
 * Note this only shields against being out-ranked. A peer that never connects
 * at all is still retired by retireOfflineManualPeers on the offline grace -
 * otherwise a bad address would hold a scarce slot for fifty blocks it was
 * never present for.
 *
 * With every slot inside the grace this returns nothing, and no swap happens
 * this pass. That is the intended outcome, not a failure: there is no one it
 * would be fair to displace yet.
 */
function evictableTrusted(trusted) {
  // A peer with the star set is never a candidate for displacement, at any
  // record. That is what the star means: this one stays, whatever the
  // measurement says, because the reason for keeping it is not something this
  // app can measure - a friend's node, a second node of your own.
  return trusted.filter(
    (p) => !p.kept && (p.eligible == null ? 0 : p.eligible) >= config.newManualGraceBlocks,
  );
}

/**
 * Is the challenger enough better than the peer holding the slot to be worth
 * the swap? A missing record scores below zero, so a peer with any measured
 * percentage still beats one with none.
 *
 * Strictly-better was the old rule and it churned slots for nothing: taking a
 * slot costs a real disconnect and a real addnode, and 0.6% against 0.4% is a
 * difference of one block in five hundred.
 */
function beatsHolder(challengerPct, holderPct) {
  const score = (pct) => (pct == null ? -1 : pct);
  return score(challengerPct) - score(holderPct) > config.minSwapMarginPct;
}

function isEnabled() {
  const row = db.instance.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY);
  return row ? row.value === '1' : false;
}

function setEnabled(enabled) {
  db.instance
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(META_KEY, enabled ? '1' : '0');
  logger.info('peer rotation toggled', { enabled: Boolean(enabled) });
}

function logAction(entry) {
  db.instance
    .prepare(
      `INSERT INTO rotation_log (at, action, address, first_pct, eligible, replaced_address, replaced_first_pct, note)
       VALUES (@at, @action, @address, @firstPct, @eligible, @replacedAddress, @replacedFirstPct, @note)`,
    )
    .run({
      at: Date.now(),
      action: entry.action,
      address: entry.address,
      firstPct: entry.firstPct == null ? null : entry.firstPct,
      eligible: entry.eligible == null ? null : entry.eligible,
      replacedAddress: entry.replacedAddress || null,
      replacedFirstPct: entry.replacedFirstPct == null ? null : entry.replacedFirstPct,
      note: entry.note || null,
    });

  // Nothing is kept that is not shown. The dashboard offers the newest
  // ROTATION_LOG_ENTRIES behind its "Show all" button, so the table holds
  // exactly that many and the rest goes on the way in - no retention window to
  // reason about, no daily sweep, and no way for a misbehaving loop to leave
  // fifty thousand rows behind before anyone looks.
  //
  // id DESC is the tiebreaker, not decoration: two actions in one tick can
  // share a millisecond, and on equal `at` the order is otherwise undefined -
  // which would let this delete the newer of the two.
  db.instance
    .prepare(`DELETE FROM rotation_log WHERE id NOT IN (SELECT id FROM rotation_log ORDER BY at DESC, id DESC LIMIT ?)`)
    .run(config.rotationLogEntries);

  // The one thing above that must outlive the trim. "How many peers has this
  // ever promoted?" cannot be answered from a table that keeps thirty rows,
  // and the answer is the point of the whole loop - so a promotion is also
  // written somewhere permanent.
  //
  // Here rather than at the two call sites in promoteBestCandidate: they
  // already share beatsHolder and evictableTrusted because writing the same
  // rule out twice is how the two swap paths drifted apart in the first place.
  // Every promotion passes through logAction, so this cannot be forgotten by a
  // future third path.
  //
  // Keyed by IP, and INSERT OR IGNORE: the same host promoted again - after
  // being parked and revived, say - is not a second peer discovered.
  if (entry.action === 'promote' || entry.action === 'swap') {
    db.instance
      .prepare(`INSERT OR IGNORE INTO promoted_peer (ip, first_promoted_at) VALUES (?, ?)`)
      .run(hostFromAddress(entry.address), Date.now());
  }
}

function recentLog(limit = config.rotationLogEntries) {
  return db.instance
    .prepare(
      `SELECT id, at, action, address,
              first_pct AS firstPct, eligible,
              replaced_address AS replacedAddress, replaced_first_pct AS replacedFirstPct,
              note
       FROM rotation_log ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(limit);
}

/**
 * Pass 1: disconnect live, non-trusted outbound peers that have had a full
 * day of eligibility and never once delivered a block first. Core
 * automatically replaces a dropped outbound connection with a fresh,
 * randomly-selected one - that replacement is the whole mechanism this
 * feature rides on, so kicking dead weight is what actually turns the crank
 * on finding better peers over time, not just cleanup for its own sake.
 *
 * Deliberately scoped to outbound-full-relay / block-relay-only only:
 *   - trusted peers are never touched here no matter how they perform -
 *     they were promoted (or added by hand) on purpose.
 *   - inbound peers aren't ours to disconnect-and-replace this way: we
 *     don't control who connects to us, and Core does not backfill a
 *     dropped inbound slot with a fresh random peer the way it does for
 *     outbound - dropping one would just lose a connection for nothing.
 *   - feelers/addr-fetch churn too fast to ever reach MIN_ELIGIBLE_FOR_JUDGEMENT
 *     eligible blocks in the first place, so the eligible gate below already
 *     excludes them; the connection_type check is a second, explicit guard.
 */
async function kickDeadWeight(ranking) {
  const candidates = ranking.filter(
    (p) =>
      p.live &&
      !p.trusted &&
      (p.connectionType === 'outbound-full-relay' || p.connectionType === 'block-relay-only') &&
      p.eligible >= MIN_ELIGIBLE_FOR_JUDGEMENT &&
      p.first === 0,
  );

  let kicked = 0;
  for (const peer of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await rpc.disconnectNode(peer.address);
      kicked += 1;
      logAction({
        action: 'kick',
        address: peer.address,
        firstPct: peer.firstPct,
        eligible: peer.eligible,
        note: `${peer.connectionType}, 0/${peer.eligible} blocks first`,
      });
      logger.info('rotation: kicked a dead-weight outbound peer', {
        address: peer.address,
        eligible: peer.eligible,
        connectionType: peer.connectionType,
      });
    } catch (err) {
      logger.warn('rotation: failed to disconnect a dead-weight peer', { address: peer.address, error: err.message });
    }
  }
  return kicked;
}

// Turns a live candidate's ranking-table address into the real, dialable
// address addnode needs. For an outbound peer, Core dialed that address
// itself, so it's already correct. For an inbound peer, getpeerinfo's addr
// is the peer's ephemeral OUTBOUND-source port, not the port its node
// actually listens on - useless for addnode - so we re-derive the real
// listening port exactly the way the interactive "Add as Manual" flow does:
// strip the address down to a bare host and probe our own configured
// Bitcoin P2P ports against it. Returns null if nothing answers (not every
// inbound peer listens), in which case this candidate simply cannot be
// auto-promoted this tick - the caller moves on to the next-best one.
async function resolveDialableAddress(candidate) {
  if (candidate.direction === 'outbound') {
    return candidate.address;
  }
  return manualPeer.findListeningAddress(manualPeer.hostFromAddress(candidate.address));
}

// The weakest manual peer by lifetime record. The rule itself lives in
// queries.js because the interactive "Add as Manual" at capacity has to
// reclaim a slot by exactly the same standard this does.
const weakestTrusted = queries.weakestTrustedPeer;

/**
 * How long a manual peer may stay offline before its slot is reclaimed.
 *
 * Two things decide this together, and they pull in opposite directions.
 *
 * A single flat timeout is the obvious design and the wrong one: it treats the
 * peer delivering 40% of your blocks first exactly like the one delivering
 * 0.8%, when the whole point of the ranking is that those are not the same
 * peer. So the wait is bought with performance - roughly an hour per
 * percentage point - which turns "how long do we wait?" into a question the
 * peer has already answered itself.
 *
 * But it is bought cheaply, because parking makes the decision reversible.
 * Waiting days for a peer that might return only makes sense if losing the
 * slot were final; it is not (see reviveParkedPeers). What the wait actually
 * has to cover is the outages that fix themselves within the hour - a node
 * restarting, a network blip - not "might be back next week". So the ceiling
 * is a day rather than a week, and the floor an hour rather than six.
 *
 * See config.js for the numbers and the worked examples.
 */
function offlineGraceMs(firstPct) {
  const hours = Math.min(
    config.offlineGraceMaxHours,
    Math.max(config.offlineGraceMinHours, (firstPct == null ? 0 : firstPct) * config.offlineGraceHoursPerPct),
  );
  return hours * 60 * 60 * 1000;
}

/**
 * How long this manual peer has been unreachable *as a manual peer*.
 *
 * Two clocks, and the answer is whichever started later. The obvious one is
 * the time since its last session closed. The other is the time since it
 * joined the manual set, and leaving it out was a genuine bug: a peer whose
 * last session ended five hours ago but which was added to the manual set one
 * minute ago is not five hours overdue, it is one minute old. Core has not
 * even had a chance to dial it yet.
 *
 * Reading only the session clock made the rotation loop eat itself. Retiring
 * parks the peer; the revival pass probes it, finds it answering, and puts it
 * straight back; the next tick reads the same stale session end and retires it
 * again - park, revive, park, revive, every ten minutes forever. Since only
 * one peer may join the manual set per tick, that loop consumed the tick's one
 * move every single time, so no genuine candidate was ever promoted while it
 * ran. Taking the later of the two clocks is what stops it: being (re-)added
 * restarts the grace period, which is what "grace" means.
 *
 * Returns null when neither clock is known - "no evidence it is offline".
 */
function offlineForMs(peer, now) {
  if (peer.live) return null;
  const sinceLastSeen = peer.offlineSinceMs;
  const sinceAdded = peer.trustedSince != null ? now - peer.trustedSince : null;
  if (sinceLastSeen == null) return sinceAdded;
  if (sinceAdded == null) return sinceLastSeen;
  return Math.min(sinceLastSeen, sinceAdded);
}

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

    // eslint-disable-next-line no-await-in-loop
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

function fmtHours(ms) {
  const hours = ms / 3600000;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The longest gap between two knocks on a parked peer's door.
 *
 * Not one number for everyone. The peers worth waiting for get knocked on at
 * full speed indefinitely; the ones that were barely better than random get
 * knocked on progressively more rarely, because even a successful answer from
 * them is worth very little. Full speed from parkedPeerFullSpeedPct upwards,
 * sliding linearly down to the slow ceiling at a record of zero.
 *
 * Deliberately the opposite direction from probing everyone equally often and
 * simply keeping the list shorter: knocking harder on a peer that delivered
 * 40% of your blocks costs three sockets a tick and can save you days of a
 * worse peer set, while knocking on a 1% peer twice a day for a month is pure
 * noise for a reward you would not notice.
 */
function probeIntervalCapMs(firstPct) {
  const fast = config.parkedPeerMaxProbeIntervalHours * 60 * 60 * 1000;
  const slow = config.parkedPeerSlowProbeIntervalHours * 60 * 60 * 1000;
  const share = Math.min(1, (firstPct == null ? 0 : firstPct) / config.parkedPeerFullSpeedPct);
  return slow + (fast - slow) * share;
}

/**
 * How long a parked peer is remembered at all, before its address is dropped
 * and it becomes just another peer the node has seen. Same shape as the
 * offline grace period: bought with the peer's own record.
 *
 * Kept in JavaScript as well as in the DELETE statement's SQL because the
 * dashboard and the tests both need to be able to ask the question without
 * running the deletion.
 */
function parkedRetentionMs(firstPct) {
  const days = Math.min(
    config.parkedPeerMaxRetentionDays,
    Math.max(config.parkedPeerMinRetentionDays, (firstPct == null ? 0 : firstPct) * config.parkedPeerRetentionDaysPerPct),
  );
  return days * 24 * 60 * 60 * 1000;
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
    // eslint-disable-next-line no-await-in-loop
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
      const weakest = weakestTrusted(evictableTrusted(trusted));
      if (!weakest || !beatsHolder(parked.firstPct, weakest.firstPct)) {
        // Reachable but not worth a slot right now - reset the failure count
        // (it is alive, after all) and leave it parked for a better moment.
        // Also lands here when every slot is still inside its new-peer grace.
        db.instance.prepare(`UPDATE parked_peer SET last_probe_at = ?, probe_failures = 0 WHERE address = ?`).run(now, parked.address);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await peerSync.removeTrustedPeer(weakest.address);
      peerSync.parkPeer(weakest);
      trusted.splice(trusted.indexOf(weakest), 1);
      replaced = weakest;
    }

    const label = parked.label || `back from parking (${fmtPct(parked.firstPct)} first)`;
    // eslint-disable-next-line no-await-in-loop
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

function fmtPct(pct) {
  return pct == null ? 'no record' : `${pct.toFixed(1)}%`;
}

/**
 * Pass 2: find the single best-performing non-trusted live peer and either
 * promote it into a free manual slot, or - if all `config.maxManualPeers`
 * slots are already taken - swap it in for the current weakest one, but only
 * when the candidate is strictly better. At most one promotion (direct or
 * swap) happens per tick, so the manual set drifts toward the best peers
 * gradually rather than churning wholesale on a single busy poll.
 *
 * The slot count is over ALL manual peers, not just the currently-connected
 * ones. Counting only live peers was a real bug: a manual peer that is merely
 * offline (Core is still retrying it, and there is a whole panel devoted to
 * showing this) left an apparently free slot behind, so every tick promoted
 * one more peer - permanently, because Core only maintains
 * MAX_ADDNODE_CONNECTIONS=8 addnode connections and syncTrustedToAddnode
 * hands those out oldest-first, so the newcomer never became live and never
 * closed the gap it was filling. trusted_peer grew by ~144 rows a day and the
 * swap branch - the only thing that ever removes a manual peer - was
 * unreachable the entire time.
 *
 * `ranking` is already sorted by lifetime firstPct DESC (see
 * queries.peerRanking's own ORDER BY), so within each filtered list here
 * the first entry is already the best one - no separate sort needed.
 */
async function promoteBestCandidate(ranking) {
  const trusted = ranking.filter((p) => p.trusted);
  const liveTrusted = trusted.filter((p) => p.live);
  const candidates = ranking.filter(
    (p) =>
      p.live &&
      !p.trusted &&
      !p.sourceObscured &&
      !p.localUmbrelPeer &&
      // Tor, I2P and CJDNS peers have no address this container can dial, so
      // resolveDialableAddress would probe and fail for each of them on every
      // single pass. Skipping them here is not a policy decision about those
      // networks - they stay in the ranking and keep earning First % - it just
      // stops the loop from repeatedly attempting the impossible.
      !p.privateNetwork &&
      p.eligible >= MIN_ELIGIBLE_FOR_JUDGEMENT &&
      p.first > 0,
  );

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveDialableAddress(candidate);
    if (!resolved) continue; // e.g. an inbound peer that isn't actually listening - try the next-best candidate

    // The candidate was filtered as untrusted on the address the ranking row
    // carries - but for an inbound peer that is its ephemeral source port,
    // and resolveDialableAddress just turned it into the real listening
    // address, which may already be a manual peer. Without this re-check the
    // loop "promotes" the same peer again on every single tick: the upsert in
    // addTrustedPeer quietly becomes a label update, a bogus promote row goes
    // into the log, and the one promotion this tick was allowed is spent -
    // permanently starving every genuine candidate behind it.
    if (trusted.some((p) => p.address === resolved)) continue;

    const label = `auto-promoted (${candidate.firstPct.toFixed(1)}% first)`;

    if (trusted.length < config.maxManualPeers) {
      // eslint-disable-next-line no-await-in-loop
      const result = await peerSync.addTrustedPeer(resolved, label);
      if (!result.ok) {
        logger.warn('rotation: promotion refused', { address: resolved, error: result.error });
        continue;
      }
      logAction({
        action: 'promote',
        address: resolved,
        firstPct: candidate.firstPct,
        eligible: candidate.eligible,
        note: `free manual slot (${trusted.length}/${config.maxManualPeers} taken, ${liveTrusted.length} live)`,
      });
      logger.info('rotation: promoted a peer into a free manual slot', { address: resolved, firstPct: candidate.firstPct });
      return 1;
    }

    const weakest = weakestTrusted(evictableTrusted(trusted));
    // Nothing to swap against: maxManualPeers is 0, or every current slot is
    // still inside its new-peer grace and none of them may be displaced yet.
    if (!weakest) continue;
    if (!beatsHolder(candidate.firstPct, weakest.firstPct)) continue;

    // eslint-disable-next-line no-await-in-loop
    await peerSync.removeTrustedPeer(weakest.address);
    // Losing a slot to someone better is not the same as being worthless -
    // park it, so if a slot frees up later this peer's real track record
    // counts for more than a randomly discovered stranger's.
    peerSync.parkPeer(weakest);
    // eslint-disable-next-line no-await-in-loop
    const swapped = await peerSync.addTrustedPeer(resolved, label);
    if (!swapped.ok) {
      logger.warn('rotation: swap refused after freeing the slot', { address: resolved, error: swapped.error });
      continue;
    }
    logAction({
      action: 'swap',
      address: resolved,
      firstPct: candidate.firstPct,
      eligible: candidate.eligible,
      replacedAddress: weakest.address,
      replacedFirstPct: weakest.firstPct,
      note: 'replaced the weakest current manual peer',
    });
    logger.info('rotation: swapped a stronger candidate in for the weakest manual peer', {
      address: resolved,
      replacedAddress: weakest.address,
      candidateFirstPct: candidate.firstPct,
      replacedFirstPct: weakest.firstPct,
    });
    return 1;
  }
  return 0;
}

/**
 * One rotation cycle - a complete no-op unless the toggle is on.
 *
 * The order is deliberate and is where the four passes stop being independent:
 *
 *   kick    frees an automatic outbound slot, which Core refills with a fresh
 *           random peer - the mechanism the whole feature rides on.
 *   retire  frees a MANUAL slot held by a peer that is not there any more.
 *   revive  offers that slot first to a parked peer with a proven record,
 *           because a peer that already delivered 20% of your blocks and has
 *           just come back beats anything merely promising.
 *   promote fills what is still free with the best live candidate - skipped
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
  if (!isEnabled()) return { enabled: false, kicked: 0, retired: 0, revived: 0, promoted: 0, deduped: 0 };
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
  const kicked = await kickDeadWeight(ranking);
  const retired = await retireOfflineManualPeers(ranking);
  const stillTrusted = retired > 0 ? queries.peerRanking() : ranking;
  const revived = await reviveParkedPeers(stillTrusted);
  // One peer joins the manual set per tick, at most. A revival already used it.
  const promoted = revived > 0 ? 0 : await promoteBestCandidate(stillTrusted);
  return { enabled: true, kicked, retired, revived, promoted, deduped };
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

module.exports = {
  isEnabled,
  setEnabled,
  logAction,
  recentLog,
  kickDeadWeight,
  promoteBestCandidate,
  retireOfflineManualPeers,
  reviveParkedPeers,
  offlineGraceMs,
  probeIntervalCapMs,
  parkedRetentionMs,
  parkedPeers,
  tick,
};
