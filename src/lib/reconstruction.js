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
//   - "unclear": asked AND a whole block with no compact block - see classify
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
      subver: p.subver,
      connectionType: p.connection_type,
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
  // Some peers push whole blocks nobody asked for (seen: ViaBTC's relay, an
  // inbound /Satoshi:23.0.0/), and Core counts the bytes on receipt, before it
  // drops the block it already has (net.cpp CNode::ReceiveMsgBytes). So once a
  // compact block came in, a whole block does not count at all. Only counting
  // one from the peer that sent the compact block (where Core fetches it after
  // a failed rebuild, net_processing.cpp READ_STATUS_FAILED -> GETDATA to
  // pfrom) was not enough: block 975133 still read "full" with it.
  // Against Core's own cmpctblock log, 114 blocks from 8 to 9 November: 8
  // whole blocks beside a compact block, every one rebuilt without it, and
  // not one real full download. A failed rebuild now reads as "mempool" or
  // "asked" - rare - instead of a push reading as "full" - common.
  const compact = d.some((x) => x.cmpctblock > 0);
  const pushed = compact ? d.filter((x) => x.block > 0) : [];
  const whole = !compact && d.some((x) => x.block > 0);
  // Who sent the ignored whole blocks, so the log can show where they come
  // from. No address: the type of peer and its client are enough for that.
  const ignored = pushed.map((x) => ({ subver: x.subver, connectionType: x.connectionType, bytes: x.block }));
  const result = classifyCounters(asked, whole, d);
  if (result && ignored.length) result.ignoredWholeBlocks = ignored;
  return result;
}

function classifyCounters(asked, whole, d) {
  // Asked, and a whole block with no compact block beside it: the counters
  // cannot say whether the asking belongs to this block or the previous one,
  // whose answer can come in after that block's snapshot. Calling it "asked"
  // would put the previous block's bytes on this one, so it is neither.
  if (asked.length && whole) return { kind: 'unclear', missingBytes: null, askedPeers: asked.map((x) => x.addr) };
  if (asked.length) {
    // Core can ask more than one peer for the same missing transactions (one
    // per compact block in flight), and each answers with the same set: the
    // largest single answer is what was missing, a sum would count it twice.
    const missing = Math.max(...asked.map((x) => Math.max(0, x.blocktxn - HEADER_BYTES)));
    return { kind: 'asked', missingBytes: missing, askedPeers: asked.map((x) => x.addr) };
  }
  // With no compact block at all, a whole block is what Core downloaded.
  if (whole) return { kind: 'full', missingBytes: null, askedPeers: [] };
  if (d.some((x) => x.cmpctblock > 0)) return { kind: 'mempool', missingBytes: 0, askedPeers: [] };
  return null;
}

module.exports = { snapshot, classify, HEADER_BYTES };
