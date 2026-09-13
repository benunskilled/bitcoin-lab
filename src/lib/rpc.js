'use strict';

const http = require('http');
const { URL } = require('url');
const config = require('./config');

/**
 * Minimal Bitcoin Core JSON-RPC client. No dependency, no cookie-file
 * mounting - authenticates with the user/pass exported by Umbrel's
 * `bitcoin` app dependency (see lib/config.js).
 *
 * IMPORTANT: this client is never used on the block-detection timing path.
 * The relay profiler only ever calls getpeerinfo/getblockheader *after*
 * the ZMQ event has already been timestamped - see relay-profiler.js.
 */

let idCounter = 0;

// One connection pool for the whole process instead of a fresh TCP handshake
// per call. The peer profiler alone asks for getpeerinfo every fifteen
// seconds, and the dashboard, the rotation and the sync add to that; none of
// it is heavy over a Docker bridge, but there is no reason to open and close a
// socket several thousand times a day to the same host.
//
// maxSockets is small on purpose. Core handles RPC on a small thread pool and
// four in flight is already more than anything here does at once; a larger
// number would only queue work somewhere else.
const agent = new http.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30000 });

// Core is this app's own trusted service, so this is not a defence against an
// attacker - it is a guard against being pointed at the wrong port. Without a
// ceiling, an endpoint that streams something unbounded is a process that
// grows until it dies, and the cause is invisible. getpeerinfo on a node with
// two hundred peers is a few hundred kilobytes, so 16 MB is far past anything
// legitimate.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function call(method, params = [], { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.bitcoin.rpcUrl);
    const body = JSON.stringify({
      jsonrpc: '1.0',
      id: `bitcoinlab-${++idCounter}`,
      method,
      params,
    });

    const auth = Buffer.from(`${config.bitcoin.rpcUser}:${config.bitcoin.rpcPass}`).toString('base64');

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Basic ${auth}`,
        },
        timeout: timeoutMs,
        agent,
      },
      (res) => {
        let raw = '';
        let bytes = 0;
        let aborted = false;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (aborted) return;
          bytes += Buffer.byteLength(chunk, 'utf8');
          if (bytes > MAX_RESPONSE_BYTES) {
            aborted = true;
            raw = '';
            res.destroy();
            reject(new Error(`RPC ${method}: response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          raw += chunk;
        });
        res.on('end', () => {
          if (aborted) return;
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            reject(new Error(`RPC ${method}: invalid JSON response (HTTP ${res.statusCode}): ${err.message}`));
            return;
          }
          if (parsed.error) {
            reject(new Error(`RPC ${method} failed: ${parsed.error.message} (code ${parsed.error.code})`));
            return;
          }
          resolve(parsed.result);
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error(`RPC ${method}: timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  call,
  agent,
  getPeerInfo: () => call('getpeerinfo'),
  getBlockHeader: (hash) => call('getblockheader', [hash]),
  getBlockCount: () => call('getblockcount'),
  addNode: (nodeAddr, command = 'add') => call('addnode', [nodeAddr, command]),
  disconnectNode: (addressOrId) => {
    // addnode-style address string vs numeric peer id
    if (typeof addressOrId === 'number') return call('disconnectnode', ['', addressOrId]);
    return call('disconnectnode', [addressOrId]);
  },
  // Deliberately does NOT swallow errors into an empty array. Both callers in
  // peer-sync.js catch this and skip their round with a log line, and that
  // path was unreachable while a failed call returned [] - indistinguishable
  // from "Core genuinely has no addnodes". With Core restarting, that meant
  // firing eight doomed `addnode` calls and then logging
  // "trusted/addnode sync complete { existingAddnodes: 0 }".
  getAddedNodeInfo: () => call('getaddednodeinfo'),
};
