'use strict';

/**
 * A block has two identities in this app, and they are not the same string.
 *
 * Bitcoin Core reports a block hash the way everybody reads it. Stratum sends
 * the same hash inside `mining.notify` as the previous-block field of the new
 * job, and sends it the way mining software wants it: 32 bytes seen as eight
 * 4-byte words, with the bytes inside each word reversed. Some pools reverse
 * the word order on top of that, some send it plainly, and nothing in the
 * protocol says which - so the practical answer is to accept any of them.
 *
 * This produces the distinct encodings the same hash can appear in - four of
 * them, because reversing the bytes inside each word and then reversing all
 * 32 is the same operation as reversing the word order. A lookup tries them
 * all: four indexed reads on a unique column, and a wrong encoding colliding
 * with a real block hash is not a thing that happens to 32 random bytes.
 *
 * In practice one of the four does all the work. Checked against 200 of the
 * 524 races recorded on the node this app is built against: 200 of 200 found
 * their block, every one through the word order reversed and the bytes inside
 * the words untouched. The other three cost nothing and stay for pools that
 * do it differently.
 *
 * Nothing here decides which encoding is right. It only makes sure a race and
 * a block that belong together find each other.
 */

const HASH_BYTES = 32;

function encodings(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) return [];
  const b = Buffer.from(hex.toLowerCase(), 'hex');
  if (b.length !== HASH_BYTES) return [];

  const wordsSwapped = Buffer.from(b);
  for (let i = 0; i < HASH_BYTES; i += 4) wordsSwapped.subarray(i, i + 4).reverse();

  const words = [];
  for (let i = 0; i < HASH_BYTES; i += 4) words.push(Buffer.from(b.subarray(i, i + 4)));
  const wordOrderReversed = Buffer.concat([...words].reverse());

  const out = [
    b.toString('hex'),
    Buffer.from(b).reverse().toString('hex'),
    wordsSwapped.toString('hex'),
    wordOrderReversed.toString('hex'),
    Buffer.from(wordsSwapped).reverse().toString('hex'),
  ];
  return [...new Set(out)];
}

module.exports = { encodings };
