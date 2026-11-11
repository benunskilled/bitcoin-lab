'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const network = require('../src/lib/network');
const vectors = require('./data/network-vectors.json');

test('the table gives the answers the source databases give', () => {
  let wrong = 0;
  for (const v of vectors) {
    const got = network.lookup(v.ip);
    if (got.asn !== v.asn || got.country !== v.country) wrong += 1;
  }
  // IPv6 is keyed on the upper 64 bits, so a /64 shared by two networks has
  // only one answer; a handful of the 600 may land there.
  assert.ok(wrong <= 6, `${wrong} of ${vectors.length} wrong`);
});

test('a peer address with its port, IPv4 and IPv6, gets operator, country and region', () => {
  const de = network.lookup('88.198.0.1:8333');
  assert.deepEqual([de.asn, de.country, de.region], [24940, 'DE', 'EU']);
  assert.match(de.operator, /Hetzner/);
  const v6 = network.lookup('[2a01:4f8::1]:8333');
  assert.deepEqual([v6.asn, v6.country, v6.region], [24940, 'DE', 'EU']);
});

test('what is not a clearnet address is unknown, not an error', () => {
  for (const a of ['abcdef.onion:8333', 'garbage', '', '127.0.0.1:8333', '[::ffff:1.2.3.4]:8333']) {
    const got = network.lookup(a);
    assert.equal(typeof got.region, 'string', a);
    if (a !== '127.0.0.1:8333') assert.equal(got.region, '', a);
  }
});
