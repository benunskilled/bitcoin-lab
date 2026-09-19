'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const poolId = require('../src/lib/pool-id');

const hex = (s) => Buffer.from(s, 'ascii').toString('hex');

test('a payout address identifies the pool', () => {
  const got = poolId.identify({ addresses: ['12KKDt4Mj7N5UAkQMN7LtPZMayenXHa8KL'] });
  assert.equal(got.name, 'Foundry USA');
  assert.equal(got.short, 'Foundry');
  assert.equal(got.source, 'address');
});

test('the coinbase text identifies the pool when no address matches', () => {
  const got = poolId.identify({
    coinbaseHex: hex('\u0003abcdef/Foundry USA Pool #dropgold/'),
    addresses: ['bc1qsomeaddressnobodyknows'],
  });
  assert.equal(got.name, 'Foundry USA');
  assert.equal(got.source, 'tag');
  assert.equal(got.tag, 'Foundry USA Pool');
});

// The address is where the reward actually went; the tag is text the miner
// typed. When they disagree, the money wins.
test('the address beats the tag', () => {
  const got = poolId.identify({
    coinbaseHex: hex('Mined by AntPool'),
    addresses: ['12KKDt4Mj7N5UAkQMN7LtPZMayenXHa8KL'],
  });
  assert.equal(got.name, 'Foundry USA');
  assert.equal(got.source, 'address');
});

test('an unknown miner is null, not a guess', () => {
  assert.equal(poolId.identify({ coinbaseHex: hex('hello world'), addresses: ['bc1qnope'] }), null);
  assert.equal(poolId.identify({}), null);
  assert.equal(poolId.identify({ coinbaseHex: 'not hex at all' }), null);
});

// Binary between two pieces of text must not join them into a tag that was
// never there: the height and the extranonce sit right next to the label.
test('binary bytes do not bridge two fragments', () => {
  const text = poolId.coinbaseText('466f756e647279' + 'ff00' + '555341');
  assert.equal(text.includes('FoundryUSA'), false);
  assert.match(text, /^Foundry\u0000\u0000USA$/);
});

test('short names drop a trailing filler word and nothing else', () => {
  assert.equal(poolId.shortName('Foundry USA'), 'Foundry');
  assert.equal(poolId.shortName('MARA Pool'), 'MARA');
  assert.equal(poolId.shortName('Braiins Pool'), 'Braiins');
  // One word, or a word that carries the name: untouched.
  assert.equal(poolId.shortName('F2Pool'), 'F2Pool');
  assert.equal(poolId.shortName('ViaBTC'), 'ViaBTC');
  assert.equal(poolId.shortName('SBI Crypto'), 'SBI Crypto');
  // A name nobody has heard of comes back as it went in.
  assert.equal(poolId.shortName('Some New Pool Nobody Lists'), 'Some New Pool Nobody Lists');
});

test('the embedded list is the real one', () => {
  const { addresses, tags } = poolId.size();
  assert.ok(addresses > 100, `only ${addresses} payout addresses`);
  assert.ok(tags > 100, `only ${tags} coinbase tags`);
  // The pools that find most blocks today have to be in there, or the column
  // will be empty on most blocks and nobody will notice why.
  for (const [address, name] of [
    ['12KKDt4Mj7N5UAkQMN7LtPZMayenXHa8KL', 'Foundry USA'],
  ]) {
    assert.equal(poolId.identify({ addresses: [address] }).name, name);
  }
  for (const [tag, name] of [
    ['Mined by AntPool', 'AntPool'],
    ['/ViaBTC/', 'ViaBTC'],
    ['OCEAN.XYZ', 'Ocean.xyz'],
  ]) {
    assert.equal(poolId.identify({ coinbaseHex: hex(tag) }).name, name);
  }
});

// A block from somebody the list has never heard of still says something:
// whatever the miner wrote into the coinbase himself, shown as raw text.
test('an unknown miner still leaves a readable label', () => {
  const hexOf = (s) => Buffer.from(s, 'ascii').toString('hex');
  // How a coinbase really looks: a length byte, the block height as binary,
  // then whatever the miner typed, then the extranonce.
  assert.equal(poolId.coinbaseLabel('03' + 'a1b2c3' + hexOf('/my-little-rig/') + 'ff00ff'), 'my-little-rig');
  // Height and extranonce on their own are numbers, not names.
  assert.equal(poolId.coinbaseLabel('03a1b2c3ff00ff'), null);
  assert.equal(poolId.coinbaseLabel(''), null);
  // The longest readable fragment wins, and it is capped.
  const long = 'x'.repeat(60);
  assert.equal(poolId.coinbaseLabel(hexOf(long)).length, 32);
});
