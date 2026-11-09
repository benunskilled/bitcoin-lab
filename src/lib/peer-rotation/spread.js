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
 * from that, and every swap closes a connection Core may have picked as one
 * of its three high-bandwidth compact-block peers - a reconnect starts it over.
 *
 * So the slots are now spread: one per operator, and no more than
 * TARGET_PER_REGION in a region while another region has a candidate. Score
 * only decides between candidates for the same gap. A slot never stays empty
 * for the sake of the spread; a later candidate from a missing region takes it
 * over.
 *
 * Pure: plain rows in, an answer out. Region and operator come from
 * network.lookup, and a peer without them (Tor, I2P, an address the table does
 * not know) belongs to no region and conflicts with no operator.
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

// A manual peer the spread would rather give up: one in a region above the
// target, or one sharing its operator with another manual peer.
function surplus(trusted) {
  const counts = regionCounts(trusted);
  const keys = {};
  for (const p of trusted) {
    const k = placeOf(p).key;
    if (k) keys[k] = (keys[k] || 0) + 1;
  }
  return (p) => {
    const { region, key } = placeOf(p);
    return (region && counts[region] > TARGET_PER_REGION) || (key && keys[key] > 1);
  };
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
 * then a region Core's own outbound peers do not reach, then the score.
 * Candidates come in sorted by score already, so a stable sort on the first
 * three keeps that order within a gap.
 */
function rankForGap(candidates, trusted, coreRegions) {
  const counts = regionCounts(trusted);
  const held = countriesByRegion(trusted);
  const keyOf = (c) => {
    const { region, country } = placeOf(c);
    // A live candidate is one of Core's outbound peers itself, so its region
    // is reached by Core only if another of them is there too.
    const others = region ? (coreRegions[region] || 0) - (c.trusted || c.fromBook ? 0 : 1) : 0;
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
 *                           region is below the target and a holder is
 *                           surplus, or it brings a new country to a region
 *                           that holds two from one country
 *   null                    neither
 *
 * `evictable` are the holders that may lose their slot at all (no padlock, out
 * of their grace, not one of Core's high-bandwidth peers).
 */
function admit(peer, trusted, evictable, maxSlots) {
  const place = placeOf(peer);
  // One operator, one slot - in every case.
  if (place.key && trusted.some((p) => placeOf(p).key === place.key)) return null;
  if (trusted.length < maxSlots) return { free: true };
  if (!place.region) return null;
  const weakest = (list) => list.sort((a, b) => (a.score ?? -1) - (b.score ?? -1))[0] || null;
  if ((regionCounts(trusted)[place.region] || 0) < TARGET_PER_REGION) {
    // The weakest of the surplus, by the same score the ranking sorts on.
    const holder = weakest(evictable.filter(surplus(trusted)));
    return holder ? { replace: holder } : null;
  }
  // Its region is at the target. It still improves the spread if it brings a
  // country the region does not have, in place of one of two from the same
  // country there.
  if (!place.country) return null;
  const inRegion = trusted.filter((p) => placeOf(p).region === place.region);
  if (inRegion.some((p) => placeOf(p).country === place.country)) return null;
  const twice = (p) => inRegion.filter((q) => placeOf(q).country === placeOf(p).country).length > 1;
  const holder = weakest(evictable.filter((p) => placeOf(p).region === place.region && placeOf(p).country && twice(p)));
  return holder ? { replace: holder } : null;
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
