'use strict';

const db = require('../db');
const config = require('../config');

// Caps unbounded growth WITHOUT touching what gives this app its long-term
// value: every block (relay_race), and every peer that delivered one first,
// is manual or parked, or was an outbound choice (kept forever, sessions
// included). Inbound peers that never delivered first go after a month, see
// pruneNeverFirstPeers below. Only "feeler" peers - no relay history, ever, not trusted -
// and old stratum-pool history are pruned by age. Runs as one transaction,
// in dependency order, so a crash mid-prune never leaves an orphaned or
// FK-violating row behind. Returns how many rows of each kind were
// removed, purely for logging.
function pruneOldData({
  feelerPeerRetentionDays = config.feelerPeerRetentionDays,
  stratumHistoryRetentionDays = config.stratumHistoryRetentionDays,
} = {}) {
  const feelerCutoff = Date.now() - feelerPeerRetentionDays * 24 * 60 * 60 * 1000;
  const stratumCutoff = Date.now() - stratumHistoryRetentionDays * 24 * 60 * 60 * 1000;

  const tx = db.instance.transaction(() => {
    db.instance
      .prepare(`DELETE FROM stratum_observation WHERE race_id IN (SELECT id FROM stratum_race WHERE created_at < ?)`)
      .run(stratumCutoff);
    const stratumRacesDeleted = db.instance.prepare(`DELETE FROM stratum_race WHERE created_at < ?`).run(stratumCutoff).changes;

    // Only a CLOSED session (ended_at IS NOT NULL - a currently-live one is
    // never touched regardless of age) belonging to a "feeler" peer - one
    // with NO relay_observation row, ever, and not (or never) manually
    // trusted - gets removed here, and only once it's older than the much
    // shorter feeler window. A peer with real relay history, or a trusted
    // one, keeps every session forever, no matter its age.
    //
    // "Has relay history" is asked of peer_relay_stats rather than of
    // relay_observation: db.js's triggers keep exactly one row there per peer
    // that appears in relay_observation, so it is the same set of peers - one
    // row each, instead of scanning a table that is never pruned and holds one
    // row per peer per block (millions, on a node that has run for months).
    const feelerSessionsDeleted = db.instance
      .prepare(
        `DELETE FROM peer_session
         WHERE ended_at IS NOT NULL AND ended_at < ?
           AND peer_id IN (
             SELECT id FROM peer p
             WHERE p.id NOT IN (SELECT peer_id FROM peer_relay_stats)
               AND p.address NOT IN (SELECT address FROM trusted_peer)
           )`,
      )
      .run(feelerCutoff).changes;

    // A peer left with no session and no relay-observation history after
    // the delete above is pure dead weight - drop it, unless it's (or ever
    // was) manually trusted, since trusted_peer keys on address
    // independently of this table.
    const peersDeleted = db.instance
      .prepare(
        `DELETE FROM peer
         WHERE id NOT IN (SELECT DISTINCT peer_id FROM peer_session)
           AND id NOT IN (SELECT peer_id FROM peer_relay_stats)
           AND address NOT IN (SELECT address FROM trusted_peer)`,
      )
      .run().changes;

    // Rollup rows only ever exist for peers that appear in relay_observation,
    // and those peers are never pruned - so this should always be a no-op.
    // It runs anyway so the summary table can never outlive its peer and
    // silently resurrect a stale row under a recycled id.
    db.instance.prepare(`DELETE FROM peer_relay_stats WHERE peer_id NOT IN (SELECT id FROM peer)`).run();

    return { stratumRacesDeleted, feelerSessionsDeleted, peersDeleted };
  });
  return tx();
}

// Inbound peers that were around for blocks but never delivered one first,
// and have not been seen for neverFirstPeerRetentionDays (see config.js).
// Only inbound: an outbound peer was Core's or the rotation's choice, and the
// outbound funnel counts every one it ever tried. Each step is its own
// transaction with the choice inside it - the relay profiler writes from
// another process - and a step holds at most about 20,000 observation rows,
// so the write lock the other processes wait on (10 s) is never held long.
const MAX_ROWS_PER_STEP = 20000;

function pruneNeverFirstPeers({ days = config.neverFirstPeerRetentionDays, maxSteps = 40 } = {}) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const pick = db.instance.prepare(
    `SELECT p.id, s.eligible FROM peer_relay_stats s JOIN peer p ON p.id = s.peer_id
      WHERE s.first = 0
        AND p.first_seen_at < @cutoff
        AND p.address NOT IN (SELECT address FROM trusted_peer)
        AND p.address NOT IN (SELECT address FROM parked_peer)
        AND NOT EXISTS (SELECT 1 FROM peer_session x WHERE x.peer_id = p.id
                         AND (x.direction <> 'inbound' OR x.ended_at IS NULL OR x.ended_at >= @cutoff))
        -- Around for a block lately (a peer back after a month has no session
        -- row for its first seconds), or a first the totals do not show yet.
        AND NOT EXISTS (SELECT 1 FROM relay_observation o WHERE o.peer_id = p.id
                         AND (o.first = 1 OR o.race_id >= (SELECT COALESCE(MIN(id), 1e18) FROM relay_race WHERE detected_at >= @cutoff)))
      LIMIT 500`,
  );
  const step = db.instance.transaction(() => {
    const ids = [];
    let rows = 0;
    for (const r of pick.all({ cutoff })) {
      if (ids.length && rows + r.eligible > MAX_ROWS_PER_STEP) break;
      ids.push(r.id);
      rows += r.eligible;
    }
    if (!ids.length) return 0;
    const list = ids.map(() => '?').join(',');
    db.instance.prepare(`DELETE FROM relay_observation WHERE peer_id IN (${list})`).run(...ids);
    db.instance.prepare(`DELETE FROM peer_session WHERE peer_id IN (${list})`).run(...ids);
    db.instance.prepare(`DELETE FROM peer_relay_stats WHERE peer_id IN (${list})`).run(...ids);
    return db.instance.prepare(`DELETE FROM peer WHERE id IN (${list})`).run(...ids).changes;
  });
  let removed = 0;
  for (let i = 0; i < maxSteps; i += 1) {
    const n = step();
    if (!n) break;
    removed += n;
  }
  return removed;
}

module.exports = { pruneOldData, pruneNeverFirstPeers };
