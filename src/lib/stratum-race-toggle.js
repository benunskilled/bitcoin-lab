'use strict';

/**
 * The Stratum Race on/off switch.
 *
 * Its own small module because two processes need it and neither should have
 * to require the other: the stratum-race worker reads it to decide whether to
 * hold any pool connections at all, and the dashboard reads and writes it for
 * the switch on the page.
 *
 * Off means off in the only sense that matters here - no TCP connection to any
 * pool, public or local, and no new measurements. It does not stop the
 * container: the worker has to keep writing its heartbeat or Docker's
 * healthcheck would restart it in a loop (see health.js). What it costs while
 * switched off is one idle Node process.
 *
 * Absent means off, like the rotation. Existing installs are switched on by a
 * migration instead (see db.js), because for them the race has been running
 * since the day they installed it and an update must not quietly take that
 * away.
 */

const db = require('./db');
const logger = require('./logger').make('stratum-race');

const META_KEY = 'stratum_race_enabled';

function isEnabled() {
  const row = db.instance.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY);
  return row ? row.value === '1' : false;
}

function setEnabled(enabled) {
  db.instance
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(META_KEY, enabled ? '1' : '0');
  logger.info('stratum race toggled', { enabled: Boolean(enabled) });
}

module.exports = { isEnabled, setEnabled, META_KEY };
