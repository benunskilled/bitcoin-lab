'use strict';

const dns = require('dns');

/**
 * The solo pool apps in the Umbrel app store, and which of them are installed
 * on this Umbrel.
 *
 * A local pool app is not reachable at umbrel.local, and the port a miner on
 * the LAN connects to is the app's externally-published port, not its internal
 * one. Bitcoin Lab is a container on the same network as the pool, so it needs
 * the pool's container name (<app-id>_<service>_1) and the port the stratum
 * server listens on inside its container.
 *
 * Those two numbers are not always the same. GoBrrr and Bassin both run ckpool
 * on container-internal 3333 and publish it under a different number (21420
 * and 3456), so only 3333 works from in here. Public Pool (2018), DATUM (23334)
 * and Pogolo (5661) publish their stratum port unchanged. Checked against the
 * docker-compose.yml of each app in getumbrel/umbrel-apps, 09.10.2026.
 * Only GoBrrr has raced on the node this was written for (3,339 races by
 * 09.10.2026); the other four are taken from those files and have not yet been
 * raced against a running instance (DATUM may only send jobs once it is set up
 * for OCEAN).
 */
const LOCAL_POOLS = [
  { key: 'gobrrr', label: 'GoBrrr', host: 'gobrrr-pool_ckpool_1', port: 3333 },
  { key: 'bassin', label: 'Bassin', host: 'bassin_ckpool_1', port: 3333 },
  { key: 'public-pool', label: 'Public Pool', host: 'public-pool_server_1', port: 2018 },
  { key: 'datum', label: 'DATUM', host: 'datum_datum_1', port: 23334 },
  { key: 'pogolo', label: 'Pogolo', host: 'pogolo_pogolo_1', port: 5661 },
];

/**
 * Whether a pool app is installed is a name lookup on the Umbrel network,
 * nothing more: Docker answers for a running container's name and for nothing
 * else. No connection is opened to the pool - that only happens once the user
 * has added it and Stratum Race is on.
 *
 * Asked at most every five minutes, like the Peer Map check in sibling.js: an
 * app is installed or removed by hand, and the dashboard polls far more often.
 */
const RECHECK_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 2000;

let lookup = (host) => dns.promises.lookup(host);
let checkedAtMs = 0;
let found = new Set();
let inFlight = null;

function resolves(host) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), TIMEOUT_MS);
    lookup(host).then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(false); },
    );
  });
}

async function check() {
  const answers = await Promise.all(LOCAL_POOLS.map((p) => resolves(p.host)));
  return new Set(LOCAL_POOLS.filter((_, i) => answers[i]).map((p) => p.key));
}

/** Keys of the pool apps that answer on this Umbrel, from cache when fresh. */
async function installed() {
  if (inFlight) return inFlight;
  if (checkedAtMs && Date.now() - checkedAtMs < RECHECK_MS) return found;
  inFlight = check().then((keys) => {
    found = keys;
    checkedAtMs = Date.now();
    inFlight = null;
    return keys;
  });
  return inFlight;
}

/**
 * Every known pool app with two flags: installed on this Umbrel, and already
 * among the user's pools (same host and port). The dashboard offers the
 * installed ones that are not added yet; the quick-fill buttons show all of
 * them either way, so a pool declined once can always be added later.
 */
async function list(configuredPools) {
  const keys = await installed();
  const added = new Set(configuredPools.map((p) => `${String(p.host).toLowerCase()}:${Number(p.port)}`));
  return LOCAL_POOLS.map((p) => ({
    ...p,
    installed: keys.has(p.key),
    added: added.has(`${p.host}:${p.port}`),
  }));
}

/** For tests: replace the name lookup and forget the cache. */
function _setLookup(fn) {
  lookup = fn;
  checkedAtMs = 0;
  found = new Set();
  inFlight = null;
}

module.exports = { LOCAL_POOLS, list, installed, _setLookup };
