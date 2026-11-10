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
 * for Core: within its time (NO_CONNECT_MS, TRIAL_MS, HEADERS_OPEN_MS) Core must hold a manual connection to it, to a
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
const { addressKey, hostFromAddress, unreachableNetwork } = require('../address');
const spread = require('./spread');
const { bookEntries, usableNetworks, bannedMatcher, servesBlocks } = require('./addrbook');

const TRIAL_KEY = 'slot_fill_trial';
// Passes run every ten minutes; while a trial is open a check runs every
// minute (peer-profiler.js), so these are the real waits.
//
// No connection at all by then: the candidate is out. Core dials an added
// node within about a minute, and a clearnet address that does not answer is
// settled in about 65 s (5 s to connect, 60 s for the handshake). Tor adds a
// circuit (Winnow's census, 7-9 November 2026: 11.7 s median, 51 s the
// longest success); I2P goes through SAM, whose budget is minutes, but the
// slot fill only starts an I2P candidate once Core holds an I2P connection,
// so the session is up.
const NO_CONNECT_MS = { clearnet: 5 * 60 * 1000, Tor: 10 * 60 * 1000, I2P: 15 * 60 * 1000 };
// Connected, but not on our tip: long enough for the peer to answer the
// headers Core asks every new peer for.
const TRIAL_MS = 15 * 60 * 1000;
// Connected, serves blocks, but Core has no header height for it yet
// (synced_headers -1). A peer one or two blocks behind our tip stays there
// until it announces a block, and the next one may be half an hour away:
// that is no verdict, so it gets this long.
const HEADERS_OPEN_MS = 30 * 60 * 1000;
// An address-book address Core could not connect to is left alone this long.
const FAILED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const TRIED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// Adds refused before Core was even asked (already connected, say) per pass.
const ATTEMPTS_PER_PASS = 3;
// A trial this young may still be in the middle of its add, in the other
// process: no row yet is not the same as a row someone took out.
const ADDING_MS = 60 * 1000;

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

// The last trial of an address: how it ended and how long it ran, kept so a
// restart does not take the reason with it (the app log is all that held it).
function markTried(address, ok, now, { reason = null, startedAt = null } = {}) {
  const net = unreachableNetwork(address);
  db.instance
    .prepare(`INSERT INTO slot_fill_tried (address, tried_at, ok, reason, started_at, network) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(address) DO UPDATE SET tried_at = excluded.tried_at, ok = excluded.ok,
                reason = excluded.reason, started_at = excluded.started_at, network = excluded.network`)
    .run(address, now, ok ? 1 : 0, reason, startedAt, net === 'Tor' ? 'tor' : net === 'I2P' ? 'i2p' : 'clearnet');
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

// getpeerinfo without the session of a candidate just taken out: Core drops
// it a moment later, and until then it would count as a working connection.
function withoutSession(peers, address) {
  return peers.filter((p) => !(p.connection_type === 'manual' && keyOf(p.addr) === keyOf(address)));
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

// Why a trial ended without the slot, as a short code (kept in the database)
// and as words (the app log). "No connection" is what was seen at the checks:
// a session that came and went between two of them leaves no trace.
function whyNot(session) {
  if (!session) return { code: 'no_connection', text: 'no connection seen' };
  if (!servesBlocks(session.services)) return { code: 'no_services', text: 'connected, but serves no blocks' };
  if (!(Number(session.synced_headers) >= 0)) return { code: 'height_unknown', text: 'connected, but Core had no header height for it' };
  return { code: 'height_wrong', text: 'connected, but not on our chain tip' };
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
  if (!row && now - trial.startedAt < ADDING_MS) return 'waiting';
  // Given the padlock by hand while on trial: a person's decision, and it
  // stands.
  if (row && row.kept) {
    writeTrial(null);
    return 'left';
  }
  // Taken out by hand - or the app stopped, or the add failed, after Core was
  // told: Core's list may still hold it, and the next sync would adopt it as
  // somebody else's addnode, padlocked. Told again to drop it - through
  // removeTrustedPeer, which remembers a remove Core did not take, so the sync
  // repeats it rather than adopting the candidate. Before the trial closes:
  // the trial is what keeps the sync off it until then.
  if (!row) {
    await peerSync.removeTrustedPeer(trial.address, { disconnect: false });
    writeTrial(null);
    return 'left';
  }
  const session = manualSession(peers, trial.address);
  if (works(session, chain, trial.tip)) {
    writeTrial(null);
    markTried(trial.address, true, now, { reason: 'ok', startedAt: trial.startedAt });
    logAction({ action: 'promote', address: trial.address, note: trial.note });
    logger.info('slot fill: Core connected, the candidate keeps the slot', { address: trial.address });
    return 'confirmed';
  }
  // How long the verdict waits depends on what Core has to show for it so
  // far: no connection at all, a connection with no header height yet, or a
  // height that is not ours.
  const elapsed = now - trial.startedAt;
  const headersOpen = Boolean(session) && servesBlocks(session.services) && !(Number(session.synced_headers) >= 0);
  const limit = !session
    ? NO_CONNECT_MS[unreachableNetwork(trial.address)] || NO_CONNECT_MS.clearnet
    : headersOpen ? HEADERS_OPEN_MS : TRIAL_MS;
  if (!force && elapsed < limit) return 'waiting';

  // Out of the set first, then the trial is closed: a crash in between leaves
  // a trial whose candidate is gone, which the next pass reads as 'left'.
  // Not in the dashboard's log: a candidate Core could not use is the slot
  // fill's own business, and the next one is tried anyway.
  await peerSync.removeTrustedPeer(trial.address);
  writeTrial(null);
  const why = whyNot(session);
  if (!force) markTried(trial.address, false, now, { reason: why.code, startedAt: trial.startedAt });
  const minutes = Math.max(1, Math.round((now - trial.startedAt) / 60000));
  logger.info('slot fill: candidate not kept', {
    address: trial.address, what: trial.what, reason: force ? 'switched off' : `${why.text} in ${minutes} min`,
  });
  return 'reverted';
}

/**
 * Put the next candidate on trial, if a slot is free. `peers` is getpeerinfo
 * from this pass. Returns the candidate's address, or 0.
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

  // Counted over all outbound connections, Core's own too (spread.js).
  const coreRegions = spread.coreRegionsOf(ranking);
  const coreKeys = spread.coreOperatorsOf(ranking);
  const counts = spread.totalCounts(trusted, coreRegions);
  const gaps = new Set(Object.keys(spread.REGION_NAMES).filter((r) => (counts[r] || 0) < spread.TARGET_PER_REGION));
  const ranked = spread.rankForGap(shuffle(book), trusted, coreRegions);
  const inGap = (c) => gaps.has(spread.placeOf(c).region);
  // Where clearnet works, one Tor and one I2P connection are enough, Core's
  // own counted (10.11.2026): an I2P or Tor peer may sit anywhere, and those
  // networks are small, so a further one says less than a continent. A node
  // on Tor alone takes all it can get there.
  const clearnet = nets.has('ipv4') || nets.has('ipv6');
  const capped = (c) => {
    const { region } = spread.placeOf(c);
    return clearnet && (region === 'TOR' || region === 'I2P') && (counts[region] || 0) >= 1;
  };
  for (let i = ranked.length - 1; i >= 0; i--) if (capped(ranked[i])) ranked.splice(i, 1);
  const tried = ranked.filter((c) => !c.fromNew);
  // A missing region "tried" has nobody from may look in "new" (addrbook.js).
  // Nobody the provider rule would let in, that is: a region whose only
  // tried candidates are with providers already in use is still missing.
  const triedGaps = new Set(tried.filter((c) => inGap(c) && spread.admit(c, trusted, max, coreKeys)).map((c) => spread.placeOf(c).region));
  const stand = ranked.filter((c) => c.fromNew && inGap(c) && !triedGaps.has(spread.placeOf(c).region));
  // The missing regions first, from "tried", then from "new" where "tried"
  // has none; once none of them can be filled - a node that reaches only
  // Tor, say - anyone the spread lets in from "tried", so that no slot stays
  // empty for want of a perfect candidate.
  const ordered = [...tried.filter(inGap), ...stand, ...tried.filter((c) => !inGap(c))];

  let attempts = 0;
  for (const c of ordered) {
    if (!spread.admit(c, trusted, max, coreKeys)) continue;
    const what = spread.describe(c);
    const { region } = spread.placeOf(c);
    // Where it is shows under its address in the log; the note says why.
    // How many connections its region had: none, or only as few as any.
    const why = region ? `${spread.REGION_NAMES[region]} had ${counts[region] ? `only ${counts[region]}` : 'none'}` : 'free slot';
    // Written before the add: if the app stops between the two, the next pass
    // finds the trial and either its candidate (and judges it) or nothing.
    writeTrial({
      address: c.address,
      startedAt: now,
      tip: Number(chain.headers ?? chain.blocks),
      what,
      note: why,
      ...(c.fromNew ? { fromNew: true } : {}),
    });
    const result = await peerSync.addTrustedPeer(c.address, `slot fill: ${what}`, { neverDisconnect: true });
    if (result.ok) {
      logger.info('slot fill: candidate on trial', { address: c.address });
      return c.address;
    }
    writeTrial(null);
    logger.info('slot fill: candidate not added', { address: c.address, error: result.error });
    // The set filled up under us (a peer added by hand meanwhile): nothing
    // wrong with the candidate, and nothing more to do this pass. Nor is a
    // refusal held against it: it may be Core not answering, and a week's
    // cooldown for that would cost good addresses.
    if (result.count >= max) return 0;
    attempts += 1;
    if (attempts >= ATTEMPTS_PER_PASS) return 0;
  }
  return 0;
}

// Take a candidate out at once, trial or not: the slot fill was switched off
// while this pass was adding it.
async function abandon(address, now = Date.now()) {
  await peerSync.removeTrustedPeer(address);
  writeTrial(null);
  logger.info('slot fill: candidate taken out, switched off while adding', { address, at: now });
}

module.exports = { settle, start, abandon, currentTrial, works, withoutSession };
