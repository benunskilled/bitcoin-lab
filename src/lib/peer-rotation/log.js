'use strict';

/**
 * The rotation's audit trail: every move it makes, written down, and the
 * newest few read back for the dashboard.
 *
 * Two tables, and the difference between them matters. `rotation_log` is a
 * window - exactly what the dashboard shows and not one row more. Anything
 * that has to survive that window is written separately, which today is one
 * fact: that a peer was ever promoted at all.
 */

const db = require('../db');
const config = require('../config');
const { hostFromAddress } = require('../address');

function logAction(entry) {
  db.instance
    .prepare(
      `INSERT INTO rotation_log (at, action, address, first_pct, eligible, replaced_address, replaced_first_pct, note)
       VALUES (@at, @action, @address, @firstPct, @eligible, @replacedAddress, @replacedFirstPct, @note)`,
    )
    .run({
      at: Date.now(),
      action: entry.action,
      address: entry.address,
      firstPct: entry.firstPct == null ? null : entry.firstPct,
      eligible: entry.eligible == null ? null : entry.eligible,
      replacedAddress: entry.replacedAddress || null,
      replacedFirstPct: entry.replacedFirstPct == null ? null : entry.replacedFirstPct,
      note: entry.note || null,
    });

  // Nothing is kept that is not shown. The dashboard offers the newest
  // ROTATION_LOG_ENTRIES behind its "Show all" button, so the table holds
  // exactly that many and the rest goes on the way in - no retention window to
  // reason about, no daily sweep, and no way for a misbehaving loop to leave
  // fifty thousand rows behind before anyone looks.
  //
  // id DESC is the tiebreaker, not decoration: two actions in one tick can
  // share a millisecond, and on equal `at` the order is otherwise undefined -
  // which would let this delete the newer of the two.
  db.instance
    .prepare(`DELETE FROM rotation_log WHERE id NOT IN (SELECT id FROM rotation_log ORDER BY at DESC, id DESC LIMIT ?)`)
    .run(config.rotationLogEntries);

  // The one thing above that must outlive the trim. "How many peers has this
  // ever promoted?" cannot be answered from a table that keeps thirty rows,
  // and the answer is the point of the whole loop - so a promotion is also
  // written somewhere permanent.
  //
  // Here rather than at the two call sites in promoteBestCandidate: they
  // already share beatsHolder and evictableTrusted because writing the same
  // rule out twice is how the two swap paths drifted apart in the first place.
  // Every promotion passes through logAction, so this cannot be forgotten by a
  // future third path.
  //
  // Keyed by IP, and INSERT OR IGNORE: the same host promoted again - after
  // being parked and revived, say - is not a second peer discovered.
  if (entry.action === 'promote' || entry.action === 'swap') {
    db.instance
      .prepare(`INSERT OR IGNORE INTO promoted_peer (ip, first_promoted_at) VALUES (?, ?)`)
      .run(hostFromAddress(entry.address), Date.now());
  }
}

function recentLog(limit = config.rotationLogEntries) {
  return db.instance
    .prepare(
      `SELECT id, at, action, address,
              first_pct AS firstPct, eligible,
              replaced_address AS replacedAddress, replaced_first_pct AS replacedFirstPct,
              note
       FROM rotation_log ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(limit);
}

module.exports = { logAction, recentLog };
