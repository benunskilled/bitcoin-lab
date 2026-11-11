'use strict';

/**
 * Where the manual peers are, and whether a peer would make that spread better.
 *
 * The rotation used to fill the eight manual slots with whoever delivered
 * blocks first most often. On a real node that was 7 of 8 in Europe, and its
 * own data showed no gain in time for it: from 7 October to 9 November 2026,
 * blocks a manual peer delivered first reached the node 119 ms (median) after
 * the first pool job, blocks an inbound peer delivered first 122 ms. Nor did
 * any study measure one on mainnet. What the slots can do is reach parts of
 * the network Core's own connections do not: Core spreads its automatic
 * outbound peers over network groups, but addnode connections are exempt
 * from that.
 *
 * So the free slots are spread, and counted over all of the node's outbound
 * connections, Core's own and the manual ones (10.11.2026: a manual peer in
 * Europe beside Core's five there added nothing). The region with the fewest
 * of them (the six continents, Tor and I2P) gets the next free slot, and no
 * operator Core or a manual peer already uses gets in again. A slot no
 * missing region can fill goes to anyone the operator rule lets in. Nobody
 * is ever moved out for the spread.
 *
 * Pure: plain rows in, an answer out. Region and operator come from
 * network.lookup; Tor and I2P are regions of their own with no operator, and
 * an address the table does not know belongs to no region and conflicts with
 * no operator.
 */

const config = require('../config');
const network = require('../network');
const { unreachableNetwork } = require('../address');

const TARGET_PER_REGION = config.manualPerRegion;

// Tor and I2P count as regions of their own: a path that runs through
// neither your provider nor any continent's routing is the most different
// one there is. Core dials them through its own proxy; their operator and
// country are unknowable, so they never conflict on either.
const REGION_NAMES = {
  AF: 'Africa', AS: 'Asia', EU: 'Europe', NA: 'North America', OC: 'Oceania', SA: 'South America', TOR: 'Tor', I2P: 'I2P',
};
const PRIVATE_REGIONS = { Tor: 'TOR', I2P: 'I2P' };

// One spelling per operator. The name, not the AS number: one company often
// announces several (Hetzner's ranges sit under one name), and two numbers of
// one operator are no spread.
function operatorKey(place) {
  if (place.operator) return place.operator.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return place.asn ? `as${place.asn}` : '';
}

function placeOf(peer) {
  if (peer.place) return peer.place;
  const hidden = PRIVATE_REGIONS[unreachableNetwork(peer.address)];
  if (hidden) return { asn: 0, operator: '', country: '', region: hidden, key: '' };
  const place = network.lookup(peer.address);
  return { ...place, key: operatorKey(place) };
}

function regionCounts(peers) {
  const counts = {};
  for (const p of peers) {
    const r = placeOf(p).region;
    if (r) counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
}

// The countries the manual peers already hold, per region.
function countriesByRegion(peers) {
  const out = {};
  for (const p of peers) {
    const { region, country } = placeOf(p);
    if (region && country) (out[region] = out[region] || new Set()).add(country);
  }
  return out;
}

// Outbound connections per region, Core's own and the manual ones together.
function totalCounts(trusted, coreRegions) {
  const counts = { ...coreRegions };
  for (const [r, n] of Object.entries(regionCounts(trusted))) counts[r] = (counts[r] || 0) + n;
  return counts;
}

/**
 * How good a newcomer would be for the spread, lower is better: a region with
 * fewer outbound connections first, Core's and the manual ones counted
 * together, then a country the manual peers do not have yet. Within that, the
 * order they came in (fill.js shuffles the address book) - the sort is
 * stable.
 */
function rankForGap(candidates, trusted, coreRegions) {
  const counts = totalCounts(trusted, coreRegions);
  const held = countriesByRegion(trusted);
  const keyOf = (c) => {
    const { region, country } = placeOf(c);
    const knownCountry = region && country && held[region] && held[region].has(country) ? 1 : 0;
    return [region ? counts[region] || 0 : Infinity, knownCountry];
  };
  return candidates
    .map((c, i) => ({ c, k: keyOf(c), i }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i)
    .map((x) => x.c);
}

/**
 * Would this peer be let into a free manual slot? Only if one is free and its
 * operator is neither in the manual set nor among Core's own outbound peers
 * (coreKeys, from coreOperatorsOf).
 */
function admit(peer, trusted, maxSlots, coreKeys = new Set()) {
  const { key } = placeOf(peer);
  if (key && (coreKeys.has(key) || trusted.some((p) => placeOf(p).key === key))) return false;
  return trusted.length < maxSlots;
}

// For the log: "Asia (JP, Sakura Internet)".
function describe(peer) {
  const { region, country, operator } = placeOf(peer);
  const where = [country, operator].filter(Boolean).join(', ');
  return `${REGION_NAMES[region] || 'unknown region'}${where ? ` (${where})` : ''}`;
}

const coreOutbound = (ranking) => ranking.filter((p) => p.live && !p.trusted && p.direction === 'outbound');

// How many of Core's own outbound peers (not the manual ones) sit in each region.
function coreRegionsOf(ranking) {
  return regionCounts(coreOutbound(ranking));
}

// The operators Core's own outbound peers are with.
function coreOperatorsOf(ranking) {
  return new Set(coreOutbound(ranking).map((p) => placeOf(p).key).filter(Boolean));
}

/**
 * Which manual peer a newcomer added by hand pushes out when all eight are
 * taken: the one the spread misses least (10.11.2026: "Add as Manual" must
 * always work, but it took the weakest anywhere - often the one peer in
 * Africa or Oceania the slot fill had found). In order, among the peers that
 * may go at all: one from the newcomer's own region, so the spread stays as
 * it was; one from a region the node reaches more than once, Core's own
 * peers counted too, the fullest first; any other; Tor and I2P last. Within
 * a step, the weakest (weakest()), as before.
 */
function leastMissed(newcomer, evictable, trusted, ranking, weakest) {
  if (!evictable.length) return null;
  const mine = placeOf(newcomer).region;
  const counts = totalCounts(trusted, coreRegionsOf(ranking));
  const step = (p) => {
    const { region } = placeOf(p);
    if (region && region === mine) return [0, 0];
    if (region && counts[region] > 1) return [1, -counts[region]];
    if (region === 'TOR' || region === 'I2P') return [3, 0];
    return [2, 0];
  };
  const best = evictable.map(step).reduce((a, b) => (b[0] < a[0] || (b[0] === a[0] && b[1] < a[1]) ? b : a));
  return weakest(evictable.filter((p) => {
    const s = step(p);
    return s[0] === best[0] && s[1] === best[1];
  }));
}

module.exports = {
  TARGET_PER_REGION, REGION_NAMES, placeOf, regionCounts, totalCounts, rankForGap, admit, describe, coreRegionsOf,
  coreOperatorsOf, leastMissed,
};
