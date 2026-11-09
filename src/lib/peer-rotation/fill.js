'use strict';

/**
 * Manual slot fill: which address gets a free manual slot, and the trial that
 * decides whether it keeps it.
 *
 * Only free slots. A working manual peer is never given up for a candidate
 * nobody has seen work yet; a slot comes free when a peer stays offline past
 * its grace (retire.js) or a person removes one, and then a peer from a region
 * the set is missing gets it first (spread.js).
 *
 * One candidate at a time. It goes in with addnode, and the slot fill waits
 * for Core: within TRIAL_MS Core must hold a manual connection to it, to a
 * node that says it serves blocks and segwit and has announced our chain's
 * tip. Then it stays. If not, it is taken out again and the next one tried.
 * That is a check that Core reached a node on this chain, not that the node
 * will relay blocks well - a free slot loses nothing by the try.
 *
 * Why Core decides, and not a probe of this app's own: a probe from this
 * container is not a Bitcoin node's handshake, so the peer could tell this
 * app was knocking, and it went out past Core's proxy and onlynet settings.
 *
 * Core's own connections are never touched. Candidates are addresses Core is
 * not connected to, peer-sync is told not to disconnect anything for them
 * (neverDisconnect), and taking a candidate out again drops only its manual
 * session, by Core's peer id.
 */

const config = require('../config');
const db = require('../db');
const rpc = require('../rpc');
const peerSync = require('../peer-sync');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const { addressKey, hostFromAddress } = require('../address');
const spread = require('./spread');
const { bookEntries, usableNetworks, bannedMatcher, servesBlocks } = require('./addrbook');

const TRIAL_KEY = 'slot_fill_trial';
// Long enough for Core to dial, through Tor or I2P too, and for the peer to
// answer the headers Core asks every new peer for. Passes run every ten
// minutes, so a failed candidate is out on the second one, ~20 minutes in.
const TRIAL_MS = 15 * 60 * 1000;
// An address-book address Core could not connect to is left alone this long.
const FAILED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const TRIED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// Adds refused before Core was even asked (already connected, say) per pass.
const ATTEMPTS_PER_PASS = 3;

const keyOf = (address) => addressKey(address, config.bitcoin.network);

function writeTrial(trial) {
  if (trial == null) {
    db.instance.prepare('DELETE FROM meta WHERE key = ?').run(TRIAL_KEY);
    return;
  }
  db.instance
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(TRIAL_KEY, JSON.stringify(trial));
}

function currentTrial() {
  try {
    const row = db.instance.prepare('SELECT value FROM meta WHERE key = ?').get(TRIAL_KEY);
    return row ? JSON.parse(row.value) : null;
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

/**
 * Settle the candidate on trial: keep it if Core holds a working connection
 * to it, wait while the trial runs, take it out once it is over. `force`
 * settles now either way - the slot fill is being switched off.
 */
async function settle(peers, chain, now = Date.now(), { force = false } = {}) {
  const trial = currentTrial();
  if (!trial) return 'none';
  const row = db.instance.prepare('SELECT kept FROM trusted_peer WHERE address = ?').get(trial.address);
  // Taken out, or given the padlock, by hand while on trial - that was a
  // person's decision, and it stands. Also the state after a crash between
  // writing the trial and the add: nothing was added.
  if (!row || row.kept) {
    writeTrial(null);
    return 'left';
  }
  const session = manualSession(peers, trial.address);
  if (works(session, chain, trial.tip)) {
    writeTrial(null);
    markTried(trial.address, true, now);
    logAction({ action: 'promote', address: trial.address, note: trial.note });
    logger.info('slot fill: Core connected, the candidate keeps the slot', { address: trial.address });
    return 'confirmed';
  }
  if (!force && now - trial.startedAt < TRIAL_MS) return 'waiting';

  // Out of the set first, then the trial is closed: a crash in between leaves
  // a trial whose candidate is gone, which the next pass reads as 'left'.
  await peerSync.removeTrustedPeer(trial.address);
  writeTrial(null);
  if (!force) markTried(trial.address, false, now);
  const minutes = Math.max(1, Math.round((now - trial.startedAt) / 60000));
  logAction({
    action: 'revert',
    address: trial.address,
    note: force ? `${trial.what}: slot fill switched off during the trial` : `${trial.what}: ${whyNot(session)} in ${minutes} min`,
  });
  logger.info('slot fill: candidate not kept', { address: trial.address, reason: force ? 'switched off' : whyNot(session) });
  return 'reverted';
}

/**
 * Put the next candidate on trial, if a slot is free. `peers` is getpeerinfo
 * from this pass.
 */
async function start(ranking, peers, chain, now = Date.now()) {
  // A node still catching up has no tip to test a candidate against.
  if (chain.initialblockdownload) return 0;
  const trusted = ranking.filter((p) => p.trusted);
  const max = config.maxManualPeers;
  if (trusted.length >= max) return 0;

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
  const failed = recentlyFailed(now);
  const book = (await bookEntries(now))
    .filter((c) => nets.has(c.network) && !inUse.has(hostFromAddress(c.address)) && !banned(c.address) && !failed.has(c.address));

  const counts = spread.regionCounts(trusted);
  const gaps = new Set(Object.keys(spread.REGION_NAMES).filter((r) => (counts[r] || 0) < spread.TARGET_PER_REGION));
  const ranked = spread.rankForGap(shuffle(book), trusted, spread.coreRegionsOf(ranking));
  const inGap = (c) => gaps.has(spread.placeOf(c).region);
  // The missing regions first; once none of them can be filled - a node that
  // reaches only Tor, say - anyone the spread lets in, so that no slot stays
  // empty for want of a perfect candidate.
  const ordered = [...ranked.filter(inGap), ...ranked.filter((c) => !inGap(c))];

  let attempts = 0;
  for (const c of ordered) {
    if (!spread.admit(c, trusted, max)) continue;
    const what = spread.describe(c);
    const { region } = spread.placeOf(c);
    const filled = inGap(c) ? `: ${spread.REGION_NAMES[region]} had ${counts[region] ? `only ${counts[region]}` : 'none'}` : '';
    // Written before the add: if the app stops between the two, the next pass
    // finds the trial and either its candidate (and judges it) or nothing.
    writeTrial({
      address: c.address,
      startedAt: now,
      tip: Number(chain.headers ?? chain.blocks),
      what,
      note: `from the address book · ${what}${filled}`,
    });
    const result = await peerSync.addTrustedPeer(c.address, `slot fill: ${what}`, { neverDisconnect: true });
    if (result.ok) {
      logger.info('slot fill: candidate on trial', { address: c.address });
      return 1;
    }
    writeTrial(null);
    logger.info('slot fill: candidate not added', { address: c.address, error: result.error });
    // The set filled up under us (a peer added by hand meanwhile): nothing
    // wrong with the candidate, and nothing more to do this pass.
    if (result.count >= max) return 0;
    markTried(c.address, false, now);
    attempts += 1;
    if (attempts >= ATTEMPTS_PER_PASS) return 0;
  }
  return 0;
}

module.exports = { settle, start, currentTrial, works, TRIAL_KEY, TRIAL_MS };
