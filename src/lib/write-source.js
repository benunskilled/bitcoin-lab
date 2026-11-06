'use strict';

// Which addresses a write may come from.
//
// On Umbrel every app joins the same Docker network, so any other installed
// app can reach this dashboard's port directly, past Umbrel's login. refuseWrite
// in dashboard-server.js stops a browser on another site; a container sends no
// browser headers and is let through there. This closes that path: a write is
// taken only from where Umbrel's own proxy connects from, or from inside this
// container. Reads stay open - Peer Map next door reads them.
//
// Where the proxy connects from depends on the umbrelOS version:
//   - 2.x: the proxy runs inside umbreld on the host, so a request arrives from
//     the Docker network's gateway (10.21.0.1, read here from the container's
//     default route). Measured on umbrelOS 2.0.1, 06.11.2026.
//   - 1.x: each app has its own app_proxy container. TRUSTED_PROXY_HOST names
//     it; its address comes from Docker's DNS on every lookup and is never
//     kept as a fixed address. On 2.x the name does not exist, and nothing more
//     is let in.
//
// Not covered, and no address can cover it: apps running on the host's own
// network (network_mode: host, e.g. Home Assistant, Plex, Pi-hole) and
// anything else running on the node itself also arrive from the gateway.
// umbrelOS passes the backend no proof of the user's login, so only a login of
// the app's own could tell those apart. Umbrel knows the gap
// (getumbrel/umbrel#1432, getumbrel/umbrel-apps#1463). The app's writes move
// no funds, so a login of its own (from APP_PASSWORD) is left for the day
// they do more.

const dns = require('dns').promises;
const fs = require('fs');

const TTL_MS = 60 * 1000;
const RETRY_MS = 2 * 1000;

const plain = (address) => String(address || '').replace(/^::ffff:/, '');
const isLoopback = (address) => address === '::1' || /^127\./.test(address);

// The default route's gateway from /proc/net/route (hex, little-endian), or
// null where there is none to read (not Linux, tests).
function readGateway(read = () => fs.readFileSync('/proc/net/route', 'utf8')) {
  try {
    for (const line of read().split('\n').slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination === '00000000' && gateway && gateway !== '00000000') {
        return gateway.match(/../g).reverse().map((h) => parseInt(h, 16)).join('.');
      }
    }
  } catch { /* no /proc here */ }
  return null;
}

function makeWriteSource({ host, gateway = readGateway(), lookup = (h) => dns.lookup(h, { all: true }), now = Date.now } = {}) {
  let cache = null; // { at, addresses: Set } - the 1.x proxy's addresses, empty when the name is unknown
  let lastError = null;

  async function resolve() {
    try {
      const list = await lookup(host);
      lastError = null;
      cache = { at: now(), addresses: new Set(list.map((a) => plain(a.address))) };
    } catch (err) {
      // On 2.x the name never resolves: remember that for a while too, so a
      // write does not wait on DNS each time.
      lastError = err.code || err.message;
      cache = { at: now(), addresses: new Set() };
    }
    return cache.addresses;
  }

  async function allowed(remoteAddress) {
    const from = plain(remoteAddress);
    if (isLoopback(from)) return true;
    if (gateway && from === gateway) return true;
    if (!host) return !gateway; // nothing known to compare with: tests and local runs
    let addresses = cache && now() - cache.at < TTL_MS ? cache.addresses : await resolve();
    if (!addresses.has(from) && now() - cache.at >= RETRY_MS) addresses = await resolve();
    return addresses.has(from);
  }

  // What the check saw, for a test copy that has to find out why a write was
  // refused (WRITE_SOURCE_DEBUG=1): Docker-internal addresses only.
  allowed.describe = (remoteAddress) => ({
    from: plain(remoteAddress),
    gateway,
    proxyHost: host || null,
    proxyAddresses: cache ? [...cache.addresses] : [],
    lookupError: lastError,
  });
  return allowed;
}

module.exports = { makeWriteSource, readGateway };
