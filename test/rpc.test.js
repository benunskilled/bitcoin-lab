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

// --- the clock offset, read off Core's own Date header ---------------------

function respondWithDate(coreSkewMs) {
  handler = (req, res) => {
    // What Core's machine would put in the header if its clock were off by
    // coreSkewMs. HTTP dates are whole seconds and truncated, which is the
    // part the estimator has to correct for.
    res.setHeader('Date', new Date(Date.now() + coreSkewMs).toUTCString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: 'ok', error: null }));
  };
}

test('agreeing clocks read as agreeing', async () => {
  respondWithDate(0);
  for (let i = 0; i < 20; i += 1) await rpc.call('getblockcount');
  const reading = rpc.clockOffset();
  assert.ok(reading, 'something was measured');
  assert.ok(Math.abs(reading.offsetMs) < 700, `offset read as ${reading.offsetMs}ms`);
});

test('a clock five seconds behind is read as five seconds behind', async () => {
  respondWithDate(-5000);
  for (let i = 0; i < 20; i += 1) await rpc.call('getblockcount');
  const reading = rpc.clockOffset();
  assert.ok(reading.offsetMs < -4300 && reading.offsetMs > -5700, `offset read as ${reading.offsetMs}ms`);
});

test('and the sign is not lost when it goes the other way', async () => {
  respondWithDate(4000);
  for (let i = 0; i < 20; i += 1) await rpc.call('getblockcount');
  assert.ok(rpc.clockOffset().offsetMs > 3300, 'Core ahead reads positive');
});

test('the half-second of truncation is corrected, not left as a lean', async () => {
  // Without the correction every reading lands in the second below the truth,
  // so a node whose clocks agree perfectly would report itself half a second
  // behind - forever, and in the same direction.
  respondWithDate(0);
  for (let i = 0; i < 20; i += 1) await rpc.call('getblockcount');
  assert.ok(rpc.clockOffset().offsetMs > -500, 'no permanent lean towards "behind"');
});

test('a response without the header is skipped rather than guessed at', async () => {
  handler = (req, res) => {
    res.removeHeader('Date');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: 'ok', error: null }));
  };
  const before = rpc.clockOffset().samples;
  await rpc.call('getblockcount');
  assert.equal(rpc.clockOffset().samples, before, 'nothing was added');
});

test('an error response still tells us the time', async () => {
  // A node with the wrong credentials is exactly one whose clock nobody has
  // looked at either, so a 401 must not cost us the reading.
  handler = (req, res) => {
    res.setHeader('Date', new Date(Date.now() - 9000).toUTCString());
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: null, error: { code: -1, message: 'unauthorized' } }));
  };

  // Asserted on the value rather than on a sample count, because the ring is
  // capped: it is already full from the tests above, so a new reading replaces
  // an old one instead of adding to the total. And one failure among nineteen
  // good samples must not move the median anyway - that is what the median is
  // for - so the ring has to be filled with them before the reading can say
  // anything about them at all.
  for (let i = 0; i < 20; i += 1) await assert.rejects(rpc.call('getblockcount'));
  assert.ok(rpc.clockOffset().offsetMs < -8000, `read as ${rpc.clockOffset().offsetMs}ms`);
});

test('one bad reading does not move the verdict', async () => {
  respondWithDate(0);
  for (let i = 0; i < 20; i += 1) await rpc.call('getblockcount');
  respondWithDate(-30000);
  await rpc.call('getblockcount');
  assert.ok(Math.abs(rpc.clockOffset().offsetMs) < 700, 'a single wild sample is outvoted');
});

test('a template is counted by its transactions, even where a chunk splits one', async () => {
  const txs = Array.from({ length: 3000 }, (_, i) => ({ data: 'ab'.repeat(40), txid: String(i).padStart(64, '0'), fee: 150 }));
  const body = JSON.stringify({ result: { version: 1, transactions: txs }, error: null });
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Seven-byte pieces: '"txid"' is six, so plenty of them straddle a boundary.
    let i = 0;
    const next = () => {
      if (i >= body.length) return res.end();
      res.write(body.slice(i, i + 7));
      i += 7;
      setImmediate(next);
    };
    next();
  };
  const r = await rpc.timeCall('getblocktemplate', [], { count: '"txid"' });
  assert.equal(r.count, 3000);
});
