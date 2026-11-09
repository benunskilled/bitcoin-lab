'use strict';

/**
 * Candidates from Core's own address book, for the regions the live peers
 * cannot fill.
 *
 * The live candidates are Core's automatic outbound peers, and those stay the
 * same for days: on a real node only two of them had been connected long
 * enough to be judged, so the spread stopped after one swap. The address book
 * has thousands. Core keeps them in two tables, "new" (heard of) and "tried"
 * (connected to at least once), and getrawaddrman returns both separately;
 * from "tried" 40-76 % of Core's own connection attempts succeed, from "new"
 * 1-4 % (stratospher and Martin Zumsande, bnoc.xyz, 2026). So the tried table
 * it is. getrawaddrman is a hidden RPC and may change: getnodeaddresses,
 * which mixes both tables, is the fallback.
 *
 * A clearnet candidate is probed first (a version message, see
 * manual-peer.probePort), a few per tick and each address once a day at most.
 * Tor and I2P ones cannot be: this container has no route to either, so Core
 * dials them through its own proxy, and one that never connects is retired on
 * the offline grace like any other manual peer. Nothing is probed at all on a
 * node that sends clearnet through a proxy - the probe would show this node's
 * own address.
 *
 * Also here: the trial. A manual peer that has been first for none of the
 * recent blocks is offered a challenger from the same region, at most once a
 * day, and only one that answers faster than the holder pings. Ping is only
 * ever compared within one region - a peer in Australia is not worse than one
 * in Frankfurt for being further away.
 */

const config = require('../config');
const db = require('../db');
const rpc = require('../rpc');
const peerSync = require('../peer-sync');
const manualPeer = require('../manual-peer');
const logger = require('../logger').make('peer-rotation');
const { logAction } = require('./log');
const { formatAddress, hostFromAddress } = require('../address');
const spread = require('./spread');
const { evictableTrusted, MIN_ELIGIBLE_FOR_JUDGEMENT } = require('./rules');

const NODE_NETWORK = 1;
const NODE_WITNESS = 8;
const NODE_NETWORK_LIMITED = 1024;
const PROBES_PER_TICK = 4;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const BOOK_TTL_MS = 6 * 60 * 60 * 1000;
const TRIAL_EVERY_MS = 24 * 60 * 60 * 1000;
const TRIAL_KEY = 'rotation_trial_at';
// A challenger must answer this much faster than the holder's best ping.
const TRIAL_PING_FACTOR = 0.8;

const probedAt = new Map(); // address -> when this process last tried it
let book = null;

function usable(e) {
  const s = Number(e.services) || 0;
  return (s & NODE_WITNESS) && (s & (NODE_NETWORK | NODE_NETWORK_LIMITED))
    && ['ipv4', 'ipv6', 'onion', 'i2p'].includes(e.network);
}

async function bookEntries(now) {
  if (book && now - book.at < BOOK_TTL_MS) return book.entries;
  let entries = [];
  try {
    const raw = await rpc.call('getrawaddrman', [], { timeoutMs: 30000 });
    if (!raw || typeof raw.tried !== 'object') throw new Error('no tried table in the answer');
    entries = Object.values(raw.tried);
  } catch (err) {
    logger.debug('getrawaddrman unavailable, falling back to getnodeaddresses', { error: err.message });
    for (const net of ['ipv4', 'ipv6', 'onion', 'i2p']) {
      try {
        entries.push(...await rpc.call('getnodeaddresses', [0, net], { timeoutMs: 30000 }));
      } catch { /* a network Core does not know */ }
    }
  }
  const usableEntries = entries.filter(usable).map((e) => ({
    address: formatAddress(e.address, e.port),
    network: e.network,
    fromBook: true,
  }));
  // An empty answer is most likely Core not being up yet: ask again next
  // tick rather than living on nothing for six hours.
  book = usableEntries.length ? { at: now, entries: usableEntries } : null;
  return usableEntries;
}

// Which networks this node can reach, and whether clearnet runs through a proxy.
async function reach() {
  try {
    const info = await rpc.getNetworkInfo();
    const by = Object.fromEntries((info.networks || []).map((n) => [n.name, n]));
    // Clearnet only where Core itself goes there directly: not through a
    // proxy, and not shut off. A node told to use only Tor (onlynet=onion)
    // has no proxy for clearnet, it has no clearnet at all - and a probe from
    // here would show its address all the same.
    const direct = (n) => by[n] && by[n].reachable && !by[n].proxy;
    const proxied = ['ipv4', 'ipv6'].some((n) => by[n] && by[n].proxy);
    return {
      clearnet: !proxied && (direct('ipv4') || direct('ipv6')),
      // A proxy alone is not enough: onlynet decides whether Core may go
      // there, and the rotation follows that choice.
      onion: Boolean(by.onion && by.onion.proxy && by.onion.reachable),
      i2p: Boolean(by.i2p && by.i2p.proxy && by.i2p.reachable),
    };
  } catch {
    return { clearnet: false, onion: false, i2p: false };
  }
}

function hostsInUse(ranking) {
  const hosts = new Set(ranking.filter((p) => p.trusted || p.live).map((p) => hostFromAddress(p.address)));
  for (const r of db.instance.prepare('SELECT address FROM parked_peer').all()) hosts.add(hostFromAddress(r.address));
  return hosts;
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function reachable(c, can) {
  if (c.network === 'onion') return can.onion;
  if (c.network === 'i2p') return can.i2p;
  return can.clearnet;
}

/**
 * Fill one gap from the address book: a free slot, or a surplus holder's
 * slot, for a region the manual set lacks. One move at most; returns 1 or 0.
 */
async function fillFromAddressBook(ranking, now = Date.now()) {
  const trusted = ranking.filter((p) => p.trusted);
  const counts = spread.regionCounts(trusted);
  const gaps = new Set(Object.keys(spread.REGION_NAMES).filter((r) => (counts[r] || 0) < spread.TARGET_PER_REGION));
  if (!gaps.size && trusted.length >= config.maxManualPeers) return 0;
  const evictable = evictableTrusted(trusted).filter((p) => !p.hb);
  if (trusted.length >= config.maxManualPeers && !evictable.length) return 0;

  const can = await reach();
  const inUse = hostsInUse(ranking);
  const fresh = (await bookEntries(now)).filter((c) => reachable(c, can)
    && !inUse.has(hostFromAddress(c.address))
    && !(probedAt.get(c.address) > now - RETRY_AFTER_MS));
  // The gaps first. A free slot no gap can fill - a node that reaches only
  // Tor, say - goes to anyone the spread lets in, so that no slot stays empty.
  const ranked = spread.rankForGap(shuffle(fresh), trusted, spread.coreRegionsOf(ranking));
  const ordered = [
    ...ranked.filter((c) => gaps.has(spread.placeOf(c).region)),
    ...(trusted.length < config.maxManualPeers ? ranked.filter((c) => !gaps.has(spread.placeOf(c).region)) : []),
  ];

  let probes = 0;
  for (const c of ordered) {
    const decision = spread.admit(c, trusted, evictable, config.maxManualPeers);
    if (!decision) continue;
    const { addr, port } = manualPeer.resolveHostPort(c.address);
    if (c.network === 'ipv4' || c.network === 'ipv6') {
      if (probes >= PROBES_PER_TICK) break;
      probes += 1;
      probedAt.set(c.address, now);
      // eslint-disable-next-line no-await-in-loop
      if (!(await manualPeer.probePort(addr, port))) continue;
    } else {
      probedAt.set(c.address, now);
    }
    const note = decision.replace ? spread.swapNote(c, decision.replace, trusted) : spread.describe(c);
    // eslint-disable-next-line no-await-in-loop
    if (await place(c, decision, `from the address book · ${note}`)) return 1;
  }
  return 0;
}

async function place(c, decision, note) {
  const holder = decision.replace || null;
  const result = await peerSync.addTrustedPeer(c.address, `rotation: ${spread.describe(c)}`,
    holder ? { replace: holder, parkEvicted: !holder.live } : {});
  if (!result.ok) {
    logger.warn('rotation: address-book candidate refused', { address: c.address, error: result.error });
    return false;
  }
  logAction({
    action: holder ? 'swap' : 'promote',
    address: c.address,
    replacedAddress: holder ? holder.address : null,
    replacedFirstPct: holder ? holder.firstPct : null,
    note,
  });
  logger.info('rotation: placed an address-book peer', { address: c.address, replaced: holder ? holder.address : null });
  return true;
}

function lastTrialAt() {
  const row = db.instance.prepare('SELECT value FROM meta WHERE key = ?').get(TRIAL_KEY);
  return row ? Number(row.value) : 0;
}

/**
 * The trial: once a day at most, a clearnet manual peer that delivered none of
 * the recent blocks first meets a challenger from its own region - a new
 * operator, a new country if there is one - and gives up its slot if the
 * challenger answers clearly faster. The probe's time from connect to the
 * version reply is two round trips; the holder's best ping is one.
 */
async function trialInRegion(ranking, now = Date.now()) {
  if (now - lastTrialAt() < TRIAL_EVERY_MS) return 0;
  const trusted = ranking.filter((p) => p.trusted);
  const holders = evictableTrusted(trusted)
    .filter((p) => !p.hb && p.live && p.minPingMs != null
      && p.recentEligible >= MIN_ELIGIBLE_FOR_JUDGEMENT && p.recentFirst === 0
      && ['EU', 'NA', 'AS', 'OC', 'SA', 'AF'].includes(spread.placeOf(p).region));
  if (!holders.length) return 0;
  const can = await reach();
  if (!can.clearnet) return 0;
  // Counted from the attempt, not from a success: a holder that is simply far
  // away delivers nothing first for weeks, and without this every tick would
  // probe four more addresses for it.
  db.instance.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(TRIAL_KEY, String(now));

  const inUse = hostsInUse(ranking);
  const entries = await bookEntries(now);
  let probes = 0;
  for (const holder of holders) {
    const { region, country } = spread.placeOf(holder);
    const others = trusted.filter((p) => p !== holder);
    const pool = shuffle(entries.filter((c) => (c.network === 'ipv4' || c.network === 'ipv6')
      && !inUse.has(hostFromAddress(c.address))
      && !(probedAt.get(c.address) > now - RETRY_AFTER_MS)
      && spread.placeOf(c).region === region
      && !others.some((p) => spread.placeOf(p).key && spread.placeOf(p).key === spread.placeOf(c).key)));
    // A country the region does not have yet first.
    pool.sort((a, b) => (spread.placeOf(a).country === country) - (spread.placeOf(b).country === country));
    for (const c of pool) {
      if (probes >= PROBES_PER_TICK) return 0;
      probes += 1;
      probedAt.set(c.address, now);
      const { addr, port } = manualPeer.resolveHostPort(c.address);
      // eslint-disable-next-line no-await-in-loop
      const ms = await manualPeer.probeTime(addr, port);
      if (ms == null || ms / 2 >= holder.minPingMs * TRIAL_PING_FACTOR) continue;
      const note = `trial in ${spread.REGION_NAMES[region]}: ${spread.describe(c)} answered in ~${Math.round(ms / 2)} ms,`
        + ` the holder pings ${Math.round(holder.minPingMs)} ms and was first for none of ${holder.recentEligible} recent blocks`;
      // eslint-disable-next-line no-await-in-loop
      if (await place(c, { replace: holder }, note)) return 1;
    }
  }
  return 0;
}

function resetForTests() {
  probedAt.clear();
  book = null;
}

module.exports = { fillFromAddressBook, trialInRegion, resetForTests };
