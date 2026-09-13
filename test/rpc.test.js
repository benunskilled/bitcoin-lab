'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.LOG_LEVEL = 'error';

// A stand-in for Core, so the client can be exercised without one. Each test
// installs its own handler.
let handler = null;
const server = http.createServer((req, res) => handler(req, res));

let rpc;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.BITCOIN_RPC_HOST = '127.0.0.1';
  process.env.BITCOIN_RPC_PORT = String(server.address().port);
  process.env.BITCOIN_RPC_USER = 'u';
  process.env.BITCOIN_RPC_PASS = 'p';
  rpc = require('../src/lib/rpc');
});

test.after(async () => {
  // The keep-alive agent holds idle sockets open, which would keep the event
  // loop alive past the last test.
  rpc.agent.destroy();
  await new Promise((resolve) => server.close(resolve));
});

function respond(payload, { status = 200 } = {}) {
  handler = (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

test('a result comes back, and an error is an error', async () => {
  respond({ result: [{ id: 1 }], error: null });
  assert.deepEqual(await rpc.call('getpeerinfo'), [{ id: 1 }]);

  respond({ result: null, error: { code: -8, message: 'nope' } });
  await assert.rejects(rpc.call('getpeerinfo'), /nope \(code -8\)/);
});

test('the connection is reused instead of reopened per call', async () => {
  // What keep-alive is for. Without the shared agent every call is its own TCP
  // handshake to the same host, several thousand times a day.
  const sockets = new Set();
  handler = (req, res) => {
    sockets.add(req.socket);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: 'ok', error: null }));
  };

  for (let i = 0; i < 5; i += 1) await rpc.call('getblockcount');
  assert.equal(sockets.size, 1, 'five calls, one connection');
});

test('a response with no end to it is refused rather than held', async () => {
  // Core is trusted, so this is not about an attacker - it is about being
  // pointed at the wrong port by a typo and growing until the process dies
  // with nothing in the log to say why.
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const chunk = 'x'.repeat(1024 * 1024);
    const pump = () => {
      if (res.writableEnded || res.destroyed) return;
      if (res.write(chunk)) setImmediate(pump);
      else res.once('drain', pump);
    };
    pump();
  };

  await assert.rejects(rpc.call('getpeerinfo'), /exceeded 16777216 bytes/);
});

test('a response just under the ceiling still works', async () => {
  const big = 'y'.repeat(8 * 1024 * 1024);
  respond({ result: big, error: null });
  assert.equal((await rpc.call('getpeerinfo')).length, big.length);
});

test('malformed JSON says so, and names the method', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{not json');
  };
  await assert.rejects(rpc.call('getblockcount'), /RPC getblockcount: invalid JSON/);
});
