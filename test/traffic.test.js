'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-traffic-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'test.db');
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = 'error';

const db = require('../src/lib/db');
const traffic = require('../src/lib/traffic');
const queries = require('../src/lib/queries');

test.before(() => db.open());
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('traffic counts differences, survives a Core restart, and starts new connections at zero', () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);
  const peer = (id, addr, recv, sent) => ({ id, addr, bytesrecv: recv, bytessent: sent });
  const totals = (recv, sent) => ({ totalbytesrecv: recv, totalbytessent: sent });

  // First reading is only the baseline: none of this is counted.
  traffic.record({ nowMs: now, totals: totals(1000, 5000), peers: [peer(1, '198.51.100.7:8333', 400, 900)] });
  // +100/+200 on the node; the peer grows, and a new inbound connection arrives.
  traffic.record({ nowMs: now + 15000, totals: totals(1100, 5200),
    peers: [peer(1, '198.51.100.7:8333', 450, 1000), peer(2, '203.0.113.9:51234', 30, 70)] });
  // Core restarted: counters start again, and ids are reused for other hosts.
  traffic.record({ nowMs: now + 30000, totals: totals(40, 60),
    peers: [peer(1, '203.0.113.9:40000', 5, 8)] });
  traffic.flush();

  const t = queries.trafficDays(30, now + 60000);
  assert.deepEqual(t.today, { recv: 140, sent: 260 });
  const byHost = Object.fromEntries(queries.trafficPeers(7, 10, now + 60000).map((r) => [r.host, [r.recv, r.sent]]));
  assert.deepEqual(byHost['198.51.100.7'], [50, 100]);
  // Same machine on a new port and a new connection id: one host, both counted.
  assert.deepEqual(byHost['203.0.113.9'], [35, 78]);
});
