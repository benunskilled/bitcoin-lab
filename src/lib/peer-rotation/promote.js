'use strict';

const config = require('../config');
const queries = require('../queries');
const peerSync = require('../peer-sync');
const manualPeer = require('../manual-peer');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const { MIN_ELIGIBLE_FOR_JUDGEMENT, evictableTrusted, beatsHolder } = require('./rules');

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

/**
 * Pass 4: find the single best-performing non-trusted live peer and either
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

    const weakest = queries.weakestTrustedPeer(evictableTrusted(trusted));
    // Nothing to swap against: maxManualPeers is 0, or every current slot is
    // still inside its new-peer grace and none of them may be displaced yet.
    if (!weakest) continue;
    // The peer score on both sides: who deserves the slot now, weighing what
    // each has done lately above what it did over its life.
    if (!beatsHolder(candidate.score, weakest.score)) continue;

    // Displacement leaves the connection up (see removeTrustedPeer): the peer
    // drops back to being an ordinary outbound one, still measured, still
    // ranked, and free to earn a slot back through the normal promotion path.
    await peerSync.removeTrustedPeer(weakest.address, { disconnect: false });
    // Parking is for a peer that is GONE. One that is still connected does not
    // need it and must not have it: parked peers are revived on their lifetime
    // record, so parking a peer that was just displaced on its recent one
    // handed it the slot straight back on the number it had lost on.
    if (!weakest.live) peerSync.parkPeer(weakest);
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

module.exports = { promoteBestCandidate };
