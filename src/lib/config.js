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
  // exponentially distributed around a ~10 minute mean, so "quiet for a
  // while" is routine, not a sign anything is wrong: P(no block within 20
  // min) is still ~13.5%, P(within 60 min) ~0.25%, and even P(within 120
  // min) is ~0.0006% but NOT zero - long gaps are rare, not bounded. A
  // timeout anywhere near "a bit more than 10 minutes" (the original
  // 30000ms hardcoded value included) will misfire on ordinary long gaps,
  // forcing pointless reconnects that can - in the few seconds the
  // reconnect takes - cause a pool to be wrongly scored as a miss if a
  // block lands during that exact window. 2 hours keeps that false-miss
  // risk astronomically small while TCP keepalive (below) still catches an
  // actually-dead socket in minutes, not hours.
  stratumIdleTimeoutMs: Number(pick(process.env.STRATUM_IDLE_TIMEOUT_MS, String(2 * 60 * 60 * 1000))),

  // Peer snapshot poll interval for the peer-profiler (session bookkeeping,
  // not block timing - the relay-profiler never polls).
  peerPollIntervalMs: Number(pick(process.env.PEER_POLL_INTERVAL_MS, '15000')),

  logLevel: pick(process.env.LOG_LEVEL, 'info'),
};
