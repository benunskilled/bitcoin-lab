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
 * So the free slots are spread: one per operator, and a region with fewer
 * than TARGET_PER_REGION manual peers (the six continents, Tor and I2P) gets
 * the next free slot first. A slot no missing region can fill goes to anyone
 * the operator rule lets in. Nobody is ever moved out for the spread.
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

/**
 * How good a newcomer would be for the spread, lower is better: a region with
 * fewer manual peers first, then a country that region does not have yet,
 * then a region Core's own outbound peers do not reach. Within that, the
 * order they came in (fill.js shuffles the address book) - the sort is
 * stable.
 */
function rankForGap(candidates, trusted, coreRegions) {
  const counts = regionCounts(trusted);
  const held = countriesByRegion(trusted);
  const keyOf = (c) => {
    const { region, country } = placeOf(c);
    const others = region ? coreRegions[region] || 0 : 0;
    const knownCountry = region && country && held[region] && held[region].has(country) ? 1 : 0;
    return [region ? counts[region] || 0 : TARGET_PER_REGION, knownCountry, others > 0 ? 1 : 0];
  };
  return candidates
    .map((c, i) => ({ c, k: keyOf(c), i }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.i - b.i)
    .map((x) => x.c);
}

/**
 * Would this peer be let into a free manual slot? Only if one is free and its
 * operator is not in the set yet.
 */
function admit(peer, trusted, maxSlots) {
  const { key } = placeOf(peer);
  if (key && trusted.some((p) => placeOf(p).key === key)) return false;
  return trusted.length < maxSlots;
}

// For the log: "Asia (JP, Sakura Internet)".
function describe(peer) {
  const { region, country, operator } = placeOf(peer);
  const where = [country, operator].filter(Boolean).join(', ');
  return `${REGION_NAMES[region] || 'unknown region'}${where ? ` (${where})` : ''}`;
}

// How many of Core's own outbound peers (not the manual ones) sit in each region.
function coreRegionsOf(ranking) {
  return regionCounts(ranking.filter((p) => p.live && !p.trusted && p.direction === 'outbound'));
}

module.exports = {
  TARGET_PER_REGION, REGION_NAMES, PRIVATE_REGIONS, placeOf, regionCounts, rankForGap, admit, describe, coreRegionsOf, operatorKey,
};
