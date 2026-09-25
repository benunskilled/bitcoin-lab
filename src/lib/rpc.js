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

/**
 * What Core's machine thinks the time is, read off the Date header it puts on
 * every RPC response, against what this machine thinks.
 *
 * This matters because block attribution compares two clocks: the instant ZMQ
 * delivered a hash, measured here, against Core's own last_block, measured
 * there. On Umbrel both are the same machine and there is nothing to get
 * wrong. Point this app at a node somewhere else and a few seconds of drift
 * credits no peer with anything, ever - and until now the only way to find
 * that out was to watch attribution fail for half an hour first. The header
 * says it outright, on the first call, while everything still works.
 *
 * Two things the arithmetic has to respect.
 *
 * The header is generated somewhere between the request leaving and the
 * response arriving, so it is compared against the midpoint of those two
 * instants rather than either end. Over a Docker bridge that is a fraction of
 * a millisecond either way; over anything slower, the midpoint is the honest
 * choice.
 *
 * And an HTTP date is whole seconds, truncated - so a single reading always
 * lands somewhere in the second BELOW the true offset, uniformly. The average
 * of many readings therefore sits half a second low, which is corrected for
 * here rather than being left as a permanent lean towards "Core is behind".
 */
const CLOCK_SAMPLES = 20;
const clockSamples = [];

function recordClockSample(dateHeader, sentAtMs, receivedAtMs) {
  if (!dateHeader) return;
  const coreMs = Date.parse(dateHeader);
  if (!Number.isFinite(coreMs)) return;
  const localMidpointMs = (sentAtMs + receivedAtMs) / 2;
  clockSamples.push({
    offsetMs: coreMs - localMidpointMs + 500,
    rttMs: receivedAtMs - sentAtMs,
    atMs: receivedAtMs,
  });
  if (clockSamples.length > CLOCK_SAMPLES) clockSamples.shift();
}

/**
 * The median of what has been seen lately, or null before anything has.
 *
 * Median rather than the last reading, because one sample carries the whole
 * second of truncation error and a threshold applied to it would flicker.
 */
function clockOffset() {
  if (clockSamples.length === 0) return null;
  const sorted = clockSamples.map((s) => s.offsetMs).sort((a, b) => a - b);
  return {
    offsetMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
    samples: sorted.length,
    maxRttMs: Math.max(...clockSamples.map((s) => s.rttMs)),
    measuredAtMs: clockSamples[clockSamples.length - 1].atMs,
  };
}

function call(method, params = [], { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.bitcoin.rpcUrl);
    const sentAtMs = Date.now();
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
        // Before anything else is done with the response, and regardless of
        // what its status turns out to be: a 401 or a 500 carries the header
        // just as well as a 200, and a node whose credentials are wrong is
        // exactly one whose clock nobody has checked either.
        recordClockSample(res.headers.date, sentAtMs, Date.now());
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

/**
 * How long an RPC takes to answer completely, without keeping the answer.
 *
 * Made for getblocktemplate: its reply carries every transaction of the next
 * block as hex, a few megabytes, and all that is wanted is how long Core took
 * to produce it. The body is read to the end - the clock stops at the last
 * byte - and dropped as it streams in, so nothing that size is ever held or
 * parsed. Only a short reply is kept, because that is what an RPC error looks
 * like, and an error must not be mistaken for a fast answer.
 */
const SHORT_REPLY_BYTES = 4096;
function timeCall(method, params = [], { timeoutMs = 30000, count = null } = {}) {
  // `count`: a string to count in the reply while it streams past - for the
  // template, '"txid"', once per transaction. The tail of each chunk is kept
  // so a match split across two chunks is still found exactly once.
  const needle = count ? Buffer.from(count) : null;
  return new Promise((resolve, reject) => {
    const url = new URL(config.bitcoin.rpcUrl);
    const body = JSON.stringify({ jsonrpc: '1.0', id: `bitcoinlab-${++idCounter}`, method, params });
    const auth = Buffer.from(`${config.bitcoin.rpcUser}:${config.bitcoin.rpcPass}`).toString('base64');
    const started = process.hrtime.bigint();
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
        let bytes = 0;
        let head = '';
        let hits = 0;
        let tail = Buffer.alloc(0);
        res.on('data', (chunk) => {
          if (bytes < SHORT_REPLY_BYTES) head += chunk.toString('utf8');
          bytes += chunk.length;
          if (!needle) return;
          const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk;
          for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + needle.length)) hits += 1;
          tail = buf.subarray(Math.max(0, buf.length - (needle.length - 1)));
        });
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          if (bytes < SHORT_REPLY_BYTES) {
            try {
              const parsed = JSON.parse(head);
              if (parsed.error) {
                reject(new Error(`RPC ${method} failed: ${parsed.error.message} (code ${parsed.error.code})`));
                return;
              }
            } catch {
              reject(new Error(`RPC ${method}: invalid short reply (HTTP ${res.statusCode})`));
              return;
            }
          }
          if (res.statusCode !== 200) {
            reject(new Error(`RPC ${method}: HTTP ${res.statusCode}`));
            return;
          }
          resolve(needle ? { ms, bytes, count: hits } : { ms, bytes });
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
  timeCall,
  agent,
  clockOffset,
  getPeerInfo: () => call('getpeerinfo'),
  getBlockHeader: (hash) => call('getblockheader', [hash]),
  // Verbosity 1 is the cheap shape: the header's fields plus the list of
  // transaction IDs. The coinbase is tx[0], and getrawtransaction reads it out
  // of the block file without a transaction index as long as the block hash
  // comes with it. Verbosity 2 would decode every transaction in the block -
  // megabytes for one script we actually want. Both are given more time than
  // the default: a full block's ID list is a couple of hundred kilobytes of
  // JSON, and this never runs anywhere that is waiting for it.
  getBlock: (hash, verbosity = 1) => call('getblock', [hash, verbosity], { timeoutMs: 20000 }),
  getRawTransaction: (txid, blockHash) =>
    call('getrawtransaction', [txid, true, blockHash], { timeoutMs: 20000 }),
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
