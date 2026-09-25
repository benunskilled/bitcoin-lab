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

test('traffic counts differences and survives a Core restart', () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);
  const totals = (recv, sent) => ({ totalbytesrecv: recv, totalbytessent: sent });

  // First reading is only the baseline: none of this is counted.
  traffic.record({ nowMs: now, totals: totals(1000, 5000) });
  // +100/+200 on the node.
  traffic.record({ nowMs: now + 15000, totals: totals(1100, 5200) });
  // Core restarted: the counters start again.
  traffic.record({ nowMs: now + 30000, totals: totals(40, 60) });
  traffic.flush();

  const t = queries.trafficDays(30, now + 60000);
  assert.deepEqual(t.today, { recv: 140, sent: 260 });
});

test('no traffic is kept per peer', () => {
  const row = db.instance.prepare(`SELECT name FROM sqlite_master WHERE name = 'peer_traffic_day'`).get();
  assert.equal(row, undefined);
});
