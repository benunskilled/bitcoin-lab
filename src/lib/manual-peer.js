'use strict';

const net = require('net');
const config = require('./config');
const rpc = require('./rpc');
const peerSync = require('./peer-sync');
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
// TCP connection itself; this just rejects obvious junk input.
function looksLikeHost(input) {
  return typeof input === 'string' && /^[a-zA-Z0-9.:\-]{3,255}$/.test(input.trim());
}

// If Core already has a live connection to this address under some other
// connection_type (outbound-full-relay, block-relay-only, inbound, feeler),
// `addnode add` alone won't touch it: Core's ThreadOpenAddedConnections
// skips opening a duplicate/replacement connection to an address that's
// already connected, so the session just keeps its old type forever and no
// automatic-outbound slot is ever freed - even though our own dashboard
// happily labels it "manual" the moment it's in trusted_peer. Disconnect
// the existing session first (only when it isn't already 'manual' - no
// point churning a peer that's already exactly what we want) so Core's own
// reconnect logic picks it back up moments later as a genuine manual
// connection, with the slot it used to occupy now free for a new
// automatically-discovered peer.
async function disconnectIfLiveNonManual(address) {
  let peers = [];
  try {
    peers = await rpc.getPeerInfo();
  } catch (err) {
    // Can't tell either way - proceed as before rather than block the add on it.
    logger.debug('getpeerinfo failed while checking for a live non-manual session', { address, error: err.message });
    return;
  }
  const existing = peers.find((p) => p.addr === address);
  if (!existing || existing.connection_type === 'manual') return;
  try {
    await rpc.disconnectNode(address);
    logger.info('disconnected existing non-manual session to free its slot before adding as manual', {
      address,
      previousType: existing.connection_type,
    });
  } catch (err) {
    // Not fatal - addnode below still queues it, Core just won't get a free
    // slot as quickly as it could have.
    logger.warn('failed to disconnect existing session before manual-add', { address, error: err.message });
  }
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
 * existing session is disconnected first (see disconnectIfLiveNonManual)
 * so Core actually frees the slot instead of silently keeping the old
 * connection type forever - otherwise "Add as Manual" on an already-live
 * peer never frees an automatic-outbound slot for a new peer to fill.
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
  // Already has an explicit :port - respect it and skip probing.
  const explicitPortMatch = host.match(/^(.+):(\d{2,5})$/);
  if (explicitPortMatch) {
    const [, addr, portStr] = explicitPortMatch;
    const port = Number(portStr);
    const reachable = await probePort(addr, port);
    if (!reachable) return { ok: false, error: `${addr}:${port} not reachable` };
    const address = `${addr}:${port}`;
    await disconnectIfLiveNonManual(address);
    const capacity = await peerSync.addTrustedPeer(address, label);
    logger.info('manually added peer', { address });
    return { ok: true, address, ...capacityWarning(capacity) };
  }

  for (const port of config.manualPeerPorts) {
    // eslint-disable-next-line no-await-in-loop
    const reachable = await probePort(host, port);
    if (reachable) {
      const address = `${host}:${port}`;
      // eslint-disable-next-line no-await-in-loop
      await disconnectIfLiveNonManual(address);
      // eslint-disable-next-line no-await-in-loop
      const capacity = await peerSync.addTrustedPeer(address, label);
      logger.info('manually added peer', { address, triedPorts: config.manualPeerPorts });
      return { ok: true, address, ...capacityWarning(capacity) };
    }
  }

  return {
    ok: false,
    error: `node not reachable on ${config.manualPeerPorts.join(' or ')} - not added as manual`,
  };
}

function capacityWarning(capacity) {
  if (!capacity || !capacity.overCapacity) return {};
  return {
    warning:
      `Bitcoin Core only actively maintains ${capacity.max} manual connections at once ` +
      `(you now have ${capacity.count}) - this peer is queued and will connect automatically once a slot frees up.`,
  };
}

// Best-effort host extraction from a Core-style "addr" string, so callers
// can turn an existing live peer's address (possibly an ephemeral inbound
// port) back into a bare host for re-probing. Handles bracketed IPv6
// ("[2001:db8::1]:8333") and plain "host:port"; falls back to returning the
// input unchanged if neither pattern matches.
function hostFromAddress(address) {
  const bracketed = address.match(/^\[(.+)\]:\d+$/);
  if (bracketed) return bracketed[1];
  const simple = address.match(/^([^:]+):\d+$/);
  if (simple) return simple[1];
  return address;
}

module.exports = { manualAddPeer, hostFromAddress };
