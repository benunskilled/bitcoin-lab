'use strict';

const db = require('../db');
const config = require('../config');

// Caps unbounded growth WITHOUT touching the two things that give this app
// its long-term value: relay_race/relay_observation (the actual
// peer-ranking data - never time-pruned, see config.js) and any peer that
// has ever appeared in it, or is manually trusted (kept forever, sessions
// included). Only "feeler" peers - no relay history, ever, not trusted -
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

module.exports = { pruneOldData };
