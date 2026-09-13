'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-zmq-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const health = require('../src/lib/health');
const { server } = require('../src/dashboard-server');
const subscriber = require('../src/lib/hashblock-subscriber');

const HOUR = 60 * 60 * 1000;
let baseUrl;
let listener;

test.before(async () => {
  db.open();
  listener = server;
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${listener.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => listener.close(resolve));
});

function getHealth() {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}/api/health`, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

// Write the relay profiler's heartbeat as if it were sent just now, carrying
// whatever subscription state the test wants to describe.
function beat(extra) {
  health.write(db, 'relay-profiler', extra);
  health.write(db, 'peer-profiler', {});
  health.write(db, 'stratum-race', {});
}

test('the subscriber records when it started, so "never" can be measured', () => {
  // zmq's connect() does not connect, so a subscription pointed at nothing
  // looks healthy forever. Without a start time, "no block since boot" and "a
  // block a second ago" are the same null.
  const before = Date.now();
  const sub = subscriber.start({
    url: 'tcp://127.0.0.1:1',   // nothing is listening, and zmq will not mind
    logger: { info() {}, warn() {}, error() {} },
    onBlock() {},
  });
  assert.ok(sub.state.startedAtMs >= before, 'the start instant is recorded');
  assert.equal(sub.state.lastBlockAtMs, null, 'and no block has arrived');
  sub.stop();
});

test('a block a moment ago is quiet', async () => {
  beat({ zmqConnected: true, lastBlockAtMs: Date.now() - 60_000, subscribedAtMs: Date.now() - HOUR });
  const report = await getHealth();
  assert.equal(report.zmq.ok, true);
});

test('a long but real gap is still quiet', async () => {
  // The longest gap recorded on a live node is 78 minutes, but the sample is
  // fifteen days and cannot see the tail; gaps around 150 minutes do happen,
  // more often than a constant-rate model predicts. Anything in that range has
  // to pass without a word.
  for (const hours of [2, 2.5, 3, 4]) {
    beat({ zmqConnected: true, lastBlockAtMs: Date.now() - hours * HOUR, subscribedAtMs: Date.now() - 9 * HOUR });
    const report = await getHealth();
    assert.equal(report.zmq.ok, true, `${hours}h is a quiet network, not a fault`);
  }
});

test('six hours without a block is reported, connected or not', async () => {
  // The point of the whole thing: zmqConnected says true because it always
  // says true, and the process is writing a healthy heartbeat every thirty
  // seconds while recording nothing.
  beat({ zmqConnected: true, lastBlockAtMs: Date.now() - 7 * HOUR, subscribedAtMs: Date.now() - 12 * HOUR });
  const report = await getHealth();
  assert.equal(report.services['relay-profiler'].ok, true, 'the worker itself is alive and well');
  assert.equal(report.zmq.ok, false, 'and still nothing is arriving');
  assert.equal(report.zmq.everReceived, true);
});

test('an install that has never received a block is caught by the same rule', async () => {
  // ZMQ not configured, a wrong port, a firewall. The app sits there looking
  // perfectly healthy and empty.
  beat({ zmqConnected: true, lastBlockAtMs: null, subscribedAtMs: Date.now() - 7 * HOUR });
  const report = await getHealth();
  assert.equal(report.zmq.ok, false);
  assert.equal(report.zmq.everReceived, false, 'and it is told apart from a stall that started later');
});

test('a fresh start is given its six hours like anything else', async () => {
  beat({ zmqConnected: true, lastBlockAtMs: null, subscribedAtMs: Date.now() - 60_000 });
  const report = await getHealth();
  assert.equal(report.zmq.ok, true, 'a minute-old process has not failed at anything yet');
});

test('a dead worker is left to the heartbeat, not reported twice', async () => {
  health.write(db, 'peer-profiler', {});
  health.write(db, 'stratum-race', {});
  db.instance
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run('heartbeat:relay-profiler', JSON.stringify({ at: Date.now() - 10 * 60_000, zmqConnected: true, lastBlockAtMs: null }));
  const report = await getHealth();
  assert.equal(report.services['relay-profiler'].ok, false, 'the stale heartbeat is the report');
  assert.equal(report.zmq, null, 'and this one stays quiet rather than saying the same thing again');
});

test('a worker too old to report its subscription is not accused of anything', async () => {
  // What a running install looks like in the seconds after an update, while
  // the old relay profiler is still the one writing heartbeats.
  beat({ zmqConnected: true });
  const report = await getHealth();
  assert.equal(report.zmq, null);
});
