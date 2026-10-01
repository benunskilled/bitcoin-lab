'use strict';

const rpc = require('../rpc');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const { MIN_ELIGIBLE_FOR_JUDGEMENT } = require('./rules');

/**
 * Pass 1: disconnect live, non-trusted outbound peers that have had enough
 * chances in the recent window and never once delivered a block first there.
 *
 * The recent window, not the lifetime record: the same last 500 blocks the
 * dashboard shows. Judged on the lifetime record, a peer that delivered first
 * once, long ago, was spared for good - and the peers that collect such a
 * record are exactly the former manual peers, which Core keeps dialling again
 * as ordinary outbound connections. Seen on a real node: three of them held
 * three of Core's eight full-relay slots for over a week at 0 of 107, 128 and
 * 238 recent blocks, slowing the search for new candidates. Core
 * automatically replaces a dropped outbound connection with a fresh,
 * randomly-selected one - that replacement is the whole mechanism this
 * feature rides on, so kicking dead weight is what actually turns the crank
 * on finding better peers over time, not just cleanup for its own sake.
 *
 * Deliberately scoped to outbound-full-relay only:
 *   - trusted peers are never touched here no matter how they perform -
 *     they were promoted (or added by hand) on purpose.
 *   - block-relay-only peers are Core's eclipse protection. Core keeps two,
 *     writes them to anchors.dat on a clean shutdown and reconnects to them
 *     first on the next start (net.cpp, MAX_BLOCK_RELAY_ONLY_ANCHORS). Kicking
 *     one throws an anchor away, and Core already rotates the temporary
 *     extra block-relay-only peer itself (EvictExtraOutboundPeers).
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
      p.connectionType === 'outbound-full-relay' &&
      p.recentEligible >= MIN_ELIGIBLE_FOR_JUDGEMENT &&
      p.recentFirst === 0,
  );

  let kicked = 0;
  for (const peer of candidates) {
    try {
      await rpc.disconnectNode(peer.address);
      kicked += 1;
      logAction({
        action: 'kick',
        address: peer.address,
        firstPct: peer.firstPct,
        eligible: peer.recentEligible,
        note: `${peer.connectionType}, 0/${peer.recentEligible} recent blocks first`,
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

module.exports = { kickDeadWeight };
