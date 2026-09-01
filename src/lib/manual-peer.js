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
 * If the resolved address is already connected under some other type, the
 * existing session is disconnected first (peerSync.addTrustedPeer does this
 * internally via disconnectIfLiveNonManual) so Core actually frees the slot
 * instead of silently keeping the old connection type forever - otherwise
 * "Add as Manual" on an already-live peer never frees an automatic-outbound
 * slot for a new peer to fill.
 *
 * A successful add is persisted to trusted_peer (not just a one-off addnode
 * RPC call), so it survives container restarts/updates via
 * peer-sync.syncTrustedToAddnode() the same way peers trusted from the
 * dashboard do.
 */
async function manualAddPeer(rawInput, label) {
  const host = (rawInput || '').trim();
  if (!looksLikeHost(host)) {
    return { ok: false, error: 'invalid host/IP' };
  }
  const { addr, port: explicitPort } = resolveHostPort(host);
  // Already has an explicit :port - respect it and skip probing.
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
    const address = formatAddress(addr, explicitPort);
    const capacity = await peerSync.addTrustedPeer(address, label);
    logger.info('manually added peer', { address });
    return { ok: true, address, ...capacityWarning(capacity) };
  }

  const address = await findListeningAddress(addr);
  if (address) {
    const capacity = await peerSync.addTrustedPeer(address, label);
    logger.info('manually added peer', { address, triedPorts: config.manualPeerPorts });
    return { ok: true, address, ...capacityWarning(capacity) };
  }

  return {
    ok: false,
    error: `node not reachable on ${config.manualPeerPorts.join(' or ')} - not added as manual`,
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
    // eslint-disable-next-line no-await-in-loop
    const reachable = await probePort(host, port);
    if (reachable) return formatAddress(host, port);
  }
  return null;
}

function capacityWarning(capacity) {
  if (!capacity || !capacity.overCapacity) return {};
  return {
    warning:
      `Bitcoin Core only actively maintains ${capacity.max} manual connections at once ` +
      `(you now have ${capacity.count}) - this peer is queued and will connect automatically once a slot frees up.`,
  };
}

module.exports = {
  manualAddPeer,
  hostFromAddress,
  resolveHostPort,
  formatAddress,
  probePort,
  findListeningAddress,
};
