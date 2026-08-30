'use strict';

const db = require('./db');
const rpc = require('./rpc');
const config = require('./config');
const peerSync = require('./peer-sync');
const queries = require('./queries');
const manualPeer = require('./manual-peer');
const logger = require('./logger').make('peer-rotation');

const META_KEY = 'peer_rotation_enabled';

// A peer's lifetime First/Eligible ranking only means something once it has
// been through roughly a full day of blocks (~144/day, see config.js's own
// note on relay_race growth) - judging a peer after two or three blocks
// would kick or promote on pure noise. Applied identically to both passes
// below, so nothing is acted on before it has had a fair, day-scale sample
// to earn (or fail to earn) its ranking.
const MIN_ELIGIBLE_FOR_JUDGEMENT = 144;

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
}

function recentLog(limit = 50) {
  return db.instance
    .prepare(
      `SELECT id, at, action, address,
              first_pct AS firstPct, eligible,
              replaced_address AS replacedAddress, replaced_first_pct AS replacedFirstPct,
              note
       FROM rotation_log ORDER BY at DESC LIMIT ?`,
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
  const host = manualPeer.hostFromAddress(candidate.address);
  for (const port of config.manualPeerPorts) {
    // eslint-disable-next-line no-await-in-loop
    const reachable = await manualPeer.probePort(host, port);
    if (reachable) return manualPeer.formatAddress(host, port);
  }
  return null;
}

function weakestLiveTrusted(liveTrusted) {
  if (liveTrusted.length === 0) return null;
  return liveTrusted.reduce((worst, p) => {
    const pPct = p.firstPct == null ? -1 : p.firstPct;
    const worstPct = worst.firstPct == null ? -1 : worst.firstPct;
    return pPct < worstPct ? p : worst;
  });
}

/**
 * Pass 2: find the single best-performing non-trusted live peer and either
 * promote it into a free manual slot, or - if all `config.maxManualPeers`
 * slots are already taken by live trusted peers - swap it in for the
 * current weakest one, but only when the candidate is strictly better.
 * At most one promotion (direct or swap) happens per tick, so the manual
 * set drifts toward the best peers gradually rather than churning wholesale
 * on a single busy poll.
 *
 * `ranking` is already sorted by lifetime firstPct DESC (see
 * queries.peerRanking's own ORDER BY), so within each filtered list here
 * the first entry is already the best one - no separate sort needed.
 */
async function promoteBestCandidate(ranking) {
  const liveTrusted = ranking.filter((p) => p.trusted && p.live);
  const candidates = ranking.filter(
    (p) =>
      p.live &&
      !p.trusted &&
      !p.sourceObscured &&
      !p.localUmbrelPeer &&
      p.eligible >= MIN_ELIGIBLE_FOR_JUDGEMENT &&
      p.first > 0,
  );

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveDialableAddress(candidate);
    if (!resolved) continue; // e.g. an inbound peer that isn't actually listening - try the next-best candidate

    const label = `auto-promoted (${candidate.firstPct.toFixed(1)}% first)`;

    if (liveTrusted.length < config.maxManualPeers) {
      // eslint-disable-next-line no-await-in-loop
      await peerSync.addTrustedPeer(resolved, label);
      logAction({
        action: 'promote',
        address: resolved,
        firstPct: candidate.firstPct,
        eligible: candidate.eligible,
        note: `free manual slot (${liveTrusted.length}/${config.maxManualPeers} in use)`,
      });
      logger.info('rotation: promoted a peer into a free manual slot', { address: resolved, firstPct: candidate.firstPct });
      return 1;
    }

    const weakest = weakestLiveTrusted(liveTrusted);
    if (!weakest) continue; // maxManualPeers is 0 or liveTrusted somehow empty - nothing to swap against
    const weakestPct = weakest.firstPct == null ? -1 : weakest.firstPct;
    if (candidate.firstPct <= weakestPct) continue; // not strictly better - no point churning a slot for a lateral move

    // eslint-disable-next-line no-await-in-loop
    await peerSync.removeTrustedPeer(weakest.address);
    // eslint-disable-next-line no-await-in-loop
    await peerSync.addTrustedPeer(resolved, label);
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
 * One rotation cycle - a complete no-op unless the toggle is on. Both
 * passes read off the same peerRanking() snapshot rather than each taking
 * their own: they don't interact (kickDeadWeight only ever touches
 * first === 0 peers, promoteBestCandidate only ever touches first > 0
 * ones), and a single snapshot means the two passes agree on exactly which
 * peers were live at the start of this tick.
 */
async function tick() {
  if (!isEnabled()) return { enabled: false, kicked: 0, promoted: 0 };
  const ranking = queries.peerRanking();
  const kicked = await kickDeadWeight(ranking);
  const promoted = await promoteBestCandidate(ranking);
  return { enabled: true, kicked, promoted };
}

module.exports = { isEnabled, setEnabled, logAction, recentLog, kickDeadWeight, promoteBestCandidate, tick };
