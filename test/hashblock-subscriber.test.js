'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { blockHashFromZmq } = require('../src/lib/hashblock-subscriber');

// The pair below is not invented. It was produced on 2026-09-02 by running the
// dev stack on regtest: test/regtest-generate.sh mined the block, and the
// relay profiler wrote the second string into relay_race.
const MINED = '01b72612e25c16c9dd3f260f02ff54e8e207ca44e1e320ab2986fa6a5621763c';
const RECORDED_BEFORE_THE_FIX = '3c7621566afa8629ab20e3e144ca07e2e854ff020f263fddc9165ce21226b701';

test('REGRESSION: the pubhashblock payload is already display order and must not be reversed', () => {
  // Core reverses the hash itself before publishing, so what arrives on the
  // wire is exactly the hex bitcoin-cli would print.
  const payload = Buffer.from(MINED, 'hex');

  assert.equal(blockHashFromZmq(payload), MINED);
});

test('REGRESSION: reversing a second time reproduces the hash the app used to store', () => {
  // Guards the fix from being "tidied" back into its old shape. Reversing here
  // is what the code did until v1.15.7, and this asserts what that cost: a hash
  // Core does not recognise, so getblockheader failed on every block and
  // block_height stayed NULL - while nothing crashed, because a backwards hash
  // is still a perfectly serviceable database key.
  const payload = Buffer.from(MINED, 'hex');
  const doubleReversed = Buffer.from(payload).reverse().toString('hex');

  assert.equal(doubleReversed, RECORDED_BEFORE_THE_FIX);
  assert.notEqual(doubleReversed, blockHashFromZmq(payload));
});

test('a real mainnet hash keeps its leading zeros, which is how the bug was visible', () => {
  // A display-order block hash starts with zeros. The stored ones ended with
  // them - the tell that the bytes were the wrong way round.
  const mainnetGenesis = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

  const out = blockHashFromZmq(Buffer.from(mainnetGenesis, 'hex'));

  assert.equal(out, mainnetGenesis);
  assert.ok(out.startsWith('00000000'), 'display order puts the zeros at the front');
});
