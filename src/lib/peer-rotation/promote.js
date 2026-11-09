'use strict';

const config = require('../config');
const peerSync = require('../peer-sync');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const { MIN_ELIGIBLE_FOR_JUDGEMENT, evictableTrusted } = require('./rules');
const spread = require('./spread');

/**
 * Pass 4: give one manual slot to the live candidate that does the most for
 * the spread (see spread.js) - a free slot to the best-placed candidate, or,
 * with all `config.maxManualPeers` slots taken, a surplus holder's slot to a
 * candidate from a region below the target. At most one move per tick, so the
 * manual set drifts rather than churns.
 *
 * Speed alone no longer takes a slot from anyone. It used to - a challenger a
 * clear margin ahead replaced the weakest holder - and on a real node that
 * gathered 7 of 8 slots in Europe for no measurable gain (spread.js). The
 * score now only orders candidates for the same gap.
 *
 * The slot count is over ALL manual peers, not just the currently-connected
 * ones. Counting only live peers was a real bug: a manual peer that is merely
 * offline (Core is still retrying it, and there is a whole panel devoted to
 * showing this) left an apparently free slot behind, so every tick promoted
 * one more peer - permanently, because Core only maintains
 * MAX_ADDNODE_CONNECTIONS=8 addnode connections and syncTrustedToAddnode
 * hands those out oldest-first, so the newcomer never became live and never
 * closed the gap it was filling.
 *
 * `ranking` is already sorted by peer score, best first (queries.peerRanking
 * sorts in JavaScript, because the score blends the recent window, which the
 * SQL does not have).
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
      // those networks - they stay in the ranking - it just stops the loop
      // attempting the impossible on every pass.
      !p.privateNetwork &&
      // Inbound peers are measured and ranked, and the loop leaves them alone.
      //
      // Promoting one used to be a feature, and it destroyed the thing it was
      // rewarding. An inbound peer's record belongs to the connection IT
      // opened; promotion probes for its listening port, dials out to that
      // instead, and drops the original session so Core redials it as a manual
      // one. The peer that earned the record is then gone, replaced by a
      // different connection to the same host whose record starts at zero.
      //
      // Adding one by hand still works and always did: that is a person
      // deciding, having seen the number, and it is their slot to spend.
      p.direction === 'outbound' &&
      // Block-relay-only peers are Core's anchors against eclipse attacks: it
      // keeps two, and saves them across a restart. Promoting one drops that session before the addnode
      // (peer-sync's disconnectIfLiveNonManual), so Core loses the anchor and
      // fills the place with a random peer. Same as inbound: measured, ranked,
      // left alone, and a person can still add one by hand.
      p.connectionType !== 'block-relay-only' &&
      // A day of blocks connected: long enough to show it stays. It need not
      // have been first - a peer on another continent seldom is, and that
      // peer is the point now - but it must be a node that can hand over a
      // block at all, not a wallet or a node on another chain.
      p.eligible >= MIN_ELIGIBLE_FOR_JUDGEMENT &&
      !p.offersNothing &&
      !p.otherChain,
  );

  const coreRegions = spread.coreRegionsOf(ranking);
  const evictable = evictableTrusted(trusted).filter((p) => !p.hb);
  for (const candidate of spread.rankForGap(candidates, trusted, coreRegions)) {
    const decision = spread.admit(candidate, trusted, evictable, config.maxManualPeers);
    if (!decision) continue;
    // An outbound peer's address is the one Core dialled, so it is already
    // what addnode needs - no probing, and no chance of resolving onto an
    // address that is a manual peer under a different spelling.
    const resolved = candidate.address;
    const where = spread.describe(candidate);
    const label = `rotation: ${where}`;

    if (decision.free) {
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
        note: `free manual slot (${trusted.length}/${config.maxManualPeers} taken, ${liveTrusted.length} live) · ${where}`,
      });
      logger.info('rotation: promoted a peer into a free manual slot', { address: resolved, where });
      return 1;
    }

    // The newcomer goes in first and the holder comes out only once that has
    // worked - addTrustedPeer does both, in that order. The other way round,
    // a newcomer Core refused left the slot empty.
    //
    // Displacement closes the connection: Core never changes a connection's
    // type, so a displaced peer left up stays MANUAL and keeps its addnode
    // grant, and with all eight in use the newcomer cannot be dialled. The
    // peer keeps its record and can come back as an ordinary outbound peer.
    //
    // Parking is for a peer that is GONE; one still connected does not need it.
    const holder = decision.replace;
    const swapped = await peerSync.addTrustedPeer(resolved, label, { replace: holder, parkEvicted: !holder.live });
    if (!swapped.ok) {
      logger.warn('rotation: swap refused, the holder keeps its slot', { address: resolved, error: swapped.error });
      continue;
    }
    logAction({
      action: 'swap',
      address: resolved,
      firstPct: candidate.firstPct,
      eligible: candidate.eligible,
      replacedAddress: holder.address,
      replacedFirstPct: holder.firstPct,
      note: `spread: ${where} in for ${spread.describe(holder)}`,
    });
    logger.info('rotation: swapped a peer in to spread the manual set', {
      address: resolved, where, replacedAddress: holder.address,
    });
    return 1;
  }
  return 0;
}

module.exports = { promoteBestCandidate };
