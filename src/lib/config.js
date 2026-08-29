'use strict';

/**
 * Central configuration. Reads the Umbrel `bitcoin` app dependency contract
 * (APP_BITCOIN_*) when present, falls back to plain env vars for local /
 * non-Umbrel development, and finally to sane localhost defaults so the
 * app also runs as an ordinary docker-compose stack outside Umbrel.
 *
 * No hardcoded container names or IPs anywhere - everything comes from env.
 */

function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const bitcoinHost = pick(process.env.BITCOIN_RPC_HOST, process.env.APP_BITCOIN_NODE_IP, '127.0.0.1');
const bitcoinRpcPort = pick(process.env.BITCOIN_RPC_PORT, process.env.APP_BITCOIN_RPC_PORT, '8332');
const bitcoinRpcUser = pick(process.env.BITCOIN_RPC_USER, process.env.APP_BITCOIN_RPC_USER, '');
const bitcoinRpcPass = pick(process.env.BITCOIN_RPC_PASS, process.env.APP_BITCOIN_RPC_PASS, '');

const zmqExplicit = process.env.BITCOIN_ZMQ_HASHBLOCK_URL;
const zmqHost = pick(process.env.BITCOIN_ZMQ_HOST, process.env.APP_BITCOIN_NODE_IP, bitcoinHost);
const zmqPort = pick(process.env.BITCOIN_ZMQ_HASHBLOCK_PORT, process.env.APP_BITCOIN_ZMQ_HASHBLOCK_PORT, '28334');

const dataDir = pick(process.env.DATA_DIR, '/data');

module.exports = {
  bitcoin: {
    rpcUrl: `http://${bitcoinHost}:${bitcoinRpcPort}/`,
    rpcUser: bitcoinRpcUser,
    rpcPass: bitcoinRpcPass,
    network: pick(process.env.BITCOIN_NETWORK, process.env.APP_BITCOIN_NETWORK, 'mainnet'),
    zmqHashBlockUrl: zmqExplicit || `tcp://${zmqHost}:${zmqPort}`,
  },
  dataDir,
  sqlitePath: pick(process.env.SQLITE_PATH, `${dataDir}/sqlite/bitcoinlab.db`),
  dashboardPort: Number(pick(process.env.DASHBOARD_PORT, '8788')),

  // Manual peer-add: ports tried in order when the user supplies a bare IP,
  // or when "Add as Manual" re-probes an existing peer's host (this matters
  // most for inbound peers, whose getpeerinfo address is their ephemeral
  // outbound source port, not the port their node actually listens on).
  manualPeerPorts: [8333, 9333],

  // Bitcoin Core only actively maintains a limited number of simultaneous
  // "manual" (addnode) connections - by default 8. We mirror that cap so we
  // never try to addnode more than Core will actually hold open at once.
  maxManualPeers: Number(pick(process.env.MAX_MANUAL_PEERS, '8')),

  // How long a relay race stays "open" for late stratum-style bookkeeping
  // is not needed here (relay races resolve synchronously on ZMQ), but the
  // stratum race timeout window (ms) a pool has to report a new prevhash
  // before it is scored as a miss for that race.
  stratumRaceTimeoutMs: Number(pick(process.env.STRATUM_RACE_TIMEOUT_MS, '8000')),

  // Idle-socket timeout for stratum pool connections - a LAST-RESORT
  // backstop, not the primary way we detect a dead connection (see
  // setKeepAlive in stratum-client.js for that). Block intervals are
  // exponentially distributed around a ~10 minute mean with no hard upper
  // bound - the textbook math says a 120-minute gap should be vanishingly
  // rare (~0.0006% per wait), but real-world observation of this exact
  // node has shown it happening more than once, so the math is being
  // deliberately overridden here in favor of what's actually been seen: 6
  // hours (P(within 360 min) is astronomically smaller still) all but
  // eliminates false-miss risk from a spurious reconnect, while TCP
  // keepalive (below) remains the fast path (minutes, not hours) for an
  // actually-dead socket.
  stratumIdleTimeoutMs: Number(pick(process.env.STRATUM_IDLE_TIMEOUT_MS, String(6 * 60 * 60 * 1000))),

  // Username sent with mining.authorize - many solo-mining stratum servers
  // (ckpool-solo in particular, which GoBrrr Pool and most public solo
  // pools run) validate this as a real Bitcoin address (since solo payouts
  // go directly to whoever finds the block) and simply never broadcast
  // mining.notify to a connection that fails authorize. We never submit
  // shares, so the address doesn't need to be ours - this is a well-known,
  // valid, real "eater/burn" address used exactly for this kind of
  // placeholder purpose. A worker-name suffix (address.bitcoinlab) is
  // supported by ckpool and makes our connections identifiable in pool
  // logs without needing a real payout address.
  stratumAuthorizeAddress: pick(process.env.STRATUM_AUTHORIZE_ADDRESS, '1BitcoinEaterAddressDontSendf59kuE'),

  // Peer snapshot poll interval for the peer-profiler (session bookkeeping,
  // not block timing - the relay-profiler never polls).
  peerPollIntervalMs: Number(pick(process.env.PEER_POLL_INTERVAL_MS, '15000')),

  // Docker can only hand an inbound IPv6 connection to our IPv4-only
  // container by relaying it through docker-proxy (a real userspace TCP
  // relay, not plain NAT) - and that relay re-originates the connection
  // from the Docker bridge gateway, so Core's own getpeerinfo sees the
  // peer's "addr" as this local gateway (with a throwaway port), not the
  // peer's real IPv6. This is a Docker networking limitation, not
  // something fixable from inside this app's own containers - the actual
  // fix (disabling Docker's userland-proxy) is a host-wide daemon setting
  // that restarts every app's networking, well outside this app's scope.
  // Umbrel's convention for this gateway is 10.21.0.1; configurable in case
  // a given install's Docker network differs.
  dockerProxyMaskedAddressHost: pick(process.env.DOCKER_PROXY_MASKED_HOST, '10.21.0.1'),

  // Every Umbrel app container shares the same internal Docker network, so
  // a peer whose address falls in this range isn't an external node at
  // all - it's a sibling app on the same host talking to Bitcoin Core's P2P
  // port directly (electrs and mempool's own indexer both do this to sync).
  // Distinct from dockerProxyMaskedAddressHost above: that one specific
  // address masks a genuine EXTERNAL peer whose real address Core never
  // learned; everything else in this range is a real, local, non-external
  // connection whose address is perfectly accurate, just not "a peer" in
  // any useful sense - nothing to add manually or disconnect on purpose.
  umbrelInternalNetworkCidr: pick(process.env.UMBREL_INTERNAL_NETWORK_CIDR, '10.21.0.0/16'),

  // relay_race/relay_observation IS the long-term peer-ranking data this
  // app exists to build up - First/Eligible/First% is computed across ALL
  // of it, unfiltered by age, so silently aging it out would erode the
  // app's own core feature over time. It is never time-pruned. Its growth
  // is bounded on its own terms anyway: one race per block (~144/day) with
  // a roughly constant number of eligible-peer rows each - nothing like the
  // unbounded churn of transient peer connections below.

  // Stratum pool history (win%/avg latency) is the same kind of long-term
  // ranking data for the Stratum Race feature, kept far longer than the
  // peer-session data below - it's inherently small (a handful of pools)
  // and exists specifically to answer "which pool wins over months".
  stratumHistoryRetentionDays: Number(pick(process.env.STRATUM_HISTORY_RETENTION_DAYS, '180')),

  // A peer that has EVER appeared in relay_observation (i.e. was actually
  // connected at the moment a block landed, at least once) is one of the
  // relatively few long-lived connections the ranking is actually about -
  // its peer row and full session history are never pruned, no matter how
  // old, same as a manually trusted peer. Everything else - crawler bots,
  // one-off inbound probes, feelers and addr-fetch connections that came
  // and went without ever once being around for a block - has no
  // analytical value here. Bitcoin Core's P2P layer churns through
  // thousands of these; keeping their session history for months was the
  // actual source of unbounded growth, not the real ranking data, so they
  // get a much shorter window.
  feelerPeerRetentionDays: Number(pick(process.env.FEELER_PEER_RETENTION_DAYS, '14')),

  logLevel: pick(process.env.LOG_LEVEL, 'info'),
};
