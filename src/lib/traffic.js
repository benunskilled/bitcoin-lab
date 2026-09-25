'use strict';

/**
 * How much the node sends and receives, per day - in total and per peer.
 *
 * Core counts both already: getnettotals for the node, getpeerinfo for each
 * connection. Both are running totals that start at zero, the first when Core
 * starts and the second when a connection opens, so what is stored is the
 * difference between two polls, never the counter itself.
 *
 * Kept in memory between polls and written once an hour rather than on
 * every one: a poll every fifteen seconds would be a write every fifteen
 * seconds, which is exactly the load the session writer was cut down from.
 * A crash loses at most that hour of traffic, and nothing else.
 *
 * Per peer the key is the host, not the address: an inbound peer that dials
 * in again arrives on a new source port and is still the same machine
 * costing the same bandwidth. And not the peer row either - rows of
 * short-lived peers are pruned, the traffic they caused is not.
 *
 * Days are UTC days, like every other timestamp this app stores.
 */

const db = require('./db');
const { hostFromAddress } = require('./address');

let lastTotals = null;        // { recv, sent } from the previous getnettotals
const lastConn = new Map();   // Core connection id -> { host, recv, sent }
const pendingDays = new Map(); // day -> { recv, sent }
const pendingHosts = new Map(); // `${day}\t${host}` -> { recv, sent }

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

// A counter that went down was restarted - Core for the totals, a new
// connection that reused an id for a peer - so everything it shows now is new.
function delta(now, before) {
  return now >= before ? now - before : now;
}

/**
 * Take one reading. `totals` is getnettotals, `peers` is getpeerinfo, both
 * from the same poll. The very first reading only sets the baseline: what
 * the counters held before this process was watching them is not today's.
 */
function record({ totals, peers, nowMs = Date.now() }) {
  const day = dayOf(nowMs);
  const first = lastTotals == null;

  if (totals && typeof totals.totalbytesrecv === 'number') {
    const cur = { recv: totals.totalbytesrecv, sent: totals.totalbytessent };
    if (!first) add(pendingDays, day, delta(cur.recv, lastTotals.recv), delta(cur.sent, lastTotals.sent));
    lastTotals = cur;
  }

  const seen = new Set();
  for (const p of peers || []) {
    if (typeof p.id !== 'number' || typeof p.bytesrecv !== 'number') continue;
    const host = hostFromAddress(p.addr) || p.addr;
    const before = lastConn.get(p.id);
    const same = before && before.host === host;
    // A connection that opened since the last poll counts from zero. On the
    // first reading nothing counts yet, for the same reason as the totals.
    if (!first) {
      add(pendingHosts, `${day}\t${host}`,
        same ? delta(p.bytesrecv, before.recv) : p.bytesrecv,
        same ? delta(p.bytessent, before.sent) : p.bytessent);
    }
    lastConn.set(p.id, { host, recv: p.bytesrecv, sent: p.bytessent });
    seen.add(p.id);
  }
  for (const id of lastConn.keys()) if (!seen.has(id)) lastConn.delete(id);
}

/** Write what has been gathered. Cheap when there is nothing. */
function flush() {
  if (pendingDays.size === 0 && pendingHosts.size === 0) return;
  const d = db.instance;
  const dayStmt = d.prepare(
    `INSERT INTO traffic_day (day, recv, sent) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET recv = recv + excluded.recv, sent = sent + excluded.sent`,
  );
  const hostStmt = d.prepare(
    `INSERT INTO peer_traffic_day (day, host, recv, sent) VALUES (?, ?, ?, ?)
     ON CONFLICT(day, host) DO UPDATE SET recv = recv + excluded.recv, sent = sent + excluded.sent`,
  );
  d.transaction(() => {
    for (const [day, v] of pendingDays) dayStmt.run(day, v.recv, v.sent);
    for (const [key, v] of pendingHosts) {
      const [day, host] = key.split('\t');
      hostStmt.run(day, host, v.recv, v.sent);
    }
  })();
  pendingDays.clear();
  pendingHosts.clear();
}

// For tests: forget everything this process has seen.
function reset() {
  lastTotals = null;
  lastConn.clear();
  pendingDays.clear();
  pendingHosts.clear();
}

module.exports = { record, flush, reset, dayOf };
