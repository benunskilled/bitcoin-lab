'use strict';

/**
 * Liveness heartbeats.
 *
 * Three of the four services have no HTTP port, so there was previously no
 * way - for Docker or for the dashboard - to tell "running and working" from
 * "crash-looping" or "wedged". Each service now writes a timestamp into the
 * shared `meta` table on a fixed schedule; a stale timestamp is the signal.
 *
 * The heartbeat is written on a timer of its own rather than as a side
 * effect of real work, because two of these services are event-driven: the
 * relay profiler only sees traffic when a block arrives (~10 minutes apart,
 * with no upper bound), so "no work done recently" is a perfectly healthy
 * state for it and must not read as a fault.
 */

const HEARTBEAT_INTERVAL_MS = 30_000;

function key(service) {
  return `heartbeat:${service}`;
}

function write(db, service, extra) {
  const payload = JSON.stringify({ at: Date.now(), ...(extra || {}) });
  db.instance
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key(service), payload);
}

function read(db, service) {
  const row = db.instance.prepare(`SELECT value FROM meta WHERE key = ?`).get(key(service));
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/**
 * Starts the periodic heartbeat for a service and writes one immediately, so
 * a container is reported healthy as soon as it is genuinely up rather than
 * after a first full interval. `details` is called on every beat and may
 * return small extra fields (e.g. whether the ZMQ socket is connected).
 */
function start(db, service, logger, details) {
  const beat = () => {
    try {
      write(db, service, typeof details === 'function' ? details() : undefined);
    } catch (err) {
      // A failed heartbeat is itself a symptom, but it must never be the
      // thing that takes the service down.
      logger.debug('heartbeat write failed', { error: err.message });
    }
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Read-only staleness check used by the container healthchecks. Opens its
 * own short-lived read-only connection so it never competes for a write
 * lock with the service it is checking. Exits non-zero (rather than
 * throwing) so it can be driven straight from `node -e` in a HEALTHCHECK.
 */
function assertFresh(service, maxAgeMs) {
  const Database = require('better-sqlite3');
  const config = require('./config');
  let handle;
  try {
    handle = new Database(config.sqlitePath, { readonly: true, fileMustExist: true });
    const row = handle.prepare(`SELECT value FROM meta WHERE key = ?`).get(key(service));
    if (!row) {
      process.stderr.write(`no heartbeat recorded for ${service}\n`);
      process.exit(1);
    }
    const { at } = JSON.parse(row.value);
    const ageMs = Date.now() - at;
    if (ageMs > maxAgeMs) {
      process.stderr.write(`${service} heartbeat is ${Math.round(ageMs / 1000)}s old (max ${Math.round(maxAgeMs / 1000)}s)\n`);
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`healthcheck failed for ${service}: ${err.message}\n`);
    process.exit(1);
  } finally {
    try { if (handle) handle.close(); } catch { /* already closing down */ }
  }
}

module.exports = { start, write, read, assertFresh, HEARTBEAT_INTERVAL_MS };
