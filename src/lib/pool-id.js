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
 * (MIT), plus `mining-pools-extra.json`. See src/data/MINING-POOLS.md for the licence and how to refresh it.
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
// Tags and payout addresses the list above lacks, most of them pools that
// run ckpool and so also write "ckpool" into the coinbase: without their own
// tag they would all be CKPool. See src/data/MINING-POOLS.md for where each one comes from.
const extra = require('../data/mining-pools-extra.json');

const ADDRESSES = { ...(pools.payout_addresses || {}), ...(extra.payout_addresses || {}) };
const TAGS = { ...(pools.coinbase_tags || {}), ...(extra.coinbase_tags || {}) };

// Longest first: "Foundry USA Pool" has to win against any shorter tag that
// happens to sit inside the same coinbase.
const TAG_LIST = Object.keys(TAGS).sort((a, b) => b.length - a.length);
// Tags are matched as bytes against the raw script, not against
// coinbaseText(): a few are not ASCII - F2Pool's "🐟", "七彩神仙鱼" - and
// would never survive the printable-only text. For an ASCII tag it is the
// same match, since a tag's bytes cannot come out of a non-printable one.
const TAG_BYTES = TAG_LIST.map((tag) => [tag, Buffer.from(tag, 'utf8')]);

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
    if (hit) return { name: hit.name, source: 'address', tag: null };
  }
  if (typeof coinbaseHex !== 'string' || !/^[0-9a-fA-F]*$/.test(coinbaseHex) || coinbaseHex.length % 2 !== 0) return null;
  const script = Buffer.from(coinbaseHex, 'hex');
  for (const [tag, bytes] of TAG_BYTES) {
    if (script.includes(bytes)) {
      const hit = TAGS[tag];
      return { name: hit.name, source: 'tag', tag };
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
// Only a guard against a coinbase full of text: the page cuts the label to
// the space it has, so a whole one is shown wherever it fits.
const LABEL_MAX = 100;
// Some miners write a fresh UUID per block and no name at all ("://<uuid>",
// 118 blocks to one address since 873376). That is an id, not a label, and
// whatever else reads as text in such a coinbase - "+VAR1", "+S2F" - is
// extranonce bytes that look like letters by chance. So a UUID anywhere means
// no label at all.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function coinbaseLabel(hex) {
  const text = coinbaseText(hex);
  if (UUID.test(text)) return null;
  const parts = text
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
  const whole = best.replace(/^[\s/]+/, '').replace(/[\s/]+$/, '');
  // Cut, it says so.
  const trimmed = whole.length > LABEL_MAX ? `${whole.slice(0, LABEL_MAX).trim()}…` : whole;
  return trimmed.length >= LABEL_MIN ? trimmed : null;
}

/** What the embedded list holds, for the startup log line. */
function size() {
  return { addresses: Object.keys(ADDRESSES).length, tags: TAG_LIST.length };
}

module.exports = { identify, coinbaseText, coinbaseLabel, size };
