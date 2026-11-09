'use strict';

/**
 * Manual slot fill: which address gets a free or surplus manual slot, and the
 * trial that decides whether it keeps it.
 *
 * One candidate at a time. It goes in with addnode, and the peer it replaces,
 * if any, leaves at the same moment: Core keeps at most eight addnode
 * connections, so the newcomer is only dialled once a slot is free. Then the
 * slot fill waits for Core. Within TRIAL_MS Core must hold a manual
 * connection to it, to a node that serves blocks and segwit and has our
 * chain's tip. If it does, the swap stands. If not, the candidate goes and
 * the peer it replaced comes back, on the slot it had held since when it had.
 *
 * Why Core decides, and not a probe of this app's own: a probe from this
 * container is not a Bitcoin node's handshake, so the peer could tell this
 * app was knocking, and it went out past Core's proxy and onlynet settings.
 * Worse, it proved little - an endpoint could answer a probe and then refuse
 * Core, and the working peer it replaced was already gone. Core's own
 * connection is the only test that says what a manual slot needs to know.
 *
 * Core's own connections are never touched. Candidates are addresses Core is
 * not connected to (addrbook.js, parked peers), and peer-sync is told not to
 * disconnect anything for them (neverDisconnect).
 */

const config = require('../config');
const db = require('../db');
const rpc = require('../rpc');
const peerSync = require('../peer-sync');
const queries = require('../queries');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const { addressKey, hostFromAddress, unreachableNetwork } = require('../address');
const spread = require('./spread');
const { evictableTrusted } = require('./rules');
const { bookEntries, usableNetworks, bannedMatcher, servesBlocks } = require('./addrbook');
const { dueParkedPeers, reparkAfterFailedTrial } = require('./parking');

const TRIAL_KEY = 'slot_fill_trial';
const REST_KEY = 'slot_fill_swap_rest_until';
// Long enough for Core to dial, through Tor or I2P too, and for the peer to
// answer the headers Core asks every new peer for; short enough that a peer
// let go for a candidate that never comes is back within two passes.
const TRIAL_MS = 15 * 60 * 1000;
// After a candidate failed in place of a peer, the next swap waits: every
// failed one cost that peer its connection for a quarter of an hour.
const SWAP_REST_MS = 60 * 60 * 1000;
// An address-book address Core could not connect to is left alone this long.
const FAILED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const TRIED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// Adds refused before Core was even asked (already connected, say) per pass.
const ATTEMPTS_PER_PASS = 3;

const keyOf = (address) => addressKey(address, config.bitcoin.network);

function readMeta(key) {
  const row = db.instance.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function writeMeta(key, value) {
  if (value == null) {
    db.instance.prepare('DELETE FROM meta WHERE key = ?').run(key);
    return;
  }
  db.instance
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function currentTrial() {
  try {
    const raw = readMeta(TRIAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function markTried(address, ok, now) {
  db.instance
    .prepare(`INSERT INTO slot_fill_tried (address, tried_at, ok) VALUES (?, ?, ?)
              ON CONFLICT(address) DO UPDATE SET tried_at = excluded.tried_at, ok = excluded.ok`)
    .run(address, now, ok ? 1 : 0);
}

function recentlyFailed(now) {
  db.instance.prepare('DELETE FROM slot_fill_tried WHERE tried_at < ?').run(now - TRIED_KEEP_MS);
  return new Set(db.instance
    .prepare('SELECT address FROM slot_fill_tried WHERE ok = 0 AND tried_at >= ?')
    .all(now - FAILED_RETRY_MS)
    .map((r) => r.address));
}

function networkOf(address) {
  const hidden = unreachableNetwork(address);
  if (hidden) return hidden.toLowerCase();
  return hostFromAddress(address).includes(':') ? 'ipv6' : 'ipv4';
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Core's session to a manual peer, if it has one.
function manualSession(peers, address) {
  return peers.find((p) => p.connection_type === 'manual' && keyOf(p.addr) === keyOf(address)) || null;
}

// What the slot needs from the peer: blocks and segwit, and our chain. Core
// asks every new peer for headers from just below its own tip, so a peer on
// this chain answers with the tip within seconds.
function works(session, chain) {
  if (!session || !servesBlocks(session.services)) return false;
  const tip = Number(chain.headers ?? chain.blocks);
  return Number.isFinite(tip) && Number(session.synced_headers) >= tip - 2;
}

function whyNot(session) {
  if (!session) return 'Core could not connect';
  if (!servesBlocks(session.services)) return 'connected, but serves no blocks';
  return 'connected, but not on our chain tip';
}

async function confirmOrRevert(trial, peers, chain, now) {
  const row = db.instance.prepare('SELECT kept FROM trusted_peer WHERE address = ?').get(trial.address);
  // Taken out, or given the padlock, by hand while on trial: that was a
  // person's decision, and it stands.
  if (!row || row.kept) {
    writeMeta(TRIAL_KEY, null);
    return 'left';
  }
  const session = manualSession(peers, trial.address);
  if (works(session, chain)) {
    writeMeta(TRIAL_KEY, null);
    if (!trial.parked) markTried(trial.address, true, now);
    // A peer that was offline when it was let go keeps its record parked, as
    // it would have on retiring; one still connected goes on as an ordinary
    // peer.
    if (trial.holder && trial.holder.offline) peerSync.parkPeer(trial.holder);
    logAction({
      action: trial.parked ? 'revive' : trial.holder ? 'swap' : 'promote',
      address: trial.address,
      firstPct: trial.parked ? trial.parked.firstPct : null,
      eligible: trial.parked ? trial.parked.eligible : null,
      replacedAddress: trial.holder ? trial.holder.address : null,
      replacedFirstPct: trial.holder ? trial.holder.firstPct : null,
      note: trial.note,
    });
    logger.info('slot fill: Core connected, the candidate keeps the slot', { address: trial.address });
    return 'confirmed';
  }
  if (now - trial.startedAt < TRIAL_MS) return 'waiting';

  writeMeta(TRIAL_KEY, null);
  await peerSync.removeTrustedPeer(trial.address);
  if (trial.parked) reparkAfterFailedTrial(trial.parked, now);
  else markTried(trial.address, false, now);
  let back = '';
  if (trial.holder) {
    writeMeta(REST_KEY, now + SWAP_REST_MS);
    const result = await peerSync.addTrustedPeer(trial.holder.address, trial.holder.label, { neverDisconnect: true });
    if (result.ok) {
      // On the slot it had held since when it had: a fresh start would hand
      // it the new-slot grace for having been let go for nothing.
      if (trial.holder.since != null) {
        db.instance.prepare('UPDATE trusted_peer SET created_at = ? WHERE address = ?').run(trial.holder.since, trial.holder.address);
      }
      back = ` · ${trial.holder.where} back`;
    } else {
      back = ` · ${trial.holder.where} not back: ${result.error}`;
    }
  }
  const minutes = Math.max(1, Math.round((now - trial.startedAt) / 60000));
  logAction({
    action: 'revert',
    address: trial.address,
    replacedAddress: trial.holder ? trial.holder.address : null,
    replacedFirstPct: trial.holder ? trial.holder.firstPct : null,
    note: `${trial.what}: ${whyNot(session)} in ${minutes} min${back}`,
  });
  logger.info('slot fill: Core did not take the candidate, reverted', { address: trial.address, reason: whyNot(session) });
  return 'reverted';
}

async function startTrial(ranking, peers, now) {
  const trusted = ranking.filter((p) => p.trusted);
  const max = config.maxManualPeers;
  const free = trusted.length < max;
  const counts = spread.regionCounts(trusted);
  const gaps = new Set(Object.keys(spread.REGION_NAMES).filter((r) => (counts[r] || 0) < spread.TARGET_PER_REGION));
  // Core's high-bandwidth peers as Core reports them this minute, not as the
  // last snapshot had them: either direction, since either is a peer Core
  // relies on for the next block.
  const hbNow = (p) => p.hb || peers.some((s) => keyOf(s.addr) === keyOf(p.address) && (s.bip152_hb_to || s.bip152_hb_from));
  const restUntil = Number(readMeta(REST_KEY)) || 0;
  const evictable = now < restUntil ? [] : evictableTrusted(trusted).filter((p) => !hbNow(p));
  const crowded = (p) => counts[spread.placeOf(p).region] > spread.TARGET_PER_REGION;
  if (!free && (!gaps.size || !evictable.some(crowded))) return 0;

  let networkInfo;
  try {
    networkInfo = await rpc.getNetworkInfo();
  } catch (err) {
    logger.debug('slot fill: getnetworkinfo failed', { error: err.message });
    return 0;
  }
  const nets = usableNetworks(networkInfo, peers);
  if (!nets.size) return 0;
  const banned = await bannedMatcher();
  if (!banned) return 0;

  const inUse = new Set([...peers.map((p) => hostFromAddress(p.addr)), ...trusted.map((p) => hostFromAddress(p.address))]);
  const usable = (c) => nets.has(c.network) && !inUse.has(hostFromAddress(c.address)) && !banned(c.address);
  const parked = dueParkedPeers(now)
    .map((r) => ({ ...r, network: networkOf(r.address), fromParked: true }))
    .filter(usable);
  const parkedHosts = new Set(parked.map((r) => hostFromAddress(r.address)));
  const failed = recentlyFailed(now);
  const book = (await bookEntries(now))
    .filter((c) => usable(c) && !failed.has(c.address) && !parkedHosts.has(hostFromAddress(c.address)));

  // Parked peers first within each gap: they have held a slot before.
  const ranked = spread.rankForGap([...parked, ...shuffle(book)], trusted, spread.coreRegionsOf(ranking));
  const inGap = (c) => gaps.has(spread.placeOf(c).region);
  // A free slot no gap can fill - a node that reaches only Tor, say - goes to
  // anyone the spread lets in, so that no slot stays empty for want of a
  // perfect candidate.
  const ordered = [...ranked.filter(inGap), ...(free ? ranked.filter((c) => !inGap(c)) : [])];

  let attempts = 0;
  for (const c of ordered) {
    const decision = spread.admit(c, trusted, evictable, max);
    if (!decision) continue;
    const holder = decision.replace || null;
    const what = spread.describe(c);
    const result = await peerSync.addTrustedPeer(c.address, c.label || `slot fill: ${what}`,
      holder ? { replace: holder, parkEvicted: false, neverDisconnect: true } : { neverDisconnect: true });
    if (!result.ok) {
      logger.info('slot fill: candidate not added', { address: c.address, error: result.error });
      // The set filled up under us (a peer added by hand meanwhile): nothing
      // wrong with the candidate, and nothing more to do this pass.
      if (result.count >= max && !holder) return 0;
      if (c.fromParked) reparkAfterFailedTrial(c, now);
      else markTried(c.address, false, now);
      attempts += 1;
      if (attempts >= ATTEMPTS_PER_PASS) return 0;
      continue;
    }
    // A slot that turned out to be free (the count was a moment old) let
    // nobody go.
    const replaced = result.evicted ? holder : null;
    const how = replaced ? spread.swapNote(c, replaced, trusted) : what;
    writeMeta(TRIAL_KEY, JSON.stringify({
      address: c.address,
      startedAt: now,
      what,
      note: `${c.fromParked ? 'back' : 'from the address book'} · ${how}`,
      holder: replaced && {
        address: replaced.address,
        label: replaced.trustedLabel ?? null,
        since: replaced.trustedSince ?? null,
        firstPct: replaced.firstPct ?? null,
        eligible: replaced.eligible ?? null,
        offline: !replaced.live,
        where: spread.describe(replaced),
      },
      parked: c.fromParked ? {
        address: c.address,
        label: c.label ?? null,
        firstPct: c.firstPct ?? null,
        eligible: c.eligible ?? null,
        parkedAt: c.parkedAt,
        probeFailures: c.probeFailures || 0,
      } : null,
    }));
    logger.info('slot fill: candidate on trial', { address: c.address, replaced: replaced ? replaced.address : null });
    return 1;
  }
  return 0;
}

/**
 * One pass: settle the candidate on trial, if there is one, then put the next
 * one on trial if a slot wants it. `peers` is getpeerinfo from this pass.
 */
async function step(ranking, peers, now = Date.now()) {
  const out = { started: 0, confirmed: 0, reverted: 0 };
  let chain;
  try {
    chain = await rpc.getBlockchainInfo();
  } catch (err) {
    logger.debug('slot fill: getblockchaininfo failed', { error: err.message });
    return out;
  }
  let current = ranking;
  const trial = currentTrial();
  if (trial) {
    const outcome = await confirmOrRevert(trial, peers, chain, now);
    if (outcome === 'waiting') return out;
    if (outcome === 'confirmed') out.confirmed = 1;
    if (outcome === 'reverted') {
      out.reverted = 1;
      // The peer let go is back in, so the next candidate is chosen next pass,
      // against a set that has it.
      return out;
    }
    current = queries.peerRanking();
  }
  // A node still catching up has no tip to test a candidate against.
  if (chain.initialblockdownload) return out;
  out.started = await startTrial(current, peers, now);
  return out;
}

module.exports = { step, currentTrial, works, TRIAL_KEY, TRIAL_MS };
