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
const health = require('./lib/health');
const processGuard = require('./lib/process-guard');
const logger = require('./lib/logger').make('peer-profiler');
const { syncTrustedToAddnode, adoptExternalManualPeers } = require('./lib/peer-sync');
const queries = require('./lib/queries');
const traffic = require('./lib/traffic');
const peerRotation = require('./lib/peer-rotation');

const PEER_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// How often the "still offline" reminder may repeat for a peer that stays
// down. Transitions are always logged immediately; this only governs the
// periodic re-statement.
const OFFLINE_REMINDER_INTERVAL_MS = 60 * 60 * 1000;

// How far last_ping_ms may drift before the row it sits in is worth rewriting.
//
// The poll used to UPDATE every open session on every pass - around 200 rows
// every 15 seconds on a well-connected node, near enough 100MB of WAL a day -
// and almost none of those writes carried news. Core's pingtime is a float in
// seconds, so it differs from the last reading essentially always, and the
// difference is the jitter of a single round trip rather than a change in the
// connection. Writing it down cost a page per row and told nobody anything:
// nothing in the app renders last_ping_ms at all, and the ping the dashboard
// shows and ranks by is min_ping_ms.
//
// 5ms is chosen to be below anything that would read as a change in the link
// and above everything that is measurement noise: a peer on the far side of an
// ocean answers in 150-300ms, one a few hops away in single digits, and
// neither becomes a different peer because a reading moved by two. A peer
// whose latency genuinely shifts - a route change, congestion, a move to
// another continent - moves by far more than this and is still recorded on the
// very next poll.
//
// min_ping_ms is deliberately NOT subject to it. That column is a minimum, so
// a decrease is the entire information it carries, and it is written whenever
// it drops by any amount at all.
const PING_DRIFT_MS = 5;

// Is any part of this row's stored state actually out of date?
//
// `stored` is the open session as it is in the database, `next` the values
// this poll would write - already merged with what is stored, so a field Core
// did not report this time compares equal instead of looking like a change to
// null. The three COALESCE columns (services, relay_txes, synced_headers)
// follow the statement's own rule: a null from Core is "not reported", which
// changes nothing, so it is not a reason to write.
function needsWrite(stored, next) {
  if (stored.core_peer_id !== next.corePeerId) return true;
  if (stored.direction !== next.direction) return true;
  if (stored.connection_type !== next.connectionType) return true;
  if (stored.network !== next.network) return true;
  if (stored.subver !== next.subver) return true;
  if (stored.min_ping_ms !== next.minPingMs) return true;
  if (next.services !== null && stored.services !== next.services) return true;
  if (next.relayTxes !== null && stored.relay_txes !== next.relayTxes) return true;
  if (next.syncedHeaders !== null && stored.synced_headers !== next.syncedHeaders) return true;
  if (stored.last_ping_ms == null || next.lastPingMs == null) return stored.last_ping_ms !== next.lastPingMs;
  return Math.abs(next.lastPingMs - stored.last_ping_ms) >= PING_DRIFT_MS;
}

function upsertSessions(peers) {
  const database = db.instance;
  const nowMs = Date.now();

  // Every column the update below can touch is read back here, not just the
  // ones the session-matching needs: a row is only worth rewriting if one of
  // them actually moved (see needsWrite).
  const openSessions = database
    .prepare(
      `SELECT ps.id, ps.peer_id, ps.core_peer_id, ps.started_at, ps.direction, ps.connection_type,
              ps.network, ps.subver, ps.min_ping_ms, ps.last_ping_ms, ps.services, ps.relay_txes,
              ps.synced_headers, p.address
       FROM peer_session ps JOIN peer p ON p.id = ps.peer_id
       WHERE ps.ended_at IS NULL`,
    )
    .all();

  const closeStmt = database.prepare(`UPDATE peer_session SET ended_at = ? WHERE id = ?`);
  const openByAddress = new Map();
  // Same address in the snapshot is not the same session. Core hands every
  // connection its own transient peer id and reports `conntime` per session,
  // so a peer that dropped and came back between two polls (15s apart) is
  // detectable - and it happens routinely, not rarely: adding a live peer as
  // manual disconnects it on purpose so Core re-dials it as a manual
  // connection, and every rotation kick does the same. Matching on address
  // alone kept writing into the *old* row, so the session count never moved,
  // the downtime was counted as connected time, and the whole historical
  // session was retroactively relabelled with the new connection type.
  const isSameSession = (stored, peer) => {
    if (stored.core_peer_id != null && typeof peer.id === 'number') return stored.core_peer_id === peer.id;
    // No id to compare (older rows) - fall back to conntime, allowing a
    // second of slack for Core's own second-resolution rounding.
    if (typeof peer.conntime !== 'number') return true;
    return peer.conntime * 1000 <= stored.started_at + 1000;
  };
  const peerByAddress = new Map(peers.map((p) => [p.addr, p]));
  const tx1 = database.transaction(() => {
    for (const s of openSessions) {
      const peer = peerByAddress.get(s.address);
      if (!peer) {
        closeStmt.run(nowMs, s.id);
      } else if (!isSameSession(s, peer)) {
        // Reconnected since the last poll. Close the old session at the
        // connection time of the new one rather than "now", so the gap lands
        // outside both sessions instead of being credited to the old one.
        const endedAt = typeof peer.conntime === 'number' ? peer.conntime * 1000 : nowMs;
        closeStmt.run(Math.max(s.started_at, Math.min(endedAt, nowMs)), s.id);
      } else {
        openByAddress.set(s.address, s);
      }
    }
  });
  tx1();

  const insertSession = database.prepare(
    `INSERT INTO peer_session
       (peer_id, core_peer_id, direction, connection_type, network, subver, started_at, min_ping_ms, last_ping_ms,
        services, relay_txes, synced_headers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // COALESCE on the three new columns, not plain assignment: a poll where Core
  // omits a field must not erase what an earlier poll recorded. It also
  // backfills a session that was already open when the columns were added.
  const updateSession = database.prepare(
    `UPDATE peer_session
     SET core_peer_id = ?, direction = ?, connection_type = ?, network = ?, subver = ?, min_ping_ms = ?, last_ping_ms = ?,
         services = COALESCE(?, services), relay_txes = COALESCE(?, relay_txes),
         synced_headers = COALESCE(?, synced_headers)
     WHERE id = ?`,
  );

  const tx2 = database.transaction(() => {
    for (const peer of peers) {
      const peerRow = db.getOrCreatePeer(peer.addr);
      const direction = peer.inbound ? 'inbound' : 'outbound';
      const connectionType = peer.connection_type || (peer.inbound ? 'inbound' : 'unknown');
      const minPingMs = typeof peer.minping === 'number' ? peer.minping * 1000 : null;
      const lastPingMs = typeof peer.pingtime === 'number' ? peer.pingtime * 1000 : null;

      // Core's own classification of the connection. Kept as it comes, in
      // Core's spelling, so the mapping to a display name lives in one place
      // (queries/ranking-row.js) instead of being spread over the writer and the reader.
      const network = peer.network || null;

      // An empty array is a fact - the peer advertises NODE_NONE - so it is
      // kept as '' and only a missing field becomes NULL.
      const services = Array.isArray(peer.servicesnames) ? peer.servicesnames.join(',') : null;
      const relayTxes = typeof peer.relaytxes === 'boolean' ? (peer.relaytxes ? 1 : 0) : null;
      const syncedHeaders = typeof peer.synced_headers === 'number' ? peer.synced_headers : null;

      const stored = openByAddress.get(peer.addr);
      if (stored) {
        // min_ping_ms and last_ping_ms are plain assignments in the statement,
        // not COALESCE, so what is bound here has to be the merged value
        // rather than this poll's reading.
        //
        // The minimum is kept as a minimum: Core reports minping per session
        // and only ever lowers it, but a poll that omits it entirely (no ping
        // round trip has completed since a reconnect) would otherwise write
        // NULL over a real measurement, and a poll that reported a higher
        // number would overwrite the lowest one this session ever saw. Both
        // lose the one thing the column exists to hold.
        const next = {
          corePeerId: peer.id ?? null,
          direction,
          connectionType,
          network,
          subver: peer.subver || null,
          minPingMs: minPingMs == null
            ? stored.min_ping_ms
            : Math.min(minPingMs, stored.min_ping_ms ?? minPingMs),
          lastPingMs: lastPingMs == null ? stored.last_ping_ms : lastPingMs,
          services,
          relayTxes,
          syncedHeaders,
        };
        if (needsWrite(stored, next)) {
          updateSession.run(next.corePeerId, next.direction, next.connectionType, next.network, next.subver,
            next.minPingMs, next.lastPingMs, next.services, next.relayTxes, next.syncedHeaders, stored.id);
        }
      } else {
        // conntime is Core's own unix-second connection start - more
        // accurate than "now" for a connection we're only just noticing.
        const startedAt = typeof peer.conntime === 'number' ? peer.conntime * 1000 : nowMs;
        insertSession.run(peerRow.id, peer.id, direction, connectionType, network, peer.subver || null, startedAt, minPingMs, lastPingMs,
          services, relayTxes, syncedHeaders);
      }
    }
  });
  tx2();
}

// Core reconnects a manual/trusted peer on its own, but that can silently
// stall (peer went dark, network hiccup, a full manual-slot cap) - the
// dashboard shows this at a glance, but not everyone has it open, so also
// log it for visibility via `docker logs` and to leave a durable record of
// when a manual peer went down and when it came back.
//
// Logged on STATE CHANGE, with an hourly reminder while a peer stays down.
// It used to emit one warn line per offline peer every ten minutes
// unconditionally, so a manual peer that was gone for a week produced around
// a thousand identical lines - which made `docker logs` useless for exactly
// the diagnosis it was added to support.
const offlineSince = new Map(); // address -> { firstLoggedAt, lastLoggedAt }

function logOfflineTrustedPeers() {
  const offline = queries.offlineTrustedPeers();
  const stillOffline = new Set(offline.map((p) => p.address));
  const now = Date.now();

  for (const address of [...offlineSince.keys()]) {
    if (!stillOffline.has(address)) {
      offlineSince.delete(address);
      logger.info('trusted peer is back online', { address });
    }
  }

  for (const p of offline) {
    const seen = offlineSince.get(p.address);
    const detail = {
      address: p.address,
      label: p.trustedLabel || undefined,
      offlineFor: p.offlineSinceMs != null ? `${Math.round(p.offlineSinceMs / 60000)}m` : 'never seen connecting',
    };
    if (!seen) {
      offlineSince.set(p.address, { firstLoggedAt: now, lastLoggedAt: now });
      logger.warn('trusted peer went offline', detail);
    } else if (now - seen.lastLoggedAt >= OFFLINE_REMINDER_INTERVAL_MS) {
      seen.lastLoggedAt = now;
      logger.warn('trusted peer still offline', detail);
    }
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
  // Traffic rides on the same poll: getnettotals is one small call, and
  // the per-connection counters are already in the reply above.
  try {
    traffic.record({ totals: await rpc.call('getnettotals'), peers });
  } catch (err) {
    logger.debug('traffic reading failed', { error: err.message });
  }
  try {
    upsertSessions(peers);
  } catch (err) {
    // Same reasoning as relay-profiler.js: this runs inside an async function
    // driven by a timer, so an unhandled throw here used to become an
    // unhandled rejection and terminate the process. One failed snapshot is
    // recoverable; a dead profiler that stops recording sessions is not
    // obvious from the outside.
    logger.error('failed to record peer snapshot', { error: err.stack || err.message });
    return;
  }
  logger.debug('poll complete', { peers: peers.length });
}

/**
 * Self-scheduling loop rather than setInterval: getpeerinfo has a 10s RPC
 * timeout and the SQLite write can wait out a 10s busy_timeout behind the
 * daily prune, which together exceed the 15s poll interval. setInterval
 * would keep firing regardless and let runs pile up on top of each other;
 * this simply starts the next wait once the previous pass has finished.
 */
function startPolling(intervalMs) {
  let timer = null;
  const tick = async () => {
    await pollOnce();
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };
  tick();
  return () => clearTimeout(timer);
}

// Keeps the "feeler" side of the historical tables (and the SQLite file
// itself) from growing forever, without ever touching real peer-ranking
// data - see config.js feelerPeerRetentionDays/stratumHistoryRetentionDays
// for what's actually pruned and why. Runs once shortly after startup (so a
// fresh install doesn't wait a full day for its first prune) and then
// daily; each run is independent and cheap to skip if it fails, so a single
// bad run never blocks peer polling or leaves the DB stuck.
function runMaintenance() {
  try {
    const result = queries.pruneOldData();
    logger.info('data retention prune complete', {
      feelerPeerRetentionDays: config.feelerPeerRetentionDays,
      stratumHistoryRetentionDays: config.stratumHistoryRetentionDays,
      ...result,
    });
  } catch (err) {
    logger.warn('data retention prune failed', { error: err.message });
  }
  try {
    if (db.maybeVacuum()) logger.info('vacuumed sqlite database to reclaim pruned space');
  } catch (err) {
    logger.warn('vacuum failed', { error: err.message });
  }
}

function flushTraffic() {
  try {
    traffic.flush();
  } catch (err) {
    logger.warn('could not write traffic', { error: err.message });
  }
}

async function main() {
  let stopPolling = null;
  processGuard.install(logger, {
    onShutdown: () => {
      if (stopPolling) stopPolling();
      flushTraffic();
    },
  });
  setInterval(flushTraffic, config.trafficFlushMs).unref?.();

  db.open();
  logger.info('starting', { intervalMs: config.peerPollIntervalMs });
  health.start(db, 'peer-profiler', logger);

  // Pull in any peer Core already has addnode'd that we don't know about
  // yet (added outside this app) before pushing our own list back out -
  // see adoptExternalManualPeers for why this direction is needed too.
  try {
    const adoptResult = await adoptExternalManualPeers();
    if (adoptResult.adopted > 0) logger.info('startup: adopted externally-managed manual peers', { adopted: adoptResult.adopted });

    const syncResult = await syncTrustedToAddnode(adoptResult.addedNodes);
    logger.info('startup trusted/addnode sync', syncResult);
  } catch (err) {
    // Bitcoin Core may simply not be up yet when this container starts. That
    // is not a reason to refuse to start profiling - the periodic sync below
    // will pick it up.
    logger.warn('startup peer sync failed, continuing', { error: err.message });
  }

  stopPolling = startPolling(config.peerPollIntervalMs);

  // Safety net: re-run both directions periodically - re-assert trusted
  // peers as addnodes in case Core forgot them across a restart of the
  // bitcoin app itself, and adopt anything newly addnode'd outside this app
  // (e.g. a direct `bitcoin-cli addnode` call) since the last pass.
  setInterval(() => {
    adoptExternalManualPeers()
      .then((adoptResult) => syncTrustedToAddnode(adoptResult.addedNodes))
      .catch((err) => logger.warn('periodic peer sync failed', { error: err.message }));
    try {
      logOfflineTrustedPeers();
    } catch (err) {
      logger.warn('offline-trusted-peer check failed', { error: err.message });
    }
    // Independent of the sync/adopt/offline-log work above - a rotation
    // failure must never block or mask that bookkeeping, and vice versa.
    // No-ops immediately unless the user has switched rotation on.
    peerRotation.tick().catch((err) => logger.warn('peer rotation tick failed', { error: err.message }));
  }, PEER_SYNC_INTERVAL_MS);

  runMaintenance();
  setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('fatal', { error: err.stack || err.message });
    process.exit(1);
  });
}

module.exports = { upsertSessions, logOfflineTrustedPeers, pollOnce, runMaintenance, main };
