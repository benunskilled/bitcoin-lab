'use strict';

const config = require('../config');
const queries = require('../queries');
const peerSync = require('../peer-sync');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const { MIN_ELIGIBLE_FOR_JUDGEMENT, evictableTrusted, beatsHolder } = require('./rules');

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
      // they could never be kept even if they earned it. Not a policy about
      // those networks - they stay in the ranking and keep earning First % -
      // it just stops the loop attempting the impossible on every pass.
      !p.privateNetwork &&
      // Inbound peers are measured and ranked, and the loop leaves them alone.
      //
      // Promoting one used to be a feature, and it destroyed the thing it was
      // rewarding. An inbound peer's record belongs to the connection IT
      // opened; promotion probes for its listening port, dials out to that
      // instead, and drops the original session so Core redials it as a manual
      // one. The peer that earned the record is then gone, replaced by a
      // different connection to the same host whose record starts at zero -
      // and observed on a real node, delivering nothing afterwards.
      //
      // The likely reason is that a long-lived peer which keeps winning has
      // become one of Core's high-bandwidth compact-block peers, a per-
      // connection standing that a reconnect throws away. That is a
      // hypothesis. What is not a hypothesis is that the connection being
      // measured was deliberately severed, which is enough on its own.
      //
      // Adding one by hand still works and always did: that is a person
      // deciding, having seen the number, and it is their slot to spend.
      p.direction === 'outbound' &&
      p.eligible >= MIN_ELIGIBLE_FOR_JUDGEMENT &&
      p.first > 0,
  );

  for (const candidate of candidates) {
    // An outbound peer's address is the one Core dialled, so it is already
    // what addnode needs - no probing, and no chance of resolving onto an
    // address that is a manual peer under a different spelling.
    const resolved = candidate.address;
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
