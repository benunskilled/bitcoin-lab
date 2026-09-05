'use strict';

const net = require('net');
const config = require('./config');
const peerSync = require('./peer-sync');
const { isValidPort } = require('./validate');
// Address parsing/formatting lives in one module - see address.js for why.
const { resolveHostPort, formatAddress, hostFromAddress } = require('./address');
const logger = require('./logger').make('manual-peer');

function probePort(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// Bare-bones sanity check - real validation happens by attempting the
// TCP connection itself; this just rejects obvious junk input. Brackets are
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
 * answers a TCP handshake. This is deliberate even for peers we already see
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
async function manualAddPeer(rawInput, label) {
  const probed = await probePeer(rawInput);
  if (!probed.ok) return probed;

  // Asked for by hand, so it outranks whatever is currently weakest: at
  // capacity, free a slot rather than writing a ninth row Core will never be
  // told about. The response names what was dropped - a silent eviction of a
  // peer the user spent days earning would be far worse than a refusal.
  // Every path into this function is a person typing an address in, so the
  // star goes on. The rotation never comes through here - it calls
  // addTrustedPeer directly and leaves the star off.
  const result = await peerSync.addTrustedPeer(probed.address, label, { evictToFit: true, kept: true });
  if (!result.ok) {
    return { ok: false, address: probed.address, error: result.error };
  }
  logger.info('manually added peer', { address: probed.address, evicted: result.evicted?.address || null });
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
  const host = (rawInput || '').trim();
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
    if (!reachable) return { ok: false, error: `${formatAddress(addr, explicitPort)} not reachable` };
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
 * Given a bare host, returns the first configured P2P port that answers a TCP
 * handshake - already in Core's own address format - or null if none does.
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
      `was removed to make room - it will be re-tested and can come back on its own.`,
  };
}

module.exports = {
  manualAddPeer,
  probePeer,
  hostFromAddress,
  resolveHostPort,
  formatAddress,
  probePort,
  findListeningAddress,
};
