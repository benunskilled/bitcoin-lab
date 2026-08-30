'use strict';

const net = require('net');
const config = require('./config');
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
// TCP connection itself; this just rejects obvious junk input. Brackets are
// allowed so bracketed IPv6 input ("[2001:db8::1]:8333") isn't rejected
// outright - see resolveHostPort below for why that notation matters.
function looksLikeHost(input) {
  return typeof input === 'string' && /^[a-zA-Z0-9.:\-[\]]{3,255}$/.test(input.trim());
}

// Splits a user-supplied host string into { addr, port: number|null }. This
// needs more care than a plain trailing "/:(\d+)$/" split once IPv6 is in
// play: an unbracketed IPv6 literal like "2001:db8::86" uses colons as
// hextet separators, so that naive split would slice off "86" as a "port"
// and leave the mangled "2001:db8:" behind as the host - wrong for any IPv6
// address whose last hextet happens to look like a 2-5 digit decimal
// number. Bracket notation ("[2001:db8::1]:8333", the same format Core
// itself reports and that hostFromAddress below already unwraps) is the
// only form treated as carrying an explicit port for anything IPv6-shaped;
// a bare address with two or more colons is always treated as a portless
// IPv6 host instead, same as if the user had typed it without a port.
function resolveHostPort(input) {
  const bracketed = input.match(/^\[(.+)\](?::(\d{2,5}))?$/);
  if (bracketed) {
    const [, addr, portStr] = bracketed;
    return { addr, port: portStr ? Number(portStr) : null };
  }
  const colonCount = (input.match(/:/g) || []).length;
  if (colonCount >= 2) {
    return { addr: input, port: null };
  }
  const explicitPortMatch = input.match(/^(.+):(\d{2,5})$/);
  if (explicitPortMatch) {
    return { addr: explicitPortMatch[1], port: Number(explicitPortMatch[2]) };
  }
  return { addr: input, port: null };
}

// Core itself always writes an IP:port pair as "[addr]:port" the moment
// addr contains a colon (its CService::ToStringAddrPort - the same format
// hostFromAddress above parses back out of getpeerinfo). We have to match
// that exactly: trusted_peer.address is joined against Core's own
// peer.address by string equality (see queries.js), and disconnectIfLiveNonManual
// below compares against getpeerinfo's addr the same way, so an unbracketed
// IPv6 "address:port" here would silently never match either one - the
// peer would never show as trusted, and a live non-manual session would
// never get disconnected before the add.
function formatAddress(addr, port) {
  return addr.includes(':') ? `[${addr}]:${port}` : `${addr}:${port}`;
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
    const reachable = await probePort(addr, explicitPort);
    if (!reachable) return { ok: false, error: `${formatAddress(addr, explicitPort)} not reachable` };
    const address = formatAddress(addr, explicitPort);
    const capacity = await peerSync.addTrustedPeer(address, label);
    logger.info('manually added peer', { address });
    return { ok: true, address, ...capacityWarning(capacity) };
  }

  for (const port of config.manualPeerPorts) {
    // eslint-disable-next-line no-await-in-loop
    const reachable = await probePort(addr, port);
    if (reachable) {
      const address = formatAddress(addr, port);
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

module.exports = { manualAddPeer, hostFromAddress, resolveHostPort, formatAddress, probePort };
