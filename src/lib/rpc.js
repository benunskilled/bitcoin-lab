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
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
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
  getPeerInfo: () => call('getpeerinfo'),
  getBlockHeader: (hash) => call('getblockheader', [hash]),
  getBlockCount: () => call('getblockcount'),
  addNode: (nodeAddr, command = 'add') => call('addnode', [nodeAddr, command]),
  disconnectNode: (addressOrId) => {
    // addnode-style address string vs numeric peer id
    if (typeof addressOrId === 'number') return call('disconnectnode', ['', addressOrId]);
    return call('disconnectnode', [addressOrId]);
  },
  getAddedNodeInfo: () => call('getaddednodeinfo').catch(() => []),
};
