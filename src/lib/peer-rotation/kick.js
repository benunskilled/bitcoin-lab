'use strict';

const rpc = require('../rpc');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const { MIN_ELIGIBLE_FOR_JUDGEMENT } = require('./rules');

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

module.exports = { kickDeadWeight };
