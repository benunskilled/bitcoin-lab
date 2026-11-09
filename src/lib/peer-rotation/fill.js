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
// failed one cost that peer its connection for a quarter of an hour. An hour
// after the first failure, doubling with each one after it up to a day, and
// back to an hour once a swap holds - a region whose address-book entries
// mostly fail must not cost a working peer its connection all day long.
const SWAP_REST_MS = 60 * 60 * 1000;
const SWAP_REST_MAX_MS = 24 * 60 * 60 * 1000;
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

function swapRest() {
  try {
    const value = JSON.parse(readMeta(REST_KEY) || 'null');
    return value && typeof value === 'object' ? value : { until: 0, failures: 0 };
  } catch {
    return { until: 0, failures: 0 };
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
// this chain answers with the tip within seconds - on a real node, fresh
// connections showed the tip in synced_headers after 12 s. Later blocks do not
// move it unless that peer announces them first, so it is held against the
// tip as it was when the trial began, not as it is now: three blocks in a
// quarter of an hour would otherwise fail a good peer.
function works(session, chain, since = null) {
  if (!session || !servesBlocks(session.services)) return false;
  const tip = Number(since ?? chain.headers ?? chain.blocks);
  return Number.isFinite(tip) && Number(session.synced_headers) >= tip - 2;
}

function whyNot(session) {
  if (!session) return 'Core could not connect';
  if (!servesBlocks(session.services)) return 'connected, but serves no blocks';
  return 'connected, but not on our chain tip';
}

// The peer let go for a candidate, back in the set - or, if Core will not
// have it back as a manual peer (the slots filled up by hand meanwhile, or it
// is connected to Core some other way now), parked with its record, so that
// it is not simply gone.
async function bringBack(holder) {
  const result = await peerSync.addTrustedPeer(holder.address, holder.label, { neverDisconnect: true });
  if (result.ok) {
    // On the slot it had held since when it had: a fresh start would hand it
    // the new-slot grace for having been let go for nothing.
    if (holder.since != null) {
      db.instance.prepare('UPDATE trusted_peer SET created_at = ? WHERE address = ?').run(holder.since, holder.address);
    }
    return ` · ${holder.where} back`;
  }
  const parked = peerSync.parkPeer(holder);
  return ` · ${holder.where} not back (${result.error})${parked ? ', parked' : ''}`;
}

/**
 * Settle the candidate on trial: keep it if Core holds a working connection
 * to it, wait while the trial runs, undo the move once it is over. `force`
 * settles now either way - the slot fill is being switched off.
 */
async function settle(peers, chain, now = Date.now(), { force = false } = {}) {
  const trial = currentTrial();
  if (!trial) return 'none';
  const row = db.instance.prepare('SELECT kept FROM trusted_peer WHERE address = ?').get(trial.address);
  // Taken out, or given the padlock, by hand while on trial: that was a
  // person's decision about the candidate, and it stands. The peer it
  // replaced was not part of that decision; it goes back to parking.
  if (!row || row.kept) {
    writeMeta(TRIAL_KEY, null);
    if (trial.holder) peerSync.parkPeer(trial.holder);
    return 'left';
  }
  const session = manualSession(peers, trial.address);
  if (works(session, chain, trial.tip)) {
    writeMeta(TRIAL_KEY, null);
    if (!trial.parked) markTried(trial.address, true, now);
    if (trial.holder) writeMeta(REST_KEY, JSON.stringify({ until: 0, failures: 0 }));
    // The peer it replaced keeps its record parked: its region had one too
    // many, and it may be wanted again when that changes. (It was
    // disconnected: Core will not dial a newcomer while the old manual
    // connection holds the slot.)
    if (trial.holder) peerSync.parkPeer(trial.holder);
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
  if (!force && now - trial.startedAt < TRIAL_MS) return 'waiting';

  writeMeta(TRIAL_KEY, null);
  await peerSync.removeTrustedPeer(trial.address);
  if (trial.parked) reparkAfterFailedTrial(trial.parked, now);
  else if (!force) markTried(trial.address, false, now);
  let back = '';
  if (trial.holder) {
    if (!force) {
      const failures = swapRest().failures + 1;
      const rest = Math.min(SWAP_REST_MAX_MS, SWAP_REST_MS * 2 ** (failures - 1));
      writeMeta(REST_KEY, JSON.stringify({ until: now + rest, failures }));
    }
    back = await bringBack(trial.holder);
  }
  const minutes = Math.max(1, Math.round((now - trial.startedAt) / 60000));
  logAction({
    action: 'revert',
    address: trial.address,
    replacedAddress: trial.holder ? trial.holder.address : null,
    replacedFirstPct: trial.holder ? trial.holder.firstPct : null,
    note: force
      ? `${trial.what}: slot fill switched off during the trial${back}`
      : `${trial.what}: ${whyNot(session)} in ${minutes} min${back}`,
  });
  logger.info('slot fill: candidate not kept, reverted', { address: trial.address, reason: force ? 'switched off' : whyNot(session) });
  return 'reverted';
}

async function start(ranking, peers, chain, now = Date.now()) {
  // A node still catching up has no tip to test a candidate against.
  if (chain.initialblockdownload) return 0;
  const trusted = ranking.filter((p) => p.trusted);
  const max = config.maxManualPeers;
  const free = trusted.length < max;
  const counts = spread.regionCounts(trusted);
  const gaps = new Set(Object.keys(spread.REGION_NAMES).filter((r) => (counts[r] || 0) < spread.TARGET_PER_REGION));
  // Core's high-bandwidth peers as Core reports them this minute, not as the
  // last snapshot had them: either direction, since either is a peer Core
  // relies on for the next block.
  const hbNow = (p) => p.hb || peers.some((s) => keyOf(s.addr) === keyOf(p.address) && (s.bip152_hb_to || s.bip152_hb_from));
  const evictable = now < swapRest().until ? [] : evictableTrusted(trusted).filter((p) => !hbNow(p));
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

  // Core's own address too: an address book can hold the node itself.
  const inUse = new Set([
    ...peers.map((p) => hostFromAddress(p.addr)),
    ...trusted.map((p) => hostFromAddress(p.address)),
    ...(networkInfo.localaddresses || []).map((a) => hostFromAddress(String(a.address))),
  ]);
  const usable = (c) => nets.has(c.network) && !inUse.has(hostFromAddress(c.address)) && !banned(c.address);
  const parked = dueParkedPeers(now)
    .map((r) => ({ ...r, network: networkOf(r.address), fromParked: true }))
    .filter(usable);
  // Every parked host, due or not: one waiting out its backoff must not slip
  // in through the address book instead.
  const parkedHosts = new Set(db.instance.prepare('SELECT address FROM parked_peer').all().map((r) => hostFromAddress(r.address)));
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
      tip: Number(chain.headers ?? chain.blocks),
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

module.exports = { settle, start, currentTrial, works, TRIAL_KEY, TRIAL_MS };
