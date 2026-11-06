'use strict';

// How a block was put together on this node, read from getpeerinfo alone.
//
// A compact block (BIP152) names its transactions by short ids, and Core
// rebuilds it from its own mempool. Whatever it does not have it asks the
// sender for with getblocktxn, and waits a round trip for the blocktxn
// answer - on 0xB10C's monitoring nodes 95 to 99 % of blocks needed that from
// mid-July to mid-October 2026, and a few tens of percent before and after.
// Core counts the bytes of every message it sends and receives per peer
// (bytessent_per_msg, bytesrecv_per_msg), and Bitcoin Lab already takes one
// getpeerinfo snapshot at every block. Comparing it with the one before tells
// what happened in between, without a single extra call to Core:
//   - "mempool": a compact block came in and nothing was asked for
//   - "asked":   getblocktxn went out; missingBytes is what came back
//   - "full":    no compact block, the whole block was downloaded instead
// null when it cannot be told: no snapshot of the previous block (a block was
// skipped, getpeerinfo failed at the start), or nothing arrived at all.
// The app takes one snapshot when it starts, so the first block is told too.

// A message header (magic, command, length, checksum) is counted in the
// bytes too; one blocktxn answer is one header.
const HEADER_BYTES = 24;

const sent = (p, m) => (p.bytessent_per_msg && p.bytessent_per_msg[m]) || 0;
const recv = (p, m) => (p.bytesrecv_per_msg && p.bytesrecv_per_msg[m]) || 0;

// Only what the comparison needs, keyed by Core's connection id: a peer that
// left and came back is a new connection with counters from zero.
function snapshot(peers, atMs) {
  const byId = new Map();
  for (const p of peers || []) {
    if (p.id == null) continue;
    byId.set(p.id, {
      getblocktxn: sent(p, 'getblocktxn'),
      blocktxn: recv(p, 'blocktxn'),
      cmpctblock: recv(p, 'cmpctblock'),
      block: recv(p, 'block'),
    });
  }
  return { atMs, byId };
}

// The growth of each counter since `before`. A connection opened after the
// previous snapshot counts from zero; one older than that but missing from it
// is unknown and left out.
function deltas(before, peers) {
  const out = [];
  for (const p of peers || []) {
    if (p.id == null) continue;
    let base = before.byId.get(p.id);
    if (!base) {
      if (p.conntime == null || p.conntime * 1000 < before.atMs) continue;
      base = { getblocktxn: 0, blocktxn: 0, cmpctblock: 0, block: 0 };
    }
    out.push({
      addr: p.addr,
      getblocktxn: sent(p, 'getblocktxn') - base.getblocktxn,
      blocktxn: recv(p, 'blocktxn') - base.blocktxn,
      cmpctblock: recv(p, 'cmpctblock') - base.cmpctblock,
      block: recv(p, 'block') - base.block,
    });
  }
  return out;
}

function classify(before, peers) {
  if (!before) return null;
  const d = deltas(before, peers);
  const asked = d.filter((x) => x.getblocktxn > 0);
  if (asked.length) {
    const missing = asked.reduce((sum, x) => sum + Math.max(0, x.blocktxn - HEADER_BYTES), 0);
    return { kind: 'asked', missingBytes: missing, askedPeers: asked.map((x) => x.addr) };
  }
  if (d.some((x) => x.cmpctblock > 0)) return { kind: 'mempool', missingBytes: 0, askedPeers: [] };
  if (d.some((x) => x.block > 0)) return { kind: 'full', missingBytes: null, askedPeers: [] };
  return null;
}

module.exports = { snapshot, classify, HEADER_BYTES };
