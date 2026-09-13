'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StratumPoolConnection } = require('../src/lib/stratum-client');

test('emits notify with prevhash on a well-formed mining.notify line', () => {
  const conn = new StratumPoolConnection({ host: 'example.invalid', port: 3333, label: 'test' });
  let captured = null;
  conn.on('notify', (payload) => { captured = payload; });

  const notify = {
    id: null,
    method: 'mining.notify',
    params: ['job1', 'deadbeef'.repeat(8), '', '', [], '20000000', '1d00ffff', '5f5e100', true],
  };
  conn._handleChunk(Buffer.from(`${JSON.stringify(notify)}\n`), process.hrtime.bigint());

  assert.ok(captured);
  assert.equal(captured.prevhash, 'deadbeef'.repeat(8));
  assert.equal(captured.cleanJobs, true);
});

test('ignores malformed JSON lines without throwing', () => {
  const conn = new StratumPoolConnection({ host: 'example.invalid', port: 3333, label: 'test' });
  assert.doesNotThrow(() => conn._handleChunk(Buffer.from('{not json\n'), process.hrtime.bigint()));
});

test('buffers a message split across two chunks', () => {
  const conn = new StratumPoolConnection({ host: 'example.invalid', port: 3333, label: 'test' });
  let captured = null;
  conn.on('notify', (payload) => { captured = payload; });

  const hash = 'a'.repeat(64);
  const notify = { method: 'mining.notify', params: ['j', hash, '', '', [], '', '', '', false] };
  const line = `${JSON.stringify(notify)}\n`;
  const mid = Math.floor(line.length / 2);

  conn._handleChunk(Buffer.from(line.slice(0, mid)), process.hrtime.bigint());
  assert.equal(captured, null, 'should not fire until the line is complete');
  conn._handleChunk(Buffer.from(line.slice(mid)), process.hrtime.bigint());

  assert.ok(captured);
  assert.equal(captured.prevhash, hash);
});

test('ignores non-notify methods', () => {
  const conn = new StratumPoolConnection({ host: 'example.invalid', port: 3333, label: 'test' });
  let fired = false;
  conn.on('notify', () => { fired = true; });
  conn._handleChunk(Buffer.from(`${JSON.stringify({ id: 1, result: true, error: null })}\n`), process.hrtime.bigint());
  assert.equal(fired, false);
});

test('emits authorizeResult for the mining.authorize response (id 2)', () => {
  const conn = new StratumPoolConnection({ host: 'example.invalid', port: 3333, label: 'test' });
  let captured = null;
  conn.on('authorizeResult', (payload) => { captured = payload; });

  conn._handleChunk(Buffer.from(`${JSON.stringify({ id: 2, result: true, error: null })}\n`), process.hrtime.bigint());
  assert.deepEqual(captured, { ok: true, error: null });

  conn._handleChunk(Buffer.from(`${JSON.stringify({ id: 2, result: false, error: [24, 'unauthorized-worker', null] })}\n`), process.hrtime.bigint());
  assert.equal(captured.ok, false);
  assert.ok(captured.error);
});

test('a mining.notify whose prevhash is not a block hash is refused', () => {
  // The prevhash is an identity everything downstream trusts: it keys the open
  // race, the stratum_race row and the stale-job check. A pool is somebody
  // else's server, so the shape is checked here rather than assumed.
  const conn = new StratumPoolConnection({ host: 'example.invalid', port: 3333, label: 'test' });
  let fired = 0;
  let refused = 0;
  conn.on('notify', () => { fired += 1; });
  conn.on('protocolError', () => { refused += 1; });

  const send = (prevhash) => conn._handleChunk(
    Buffer.from(`${JSON.stringify({ method: 'mining.notify', params: ['j', prevhash, '', '', [], '', '', '', false] })}\n`),
    process.hrtime.bigint(),
  );

  send('not-a-hash');
  send('a'.repeat(63));
  send('a'.repeat(65));
  send('g'.repeat(64));
  send(null);
  send(12345);
  assert.equal(fired, 0, 'none of these open a race');
  assert.equal(refused, 6, 'and each one is reported rather than silently dropped');

  send('b'.repeat(64));
  assert.equal(fired, 1, 'a real one still gets through');
});

test('a pool that never sends a newline does not grow the buffer without limit', () => {
  const conn = new StratumPoolConnection({ host: 'example.invalid', port: 3333, label: 'test' });
  let reported = null;
  conn.on('protocolError', (info) => { reported = info; });
  // No socket assigned, so the destroy below is a no-op - what is under test
  // is that the buffer is released and the connection asked to go.
  for (let i = 0; i < 3; i += 1) {
    conn._handleChunk(Buffer.from('x'.repeat(64 * 1024)), process.hrtime.bigint());
  }

  assert.ok(reported, 'the pool is reported');
  assert.equal(reported.reason, 'line exceeds maximum size');
  assert.equal(conn.buffer.length, 0, 'and the buffer is not still holding it');
});

test('a long burst of complete lines is not mistaken for one oversized line', () => {
  const conn = new StratumPoolConnection({ host: 'example.invalid', port: 3333, label: 'test' });
  let fired = 0;
  let reported = 0;
  conn.on('notify', () => { fired += 1; });
  conn.on('protocolError', () => { reported += 1; });

  // Well over the limit in total, but every line is terminated.
  const line = `${JSON.stringify({ method: 'mining.notify', params: ['j', 'c'.repeat(64), '', '', [], '', '', '', false] })}\n`;
  conn._handleChunk(Buffer.from(line.repeat(2000)), process.hrtime.bigint());

  assert.equal(fired, 2000, 'every line is handled');
  assert.equal(reported, 0, 'and nothing is reported');
});
