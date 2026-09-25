'use strict';

/**
 * How much the node sends and receives, per day.
 *
 * Core counts it already: getnettotals is a running total that starts at zero
 * when Core starts, so what is stored is the difference between two polls,
 * never the counter itself.
 *
 * Kept in memory between polls and written once an hour rather than on
 * every one: a poll every fifteen seconds would be a write every fifteen
 * seconds, which is exactly the load the session writer was cut down from.
 * A crash loses at most that hour of traffic, and nothing else.
 *
 * Days are UTC days, like every other timestamp this app stores.
 */

const db = require('./db');

let lastTotals = null;         // { recv, sent } from the previous getnettotals
const pendingDays = new Map(); // day -> { recv, sent }

function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function add(map, key, recv, sent) {
  if (recv <= 0 && sent <= 0) return;
  const cur = map.get(key) || { recv: 0, sent: 0 };
  cur.recv += Math.max(0, recv);
  cur.sent += Math.max(0, sent);
  map.set(key, cur);
}

// A counter that went down was restarted with Core, so everything it shows
// now is new.
function delta(now, before) {
  return now >= before ? now - before : now;
}

/**
 * Take one reading of getnettotals. The very first reading only sets the
 * baseline: what the counters held before this process was watching them is
 * not today's.
 */
function record({ totals, nowMs = Date.now() }) {
  if (!totals || typeof totals.totalbytesrecv !== 'number') return;
  const cur = { recv: totals.totalbytesrecv, sent: totals.totalbytessent };
  if (lastTotals) add(pendingDays, dayOf(nowMs), delta(cur.recv, lastTotals.recv), delta(cur.sent, lastTotals.sent));
  lastTotals = cur;
}

/** Write what has been gathered. Cheap when there is nothing. */
function flush() {
  if (pendingDays.size === 0) return;
  const d = db.instance;
  const dayStmt = d.prepare(
    `INSERT INTO traffic_day (day, recv, sent) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET recv = recv + excluded.recv, sent = sent + excluded.sent`,
  );
  d.transaction(() => {
    for (const [day, v] of pendingDays) dayStmt.run(day, v.recv, v.sent);
  })();
  pendingDays.clear();
}

// For tests: forget everything this process has seen.
function reset() {
  lastTotals = null;
  pendingDays.clear();
}

module.exports = { record, flush, reset, dayOf };
