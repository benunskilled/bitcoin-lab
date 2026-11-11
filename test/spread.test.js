'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const spread = require('../src/lib/peer-rotation/spread');
const { weakestTrustedPeer } = require('../src/lib/queries/peers');

// place given directly, so no network table is needed: region, operator key.
const peer = (address, region, score, extra = {}) => ({ address, place: { region, key: address, operator: '', country: '' }, score, live: true, trusted: true, ...extra });

test('a hand-added peer pushes out one from its own region first, then from a region held twice', () => {
  const eu1 = peer('eu1', 'EU', 5);
  const eu2 = peer('eu2', 'EU', 9);
  const af = peer('af', 'AF', 0);
  const tor = peer('tor', 'TOR', 0);
  const trusted = [eu1, eu2, af, tor];
  // An Asian newcomer: no Asian peer to swap, so the doubled region loses its weaker peer, not Africa's weaker one.
  assert.equal(spread.leastMissed(peer('as', 'AS', 0), trusted, trusted, [], weakestTrustedPeer).address, 'eu1');
  // An African newcomer takes the African slot, keeping the spread as it was.
  assert.equal(spread.leastMissed(peer('af2', 'AF', 0), trusted, trusted, [], weakestTrustedPeer).address, 'af');
});

test('with every region held once, a region Core reaches anyway goes before the rest, Tor and I2P last', () => {
  const na = peer('na', 'NA', 9);
  const oc = peer('oc', 'OC', 0);
  const i2p = peer('i2p', 'I2P', -1);
  const trusted = [na, oc, i2p];
  const ranking = [...trusted, { address: 'core', place: { region: 'NA', key: 'x' }, live: true, trusted: false, direction: 'outbound' }];
  assert.equal(spread.leastMissed(peer('as', 'AS', 0), trusted, trusted, ranking, weakestTrustedPeer).address, 'na');
  assert.equal(spread.leastMissed(peer('as', 'AS', 0), [oc, i2p], trusted, ranking, weakestTrustedPeer).address, 'oc');
  assert.equal(spread.leastMissed(peer('as', 'AS', 0), [i2p], trusted, ranking, weakestTrustedPeer).address, 'i2p');
  assert.equal(spread.leastMissed(peer('as', 'AS', 0), [], trusted, ranking, weakestTrustedPeer), null);
});
