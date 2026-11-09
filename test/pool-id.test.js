'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const poolId = require('../src/lib/pool-id');

const hex = (s) => Buffer.from(s, 'ascii').toString('hex');

test('a payout address identifies the pool', () => {
  const got = poolId.identify({ addresses: ['12KKDt4Mj7N5UAkQMN7LtPZMayenXHa8KL'] });
  assert.equal(got.name, 'Foundry USA');
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

// Block 974982: F2Pool paid to an address the list does not know yet, and
// its only tag is the fish - outside ASCII, so it is matched as bytes.
test('a tag outside ASCII still identifies the pool', () => {
  const script = '0386e00e' + Buffer.from('🐟\t', 'utf8').toString('hex') + '0000';
  const hit = poolId.identify({ coinbaseHex: script, addresses: ['1K6KoYC69NnafWJ7YgtrpwJxBLiijWqwa6'] });
  assert.equal(hit.name, 'F2Pool');
  assert.equal(hit.tag, '🐟');
  assert.equal(poolId.identify({ coinbaseHex: Buffer.from('七彩神仙鱼', 'utf8').toString('hex') }).name, 'F2Pool');
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
  const long = 'x'.repeat(120);
  assert.equal(poolId.coinbaseLabel(hexOf(long)), `${'x'.repeat(100)}…`);
  // A UUID is an id, not a name, and the extranonce next to it can look like
  // text by chance (block 971531 carries "+VAR1").
  assert.equal(poolId.coinbaseLabel('036ae00e0417b0b2' + hexOf('j://85a2d481-1f50-45ce-be3d-a2c4d17cbeb8') + '003331b0'), null);
  assert.equal(poolId.coinbaseLabel('030bed0e04' + hexOf('j://e965ff8f-b25d-4e53-9429-c6bfefefc3cb') + '00' + hexOf('+VAR1') + '01'), null);
});

// Pools that run ckpool write "ckpool" too; their own tag has to win.
test('a ckpool-run pool is named by its own tag, not as CKPool', () => {
  const cases = {
    'ckpool /braiinssolo/': 'Braiins Solo',
    'ckpool /Mined by Satoshi Radio/': 'Satoshi Radio',
    'ckpool /pool.mutatrum.com/': 'mutatrum',
    'AtlasPool/FRA': 'AtlasPool',
    'eu/solo.ckpool.org/': 'Solo CK',
    'ckpool': 'CKPool',
  };
  for (const [text, name] of Object.entries(cases)) {
    assert.equal(poolId.identify({ coinbaseHex: hex('\u0003abc' + text) })?.name, name, text);
  }
});

// Checked on 9 November 2026: blocks the list had no name for.
test('F2Pool in lower case, and NiceHash by its payout addresses', () => {
  for (const text of ['/f2pool/m', '/f2pool.kz/c']) {
    const got = poolId.identify({ coinbaseHex: hex(`\u0003abc${text}\u0000\u0001`), addresses: ['1AfCc4F9c4VTYSE31PUe2kUEKs6ZxiDjxm'] });
    assert.equal(got.name, 'F2Pool', text);
    assert.equal(got.source, 'tag');
  }
  assert.equal(poolId.identify({ addresses: ['bc1q85z0lxe86pkcg2fmppfnykat2375s0pnxjx9sc'] }).name, 'NiceHash');
  assert.equal(poolId.identify({ addresses: ['bc1qevfvr7n7hqu56eu5cqunk22nuwds0dkjgqqxe6'] }).name, 'NiceHash');
  // EasyMining pays the finder first and keeps 3 % on its own address.
  const easy = poolId.identify({ addresses: ['bc1qx0wsjmspd3tmfsxyl7jftxyhapcrzmzn7t7g58', 'bc1q28d6w54p3xc03a2j5ppmkua09akep9vtke20ny'] });
  assert.deepEqual([easy.name, easy.source], ['NiceHash EasyMining', 'address']);
});
