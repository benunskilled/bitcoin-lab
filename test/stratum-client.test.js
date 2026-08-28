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

  const notify = { method: 'mining.notify', params: ['j', 'abc123', '', '', [], '', '', '', false] };
  const line = `${JSON.stringify(notify)}\n`;
  const mid = Math.floor(line.length / 2);

  conn._handleChunk(Buffer.from(line.slice(0, mid)), process.hrtime.bigint());
  assert.equal(captured, null, 'should not fire until the line is complete');
  conn._handleChunk(Buffer.from(line.slice(mid)), process.hrtime.bigint());

  assert.ok(captured);
  assert.equal(captured.prevhash, 'abc123');
});

test('ignores non-notify methods', () => {
  const conn = new StratumPoolConnection({ host: 'example.invalid', port: 3333, label: 'test' });
  let fired = false;
  conn.on('notify', () => { fired = true; });
  conn._handleChunk(Buffer.from(`${JSON.stringify({ id: 1, result: true, error: null })}\n`), process.hrtime.bigint());
  assert.equal(fired, false);
});
