'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { otherChainOf } = require('../src/lib/queries/ranking-row');

test('a fork bit alone marks another chain', () => {
  assert.equal(otherChainOf('NETWORK,WITNESS,UNKNOWN[2^28]'), 'BLAKE2b fork');
  assert.equal(otherChainOf('NETWORK,UNKNOWN[2^27]'), 'BIP110 fork');
  assert.equal(otherChainOf('NETWORK,UNKNOWN[2^27],UNKNOWN[2^28]'), 'BLAKE2b fork');
  assert.equal(otherChainOf('NETWORK,UNKNOWN[2^26]'), null);
  assert.equal(otherChainOf(null), null);
});

test('headers at the tip say it follows this chain after all', () => {
  const bip110 = 'NETWORK,UNKNOWN[2^27]';
  assert.equal(otherChainOf(bip110, 972597, 972597), null);
  assert.equal(otherChainOf(bip110, 972591, 972597), null);
  assert.equal(otherChainOf(bip110, 972590, 972597), 'BIP110 fork');
  assert.equal(otherChainOf(bip110, 961170, 972597), 'BIP110 fork');
  // Not known yet, or no live tip to compare with: the bit decides.
  assert.equal(otherChainOf(bip110, -1, 972597), 'BIP110 fork');
  assert.equal(otherChainOf(bip110, null, 972597), 'BIP110 fork');
  assert.equal(otherChainOf(bip110, 972597, 0), 'BIP110 fork');
});
