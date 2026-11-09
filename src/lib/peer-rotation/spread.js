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
 * So the slots are spread: one per operator, and TARGET_PER_REGION per region
 * (the six continents, Tor and I2P). A peer leaves only for a region that has
 * fewer than that, and only from a region that has more. Score only decides
 * between candidates for the same gap and which surplus peer goes. A free slot
 * goes to anyone the spread lets in, once no gap can be filled.
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
 * order they came in (fill.js: parked peers first, then the address book
 * shuffled) - the sort is stable.
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
 * Would this peer be let into the manual set, and in place of whom?
 *
 *   { free: true }          a slot is free and its operator is not there yet
 *   { replace: holder }     the set is full and the peer fills a gap: its
 *                           region is below the target, the holder's is
 *                           above it
 *   null                    neither
 *
 * A new country is no reason for a swap on its own: within a region that is
 * over its target, as Europe often is, it only trades one surplus peer for
 * another and costs a connection Core may have picked as a high-bandwidth
 * peer. It decides between candidates for a gap instead (rankForGap).
 *
 * `evictable` are the holders that may lose their slot at all (no padlock, out
 * of their grace, not one of Core's high-bandwidth peers - fill.js asks Core
 * about that last one at the moment of the swap).
 */
function admit(peer, trusted, evictable, maxSlots) {
  const place = placeOf(peer);
  // One operator, one slot - in every case.
  if (place.key && trusted.some((p) => placeOf(p).key === place.key)) return null;
  if (trusted.length < maxSlots) return { free: true };
  if (!place.region) return null;
  const counts = regionCounts(trusted);
  const weakest = (list) => list.sort((a, b) => (a.score ?? -1) - (b.score ?? -1))[0] || null;
  if ((counts[place.region] || 0) < TARGET_PER_REGION) {
    // The weakest of those whose region holds more than its target, by the
    // same score the ranking sorts on - so a swap never empties one region to
    // fill another. A peer that shares its operator with another but is
    // alone in its region stays: trading one gap for another is no spread.
    const crowded = (p) => counts[placeOf(p).region] > TARGET_PER_REGION;
    const holder = weakest(evictable.filter(crowded));
    return holder ? { replace: holder } : null;
  }
  return null;
}

// For the log: "Asia (JP, Sakura Internet)".
function describe(peer) {
  const { region, country, operator } = placeOf(peer);
  const where = [country, operator].filter(Boolean).join(', ');
  return `${REGION_NAMES[region] || 'unknown region'}${where ? ` (${where})` : ''}`;
}

// For the log, and why: "Asia (JP, Sakura Internet) in for Europe (DE,
// Hetzner Online GmbH): Asia had none". `trusted` is the set before the swap.
function swapNote(peer, holder, trusted) {
  const { region } = placeOf(peer);
  const n = regionCounts(trusted)[region] || 0;
  return `${describe(peer)} in for ${describe(holder)}: ${REGION_NAMES[region]} had ${n ? `only ${n}` : 'none'}`;
}

// How many of Core's own outbound peers (not the manual ones) sit in each region.
function coreRegionsOf(ranking) {
  return regionCounts(ranking.filter((p) => p.live && !p.trusted && p.direction === 'outbound'));
}

module.exports = {
  TARGET_PER_REGION, REGION_NAMES, PRIVATE_REGIONS, placeOf, regionCounts, rankForGap, admit, describe, swapNote, coreRegionsOf, operatorKey,
};
