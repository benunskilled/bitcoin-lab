'use strict';

/**
 * Peer Profiler - periodically snapshots getpeerinfo and maintains a
 * historical record of peer sessions (connection type, ping, duration).
 * This is purely informational bookkeeping; it never decides block-race
 * timing (see relay-profiler.js for that).
 */

const config = require('./lib/config');
const db = require('./lib/db');
const rpc = require('./lib/rpc');
const logger = require('./lib/logger').make('peer-profiler');
const { syncTrustedToAddnode, adoptExternalManualPeers } = require('./lib/peer-sync');
const queries = require('./lib/queries');

function upsertSessions(peers) {
  const database = db.instance;
  const nowMs = Date.now();
  const currentAddrs = new Set(peers.map((p) => p.addr));

  const openSessions = database
    .prepare(
      `SELECT ps.id, ps.peer_id, p.address
       FROM peer_session ps JOIN peer p ON p.id = ps.peer_id
       WHERE ps.ended_at IS NULL`,
    )
    .all();

  const closeStmt = database.prepare(`UPDATE peer_session SET ended_at = ? WHERE id = ?`);
  const openByAddress = new Map();
  const tx1 = database.transaction(() => {
    for (const s of openSessions) {
      if (!currentAddrs.has(s.address)) {
        closeStmt.run(nowMs, s.id);
      } else {
        openByAddress.set(s.address, s.id);
      }
    }
  });
  tx1();

  const insertSession = database.prepare(
    `INSERT INTO peer_session
       (peer_id, core_peer_id, direction, connection_type, subver, started_at, min_ping_ms, last_ping_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateSession = database.prepare(
    `UPDATE peer_session
     SET core_peer_id = ?, direction = ?, connection_type = ?, subver = ?, min_ping_ms = ?, last_ping_ms = ?
     WHERE id = ?`,
  );

  const tx2 = database.transaction(() => {
    for (const peer of peers) {
      const peerRow = db.getOrCreatePeer(peer.addr);
      const direction = peer.inbound ? 'inbound' : 'outbound';
      const connectionType = peer.connection_type || (peer.inbound ? 'inbound' : 'unknown');
      const minPingMs = typeof peer.minping === 'number' ? peer.minping * 1000 : null;
      const lastPingMs = typeof peer.pingtime === 'number' ? peer.pingtime * 1000 : null;

      const existingSessionId = openByAddress.get(peer.addr);
      if (existingSessionId) {
        updateSession.run(peer.id, direction, connectionType, peer.subver || null, minPingMs, lastPingMs, existingSessionId);
      } else {
        // conntime is Core's own unix-second connection start - more
        // accurate than "now" for a connection we're only just noticing.
        const startedAt = typeof peer.conntime === 'number' ? peer.conntime * 1000 : nowMs;
        insertSession.run(peerRow.id, peer.id, direction, connectionType, peer.subver || null, startedAt, minPingMs, lastPingMs);
      }
    }
  });
  tx2();
}

// Core reconnects a manual/trusted peer on its own, but that can silently
// stall (peer went dark, network hiccup, a full manual-slot cap) - the
// dashboard shows this at a glance, but not everyone has it open, so also
// log it periodically for visibility via `docker logs` and to leave a
// durable record of when/how long a manual peer was actually down.
function logOfflineTrustedPeers() {
  const offline = queries.peerRanking().filter((p) => p.trusted && !p.live);
  if (offline.length === 0) return;

  for (const p of offline) {
    logger.warn('trusted peer currently offline', {
      address: p.address,
      label: p.trustedLabel || undefined,
      offlineFor: p.offlineSinceMs != null ? `${Math.round(p.offlineSinceMs / 60000)}m` : 'never seen connecting',
    });
  }
}

async function pollOnce() {
  let peers;
  try {
    peers = await rpc.getPeerInfo();
  } catch (err) {
    logger.warn('getpeerinfo failed', { error: err.message });
    return;
  }
  upsertSessions(peers);
  logger.debug('poll complete', { peers: peers.length });
}

// Keeps the historical tables (and the SQLite file itself) from growing
// forever - see config.js dataRetentionDays. Runs once shortly after
// startup (so a fresh install doesn't wait a full day for its first prune)
// and then daily; each run is independent and cheap to skip if it fails, so
// a single bad run never blocks peer polling or leaves the DB stuck.
function runMaintenance() {
  try {
    const result = queries.pruneOldData();
    logger.info('data retention prune complete', { retentionDays: config.dataRetentionDays, ...result });
  } catch (err) {
    logger.warn('data retention prune failed', { error: err.message });
  }
  try {
    if (db.maybeVacuum()) logger.info('vacuumed sqlite database to reclaim pruned space');
  } catch (err) {
    logger.warn('vacuum failed', { error: err.message });
  }
}

async function main() {
  db.open();
  logger.info('starting', { intervalMs: config.peerPollIntervalMs });

  // Pull in any peer Core already has addnode'd that we don't know about
  // yet (added outside this app) before pushing our own list back out -
  // see adoptExternalManualPeers for why this direction is needed too.
  const adoptResult = await adoptExternalManualPeers();
  if (adoptResult.adopted > 0) logger.info('startup: adopted externally-managed manual peers', adoptResult);

  const syncResult = await syncTrustedToAddnode();
  logger.info('startup trusted/addnode sync', syncResult);

  await pollOnce();
  setInterval(pollOnce, config.peerPollIntervalMs);
  // Safety net: re-run both directions periodically - re-assert trusted
  // peers as addnodes in case Core forgot them across a restart of the
  // bitcoin app itself, and adopt anything newly addnode'd outside this app
  // (e.g. a direct `bitcoin-cli addnode` call) since the last pass.
  setInterval(() => {
    adoptExternalManualPeers()
      .then(() => syncTrustedToAddnode())
      .catch((err) => logger.warn('periodic peer sync failed', { error: err.message }));
    try {
      logOfflineTrustedPeers();
    } catch (err) {
      logger.warn('offline-trusted-peer check failed', { error: err.message });
    }
  }, 10 * 60 * 1000);

  runMaintenance();
  setInterval(runMaintenance, 24 * 60 * 60 * 1000);
}

main().catch((err) => {
  logger.error('fatal', { error: err.stack || err.message });
  process.exit(1);
});
