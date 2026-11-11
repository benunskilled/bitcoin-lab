'use strict';

/**
 * Where the slot fill finds its candidates: Core's own address book, and only
 * the part of it Core has connected to before.
 *
 * Core keeps the addresses it knows in two tables, "new" (heard of) and
 * "tried" (connected to at least once). getrawaddrman returns both separately;
 * from "tried" 40-76 % of Core's own connection attempts succeed, from "new"
 * 1-4 % (stratospher and Martin Zumsande, bnoc.xyz, 2026). An address only
 * gets into "tried" when Core itself has made an outbound connection to it,
 * so gossip alone cannot put one there.
 *
 * The "new" table only stands in for a region "tried" has nobody from
 * (10.11.2026): on a young node "tried" is small, and on a real one it held 9
 * addresses in Africa against 763 in "new". From "new" only what was passed
 * on in the last day, which is likelier to still be there; Core's trial
 * weeds out the rest (fill.js), and the spread lets no more than one peer per
 * region and provider in, so a flood of planted addresses wins one slot at
 * most.
 *
 * getrawaddrman is a hidden RPC and may change. When it does not answer, the
 * slot fill waits - it does not fall back to getnodeaddresses, which mixes
 * both tables, because that would quietly lower the bar a candidate has to
 * clear.
 *
 * Nothing here dials anyone. Whether a candidate works is for Core to find
 * out, through its own proxy settings and its own handshake (see fill.js).
 */

const net = require('net');
const rpc = require('../rpc');
const logger = require('../logger').make('peer-rotation');
const { formatAddress, hostFromAddress } = require('../address');

const NODE_NETWORK = 1;
const NODE_WITNESS = 8;
const NODE_NETWORK_LIMITED = 1024;
const BOOK_TTL_MS = 6 * 60 * 60 * 1000;
// Core's whole address book came to 13.8 MB on a real node (November 2026).
const BOOK_MAX_BYTES = 64 * 1024 * 1024;
const NETWORKS = ['ipv4', 'ipv6', 'onion', 'i2p'];
// How recently an address in "new" must have been passed on to be a candidate.
const NEW_FRESH_S = 24 * 60 * 60;

let book = null;

// A node that serves blocks and segwit: what Core asks of an automatic
// outbound peer, and what a manual one is held to here.
function servesBlocks(services) {
  const s = typeof services === 'string' ? parseInt(services, 16) : Number(services) || 0;
  return Boolean((s & NODE_WITNESS) && (s & (NODE_NETWORK | NODE_NETWORK_LIMITED)));
}

async function bookEntries(now = Date.now()) {
  if (book && now - book.at < BOOK_TTL_MS) return book.entries;
  let raw;
  try {
    raw = await rpc.call('getrawaddrman', [], { timeoutMs: 30000, maxBytes: BOOK_MAX_BYTES });
  } catch (err) {
    logger.warn('slot fill: getrawaddrman unavailable, nothing to fill from', { error: err.message });
    return [];
  }
  if (!raw || typeof raw.tried !== 'object') {
    logger.warn('slot fill: getrawaddrman gave no tried table, nothing to fill from');
    return [];
  }
  const usable = (e) => servesBlocks(e.services) && NETWORKS.includes(e.network);
  const entries = Object.values(raw.tried)
    .filter(usable)
    .map((e) => ({ address: formatAddress(e.address, e.port), network: e.network }));
  const fresh = Math.floor(now / 1000) - NEW_FRESH_S;
  for (const e of Object.values(raw.new && typeof raw.new === 'object' ? raw.new : {})) {
    if (usable(e) && Number(e.time) >= fresh) entries.push({ address: formatAddress(e.address, e.port), network: e.network, fromNew: true });
  }
  // An empty answer is most likely Core not being up yet: ask again next
  // tick rather than living on nothing for six hours.
  book = entries.length ? { at: now, entries } : null;
  return entries;
}

/**
 * The networks a candidate may come from: those Core may use (onlynet), and on
 * which it holds an outbound connection right now. The second half is what
 * the first cannot say. A node that may use IPv6 but sits in a container with
 * no IPv6 route reports it as reachable all the same; every IPv6 candidate
 * would then cost a trial that cannot succeed.
 */
function usableNetworks(networkInfo, peers) {
  const allowed = new Set(((networkInfo && networkInfo.networks) || []).filter((n) => n.reachable).map((n) => n.name));
  // Established outbound connections only: a feeler or an address fetch is a
  // few seconds' try, not proof the network works from here.
  const working = new Set(peers
    .filter((p) => ['outbound-full-relay', 'block-relay-only', 'manual'].includes(p.connection_type))
    .map((p) => p.network));
  return new Set(NETWORKS.filter((n) => allowed.has(n) && working.has(n)));
}

/**
 * Whether Core has banned an address. Core keeps its bans as subnets, and its
 * manual dial path does not look at them, so the slot fill has to. Null when
 * Core does not say - no answer about bans is no licence to ignore them.
 */
async function bannedMatcher() {
  let list;
  try {
    list = await rpc.call('listbanned');
  } catch (err) {
    logger.debug('slot fill: listbanned unavailable', { error: err.message });
    return null;
  }
  const blocks = new net.BlockList();
  const names = new Set();
  for (const { address } of list || []) {
    const [host, bits] = String(address).split('/');
    const family = net.isIPv4(host) ? 'ipv4' : net.isIPv6(host) ? 'ipv6' : null;
    if (!family) names.add(host.toLowerCase());
    else if (bits == null) blocks.addAddress(host, family);
    else blocks.addSubnet(host, Number(bits), family);
  }
  return (address) => {
    const host = hostFromAddress(address).replace(/^\[|\]$/g, '');
    if (net.isIPv4(host)) return blocks.check(host, 'ipv4');
    if (net.isIPv6(host)) return blocks.check(host, 'ipv6');
    return names.has(host.toLowerCase());
  };
}

function resetForTests() {
  book = null;
}

module.exports = { bookEntries, usableNetworks, bannedMatcher, servesBlocks, resetForTests };
