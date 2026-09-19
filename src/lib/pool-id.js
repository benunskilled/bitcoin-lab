'use strict';

/**
 * Who mined a block, read off the block itself.
 *
 * Every block's coinbase transaction carries two things a pool leaves behind
 * without meaning to be identified: the address its reward is paid to, and a
 * short text in the input script - "Foundry USA Pool", "Mined by AntPool".
 * Matching either against a public list is how block explorers attribute
 * blocks, and it is the only way to do it without asking a service.
 *
 * The list is `src/data/mining-pools.json` from bitcoin-data/mining-pools
 * (MIT). See src/data/MINING-POOLS.md for the licence and how to refresh it.
 *
 * Two honest limits. The payout address is checked first because it is the
 * stronger claim - it is where the money actually went - but a pool that pays
 * through a third party will not match it. The tag is just text the miner
 * writes: nobody has a reason to lie about it, and it is still a claim rather
 * than a measurement, the same distinction Peer Map draws for a peer's user
 * agent. An unknown miner returns null and is displayed as nothing at all,
 * which is the truthful answer.
 */

const pools = require('../data/mining-pools.json');

const ADDRESSES = pools.payout_addresses || {};
const TAGS = pools.coinbase_tags || {};

// Longest first: "Foundry USA Pool" has to win against any shorter tag that
// happens to sit inside the same coinbase.
const TAG_LIST = Object.keys(TAGS).sort((a, b) => b.length - a.length);

// A display name is the pool's full name minus a trailing word that carries no
// information - "Foundry USA" is Foundry, "MARA Pool" is MARA. Only a separate
// trailing word is dropped, so Poolin and F2Pool keep every letter, and only
// when the result is still unique across the whole list: two pools that would
// collapse into the same short name keep their full ones.
const DROPPABLE = new Set(['Pool', 'USA']);

function trimName(name) {
  const parts = name.split(' ');
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1];
  if (!DROPPABLE.has(last)) return name;
  const shorter = parts.slice(0, -1).join(' ');
  return shorter.length >= 3 ? shorter : name;
}

const SHORT = (() => {
  const names = new Set();
  for (const v of Object.values(TAGS)) names.add(v.name);
  for (const v of Object.values(ADDRESSES)) names.add(v.name);

  const wanted = new Map();
  const count = new Map();
  for (const name of names) {
    const short = trimName(name);
    wanted.set(name, short);
    count.set(short, (count.get(short) || 0) + 1);
  }
  const out = new Map();
  for (const [name, short] of wanted) {
    out.set(name, count.get(short) === 1 ? short : name);
  }
  return out;
})();

/** The pool's short display name; the full name when shortening it would not be unique. */
function shortName(name) {
  return SHORT.get(name) || name;
}

/**
 * The printable text inside a coinbase input script. Non-printable bytes
 * become a NUL rather than disappearing, so two fragments of text either side
 * of binary data cannot accidentally join into a tag that is not there.
 */
function coinbaseText(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return '';
  const buf = Buffer.from(hex, 'hex');
  let out = '';
  for (const b of buf) out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '\u0000';
  return out;
}

/**
 * Identify the pool behind a coinbase transaction.
 *
 * `addresses` are the coinbase outputs' addresses, `coinbaseHex` the input
 * script. Returns null when neither matches - an unknown pool, a solo miner,
 * or a pool the list has not caught up with.
 */
function identify({ coinbaseHex = '', addresses = [] } = {}) {
  for (const address of addresses) {
    const hit = ADDRESSES[address];
    if (hit) return { name: hit.name, short: shortName(hit.name), source: 'address', tag: null };
  }
  const text = coinbaseText(coinbaseHex);
  if (text) {
    for (const tag of TAG_LIST) {
      if (text.includes(tag)) {
        const hit = TAGS[tag];
        return { name: hit.name, short: shortName(hit.name), source: 'tag', tag };
      }
    }
  }
  return null;
}

// Most blocks come from a handful of pools, but not all of them do, and a
// one-off finder is exactly the kind of block worth seeing. So when the list
// has no answer, fall back to what the miner wrote into the coinbase himself:
// the longest readable fragment in it. That is raw text and gets shown as
// such, never as a pool name - it is neither verified nor unique.
const LABEL_MIN = 4;
const LABEL_MAX = 32;

function coinbaseLabel(hex) {
  const parts = coinbaseText(hex)
    .split('\u0000')
    .map((s) => s.trim())
    .filter(Boolean);
  let best = null;
  for (const part of parts) {
    if (part.length < LABEL_MIN) continue;
    // Numbers alone are the block height and the extranonce, not a name.
    if (!/[A-Za-z]/.test(part)) continue;
    if (!best || part.length > best.length) best = part;
  }
  if (!best) return null;
  const trimmed = best.replace(/^[\s/]+/, '').replace(/[\s/]+$/, '').slice(0, LABEL_MAX).trim();
  return trimmed.length >= LABEL_MIN ? trimmed : null;
}

/** What the embedded list holds, for the startup log line. */
function size() {
  return { addresses: Object.keys(ADDRESSES).length, tags: TAG_LIST.length };
}

module.exports = { identify, shortName, coinbaseText, coinbaseLabel, size };
