'use strict';

// Which containers a write may come from.
//
// On Umbrel every app joins the same Docker network, so any other installed
// app can reach this dashboard's port directly, past the app proxy and its
// login. refuseWrite in dashboard-server.js stops a browser on another site;
// a container sends no browser headers and is let through there. This closes
// that path: with TRUSTED_PROXY_HOST set (the compose file names the app's own
// app_proxy container), a write is taken only from that container's address
// or from inside this container. Reads stay open - Peer Map next door reads
// them.
//
// The proxy's address comes from Docker's DNS and changes when the container
// is recreated, so it is looked up again after a while, and once more at once
// when a write arrives from an address not in the last answer. If the name
// cannot be resolved at all, writes are refused rather than let through.

const dns = require('dns').promises;

const TTL_MS = 60 * 1000;
const RETRY_MS = 2 * 1000;

const plain = (address) => String(address || '').replace(/^::ffff:/, '');
const isLoopback = (address) => address === '::1' || /^127\./.test(address);

function makeWriteSource({ host, lookup = (h) => dns.lookup(h, { all: true }), now = Date.now } = {}) {
  let cache = null; // { at, addresses: Set }

  async function resolve() {
    const list = await lookup(host);
    cache = { at: now(), addresses: new Set(list.map((a) => plain(a.address))) };
    return cache.addresses;
  }

  return async function allowed(remoteAddress) {
    const from = plain(remoteAddress);
    if (isLoopback(from)) return true;
    if (!host) return true;
    try {
      let addresses = cache && now() - cache.at < TTL_MS ? cache.addresses : await resolve();
      if (!addresses.has(from) && now() - cache.at >= RETRY_MS) addresses = await resolve();
      return addresses.has(from);
    } catch {
      cache = null;
      return false;
    }
  };
}

module.exports = { makeWriteSource };
