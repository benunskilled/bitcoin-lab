'use strict';

const net = require('net');
const config = require('./config');
const rpc = require('./rpc');
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

/**
 * Manual "add peer by IP" flow for the Peer Profiler. The user supplies a
 * bare IP (no port); we probe the standard Bitcoin P2P port first, then
 * the configured fallback, and only call `addnode` on whichever actually
 * answers a TCP handshake.
 */
async function manualAddPeer(rawInput) {
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
    await rpc.addNode(`${addr}:${port}`, 'add');
    return { ok: true, address: `${addr}:${port}` };
  }

  for (const port of config.manualPeerPorts) {
    // eslint-disable-next-line no-await-in-loop
    const reachable = await probePort(host, port);
    if (reachable) {
      const address = `${host}:${port}`;
      await rpc.addNode(address, 'add');
      logger.info('manually added peer', { address, triedPorts: config.manualPeerPorts });
      return { ok: true, address };
    }
  }

  return { ok: false, error: `not reachable on ${config.manualPeerPorts.join(' or ')}` };
}

module.exports = { manualAddPeer };
