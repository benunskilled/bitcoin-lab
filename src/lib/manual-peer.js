'use strict';

const net = require('net');
const crypto = require('crypto');
const config = require('./config');
const peerSync = require('./peer-sync');
const { isValidPort } = require('./validate');
// Address parsing/formatting lives in one module - see address.js for why.
const { resolveHostPort, formatAddress, hostFromAddress } = require('./address');
const logger = require('./logger').make('manual-peer');
const { logAction } = require('./peer-rotation/log');
const spread = require('./peer-rotation/spread');

// The first four bytes of every P2P message, per chain. A node that is on
// another chain answers with other bytes, which is as useless as no answer.
const MAGIC = {
  mainnet: 'f9beb4d9',
  testnet: '0b110907',
  testnet4: '1c163f28',
  signet: '0a03cf40',
  regtest: 'fabfb5da',
};

const sha256d = (buf) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();

// A bare version message: no services, empty user agent, height 0, no tx
// relay. Enough for a node to answer with its own version, and nothing more.
function versionMessage(magic) {
  const payload = Buffer.alloc(86);
  payload.writeInt32LE(70016, 0);
  payload.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 12);
  // addr_recv and addr_from stay zero: services 0, address ::, port 0.
  crypto.randomBytes(8).copy(payload, 72);
  // user agent length 0 at 80, start height 0 at 81, relay 0 at 85.
  const header = Buffer.alloc(24);
  Buffer.from(magic, 'hex').copy(header, 0);
  header.write('version', 4, 'ascii');
  header.writeUInt32LE(payload.length, 16);
  sha256d(payload).copy(header, 20, 0, 4);
  return Buffer.concat([header, payload]);
}

/**
 * True only if a Bitcoin node on this chain answers here. An open port is not
 * enough: a web server or anything else listening on 8333 accepted the TCP
 * connection and used to count as a node. So this sends a version message and
 * waits for the first message header back: the chain's magic bytes and
 * "version". The handshake is never finished, the connection closes there.
 *
 * Only ever for an address a person typed in or picked: it goes out from this
 * container, not through Core's proxy. The slot fill never probes; it lets
 * Core connect (peer-rotation/fill.js).
 */
function probePort(host, port, timeoutMs = 3000) {
  const magic = MAGIC[config.bitcoin.network] || MAGIC.mainnet;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    let got = Buffer.alloc(0);
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.write(versionMessage(magic)));
    socket.on('data', (chunk) => {
      got = Buffer.concat([got, chunk]);
      if (got.length < 16) return;
      done(got.subarray(0, 4).toString('hex') === magic && got.subarray(4, 16).equals(Buffer.from('version\0\0\0\0\0', 'ascii')));
    });
    socket.once('end', () => done(false));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// Bare-bones sanity check - real validation happens by probing the
// address itself; this just rejects obvious junk input. Brackets are
// allowed so bracketed IPv6 input ("[2001:db8::1]:8333") isn't rejected
// outright - see resolveHostPort below for why that notation matters.
function looksLikeHost(input) {
  return typeof input === 'string' && /^[a-zA-Z0-9.:\-[\]]{3,255}$/.test(input.trim());
}

/**
 * Manual "add peer by IP" flow - used both by the free-text IP field and by
 * "Add as Manual" on an existing peer row. The caller supplies a bare host
 * (no port); we probe the standard Bitcoin P2P port first, then the
 * configured fallback, and only persist + `addnode` whichever actually
 * answers as a Bitcoin node (see probePort). This is deliberate even for peers we already see
 * connected: an inbound peer's getpeerinfo address is its ephemeral
 * *outbound source* port, not the port its node listens on for incoming P2P
 * connections, so that port is useless for `addnode` - we always re-derive
 * the real listening port ourselves rather than trust whatever port we
 * happened to observe the peer on.
 *
 * Nothing is written and no existing connection is touched until that
 * handshake has succeeded and a manual slot is confirmed available - see
 * peerSync.addTrustedPeer, which owns that order. Trying an inbound peer to
 * see whether it can be promoted is therefore free: if it does not listen,
 * the attempt costs nothing at all.
 *
 * A successful add is persisted to trusted_peer (not just a one-off addnode
 * RPC call), so it survives container restarts/updates via
 * peer-sync.syncTrustedToAddnode() the same way peers trusted from the
 * dashboard do.
 */
async function manualAddPeer(rawInput, label, { kept = false } = {}) {
  const probed = await probePeer(rawInput);
  if (!probed.ok) return probed;

  // Asked for by hand, so it outranks whatever is currently weakest: at
  // capacity, free a slot rather than writing a ninth row Core will never be
  // told about. The response names what was dropped - a silent eviction of a
  // peer the user spent days earning would be far worse than a refusal.
  //
  // The star is NOT part of that, and is off unless the caller asks. Typing an
  // address into the box is a choice about a peer this node may never have
  // seen, so it is protected until you look at it. Clicking the button beside
  // a peer already in the ranking is a different act: that peer is there
  // because the app measured it, and picking one out of the list is the same
  // judgement the rotation makes, only by hand. Starring it would take that
  // peer out of the pool the rotation draws from - which matters most for the
  // ordinary outbound peers, since they ARE the pool. Eight stars and the loop
  // has nothing left to promote.
  //
  // This used to be hardcoded true with a comment claiming every path here was
  // someone typing an address. It was not: the button on each row comes
  // through the same function.
  const result = await peerSync.addTrustedPeer(probed.address, label, { evictToFit: true, kept });
  if (!result.ok) {
    return { ok: false, address: probed.address, error: result.error };
  }
  logger.info('manually added peer', { address: probed.address, evicted: result.evicted?.address || null });
  // In the rotation log too, every time: a hand-made choice belongs next to
  // the rotation's own, and a peer that lost its slot to one should not
  // vanish without a trace.
  // The peer is in by now: a busy database must not turn that into an error
  // the user would retry, displacing a second peer.
  try {
    logAction({
      action: 'manual',
      address: probed.address,
      replacedAddress: result.evicted?.address,
      replacedFirstPct: result.evicted?.firstPct,
      // Where the slot came from: the spread decides which peer goes
      // (spread.leastMissed), so the region says more than "the weakest".
      note: result.evicted ? `replaced one in ${spread.REGION_NAMES[spread.placeOf(result.evicted).region] || 'an unknown region'}` : null,
    });
  } catch (err) {
    logger.warn('rotation log entry for a manual add failed', { address: probed.address, error: err.message });
  }
  return { ok: true, address: probed.address, ...evictionNote(result) };
}

/**
 * Reachability only: is there a Bitcoin node listening on this host, and on
 * which port? Writes nothing, disconnects nothing, calls no RPC.
 *
 * Split out of manualAddPeer (which now calls it) so the dashboard can offer
 * the same question as a standalone action. "Can I even add this peer?" and
 * "add this peer" are different questions, and only one of them should have
 * consequences.
 */
async function probePeer(rawInput) {
  const host = (typeof rawInput === 'string' ? rawInput : '').trim();
  if (!looksLikeHost(host)) {
    return { ok: false, error: 'invalid host/IP' };
  }
  const { addr, port: explicitPort } = resolveHostPort(host);

  // Already has an explicit :port - respect it and skip the port search.
  if (explicitPort != null) {
    // resolveHostPort's pattern accepts up to five digits, so "1.2.3.4:99999"
    // parses as port 99999 - and net.connect() throws ERR_SOCKET_BAD_PORT
    // *synchronously* for anything outside 1-65535, from inside probePort's
    // Promise executor. The promise then rejects instead of resolving false,
    // and the user gets a bare 500 instead of a usable message. Exactly the
    // failure validate.js exists to prevent (see its header) - this path just
    // wasn't using it.
    if (!isValidPort(explicitPort)) {
      return { ok: false, error: `${explicitPort} is not a valid port (1-65535)` };
    }
    const reachable = await probePort(addr, explicitPort);
    if (!reachable) return { ok: false, error: `no Bitcoin node answering at ${formatAddress(addr, explicitPort)}` };
    return { ok: true, address: formatAddress(addr, explicitPort), triedPorts: [explicitPort] };
  }

  const address = await findListeningAddress(addr);
  if (address) return { ok: true, address, triedPorts: config.manualPeerPorts };

  return {
    ok: false,
    error: `no node answering on ${config.manualPeerPorts.join(' or ')}`,
  };
}

/**
 * Given a bare host, returns the first configured P2P port where a Bitcoin
 * node answers - already in Core's own address format - or null if none does.
 *
 * Shared on purpose: the automatic rotation loop has to answer exactly this
 * question for an inbound candidate (whose observed port is its ephemeral
 * source port, not what it listens on). A second private copy of this loop
 * over there was one more place for the port list, the bracket format, or the
 * "not every peer listens" case to drift out of sync.
 */
async function findListeningAddress(host) {
  for (const port of config.manualPeerPorts) {
    const reachable = await probePort(host, port);
    if (reachable) return formatAddress(host, port);
  }
  return null;
}

// Bitcoin Core holds MAX_ADDNODE_CONNECTIONS (8) manual connections at once,
// so the 9th add is not a queue, it is a swap - and the user has to be told
// which peer paid for it, by name and by record, or a good peer can vanish
// from the list without anyone ever seeing why.
function evictionNote(result) {
  if (!result.evicted) return {};
  const pct = result.evicted.firstPct == null ? 'no record yet' : `${result.evicted.firstPct.toFixed(1)}% first`;
  return {
    warning:
      `all ${result.max} manual slots were taken, so ${result.evicted.address} (${pct}) ` +
      (result.evicted.live
        ? 'was disconnected to make room. It keeps its record.'
        : 'was removed to make room.'),
  };
}

module.exports = {
  manualAddPeer,
  probePeer,
  hostFromAddress,
  resolveHostPort,
  formatAddress,
  probePort,
  versionMessage,
  MAGIC,
};
