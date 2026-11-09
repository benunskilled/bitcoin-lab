'use strict';

/**
 * Whose network an address is in, and where: the operator (AS number and
 * name), the country and the region - the continent that country is on.
 *
 * The rotation spreads the manual peers over operators and regions, so it has
 * to answer this for any peer, offline and without asking a service. The
 * table is src/data/network.bin, built by scripts/gennet.py from DB-IP's Lite
 * databases (CC BY 4.0); see src/data/NETWORK.md. It is read once and searched
 * in place: two binary searches per lookup, nothing decoded but the names.
 *
 * Only clearnet addresses have an answer. Tor, I2P and CJDNS peers, local
 * addresses and anything unparseable come back as unknown; the rotation gives
 * Tor and I2P regions of their own (peer-rotation/spread.js).
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { hostFromAddress } = require('./address');

const REGIONS = ['', 'AF', 'AS', 'EU', 'NA', 'OC', 'SA'];
const UNKNOWN = Object.freeze({ asn: 0, operator: '', country: '', region: '' });

let table = null;

function load() {
  if (table) return table;
  const b = fs.readFileSync(path.join(__dirname, '..', 'data', 'network.bin'));
  if (b.toString('latin1', 0, 6) !== 'BLNET1') throw new Error('network.bin: not a BLNET1 table');
  let o = 6;
  const nAs = b.readUInt32BE(o); o += 4;
  const operators = new Array(nAs);
  for (let i = 0; i < nAs; i++) {
    const num = b.readUInt32BE(o); const len = b[o + 4];
    operators[i] = { asn: num, name: b.toString('utf8', o + 5, o + 5 + len) };
    o += 5 + len;
  }
  const block = (startBytes, idxBytes) => {
    const n = b.readUInt32BE(o); o += 4;
    const starts = o; o += n * startBytes;
    const idx = o; o += n * idxBytes;
    return { n, starts, idx, startBytes, idxBytes };
  };
  const a4 = block(4, 4);
  const a6 = block(8, 4);
  const nCc = b.readUInt16BE(o); o += 2;
  const countries = new Array(nCc);
  for (let i = 0; i < nCc; i++) {
    const code = b.toString('latin1', o, o + 2);
    countries[i] = { code: code === '\0\0' ? '' : code, region: REGIONS[b[o + 2]] || '' };
    o += 3;
  }
  const c4 = block(4, 2);
  const c6 = block(8, 2);
  table = { b, operators, countries, a4, a6, c4, c6 };
  return table;
}

// The index of the last range starting at or below key, or -1.
function search(b, blk, key) {
  let lo = 0;
  let hi = blk.n - 1;
  let found = -1;
  const at = blk.startBytes === 4
    ? (i) => BigInt(b.readUInt32BE(blk.starts + i * 4))
    : (i) => b.readBigUInt64BE(blk.starts + i * 8);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid) <= key) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return 0;
  return blk.idxBytes === 4 ? b.readUInt32BE(blk.idx + found * 4) : b.readUInt16BE(blk.idx + found * 2);
}

// IPv4 as a 32-bit number, IPv6 as its upper 64 bits - the keys of the table.
function keyOf(ip) {
  if (net.isIPv4(ip)) return { v6: false, key: BigInt(ip.split('.').reduce((n, x) => n * 256 + Number(x), 0)) };
  if (!net.isIPv6(ip)) return null;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  if (t.length && t[t.length - 1].includes('.')) return null; // IPv4-mapped: not a peer address here
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  const key = groups.slice(0, 4).reduce((n, g) => (n << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
  return { v6: true, key };
}

/**
 * Operator and place of a peer address ("1.2.3.4:8333", "[2001:db8::1]:8333")
 * or a bare IP. Unknown fields are empty strings, never null.
 */
function lookup(address) {
  const host = hostFromAddress(String(address || '')).replace(/^\[|\]$/g, '');
  const k = keyOf(host);
  if (!k) return UNKNOWN;
  const t = load();
  const op = t.operators[search(t.b, k.v6 ? t.a6 : t.a4, k.key)] || t.operators[0];
  const cc = t.countries[search(t.b, k.v6 ? t.c6 : t.c4, k.key)] || t.countries[0];
  return { asn: op.asn, operator: op.name, country: cc.code, region: cc.region };
}

module.exports = { lookup };
