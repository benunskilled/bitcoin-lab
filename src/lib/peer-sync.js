'use strict';

const db = require('./db');
const rpc = require('./rpc');
const config = require('./config');
const queries = require('./queries');
const logger = require('./logger').make('peer-sync');

/**
 * Makes sure every persisted trusted/manual peer is actually registered
 * with Bitcoin Core as an addnode. Bitcoin Core's own outbound/inbound
 * connections are never touched here - this only ever adds, it never
 * removes or replaces the normal automatic peers Core discovers on its
 * own (design principle: outbound discovery keeps working).
 *
 * Bitcoin Core only actively holds open `config.maxManualPeers` (default 8)
 * simultaneous manual connections, so we never addnode more trusted peers
 * than that per sync pass - oldest-trusted-first. Anyone beyond the cap
 * simply stays queued in our own trusted_peer table and gets picked up
 * automatically once a slot frees up (another manual peer removed/dropped).
 */
async function syncTrustedToAddnode(knownAddedNodes) {
  const trusted = db.instance.prepare(`SELECT address FROM trusted_peer ORDER BY created_at ASC`).all();
  let addedNodes = [];
  try {
    // Callers that already hold this list can pass it in. adoptExternalManualPeers
    // runs immediately before this on every sync tick and fetches exactly the
    // same, unchanged data - so fetching it again here was one wasted RPC
    // round trip per tick, forever.
    addedNodes = knownAddedNodes || await rpc.getAddedNodeInfo();
  } catch (err) {
    logger.warn('getaddednodeinfo failed, skipping addnode sync this round', { error: err.message });
    return { trusted: trusted.length, existing: 0, added: 0, queued: 0 };
  }
  const existingAddrs = new Set(addedNodes.map((n) => n.addednode));

  // Peers Core already has addnode'd count against the cap too, so we don't
  // starve them out just because they sort later than a newly-queued one.
  let slotsUsed = trusted.filter(({ address }) => existingAddrs.has(address)).length;

  let added = 0;
  let queued = 0;
  for (const { address } of trusted) {
    if (existingAddrs.has(address)) continue;
    if (slotsUsed >= config.maxManualPeers) {
      queued += 1;
      continue;
    }
    try {
      await rpc.addNode(address, 'add');
      added += 1;
      slotsUsed += 1;
      logger.info('restored trusted peer as addnode', { address });
    } catch (err) {
      logger.warn('failed to restore trusted peer as addnode', { address, error: err.message });
    }
  }

  if (queued > 0) {
    logger.info('manual peer cap reached, some trusted peers stayed queued', {
      cap: config.maxManualPeers,
      queued,
    });
  }

  logger.info('trusted/addnode sync complete', {
    trusted: trusted.length,
    existingAddnodes: existingAddrs.size,
    added,
    queued,
  });
  return { trusted: trusted.length, existing: existingAddrs.size, added, queued };
}

/**
 * Pulls Core's own addnode list (getaddednodeinfo - the RPC read-back of
 * whatever `addnode add` has been called for, whether that call came from
 * us, a direct `bitcoin-cli addnode` by the user, or a `-addnode=` line in
 * bitcoin.conf) and adopts any address we don't already know about into our
 * own trusted_peer table.
 *
 * We never read or write bitcoin.conf itself - nothing here does. All
 * "manual" management, ours and Core's own, happens purely through the
 * `addnode`/`removenode` RPCs (see addTrustedPeer/removeTrustedPeer below
 * and rpc.js). That RPC-level addnode list lives in Core's memory only -
 * Core does NOT persist it back into bitcoin.conf, so it's wiped on every
 * bitcoind restart unless the entry is also a bitcoin.conf `-addnode=`
 * line. trusted_peer + syncTrustedToAddnode() above exists specifically to
 * survive that: on our own startup (and every 10 min) we re-issue `addnode
 * add` for everything we remember. This adoption step is the missing other
 * half - so a peer that became "manual" some other way still ends up
 * durably tracked by us too, instead of being invisible to our own
 * persistence and showing up as an orphan (Core says "manual", we don't
 * know it, so it fell through the cracks into the Outbound panel instead of
 * Manual - the bug that prompted this).
 */
async function adoptExternalManualPeers() {
  let addedNodes = [];
  try {
    addedNodes = await rpc.getAddedNodeInfo();
  } catch (err) {
    logger.warn('getaddednodeinfo failed, skipping external-manual adoption this round', { error: err.message });
    // No list to hand on either - the caller falls back to fetching its own,
    // which will normally fail the same way and skip its round too.
    return { adopted: 0, addedNodes: null };
  }

  const known = new Set(
    db.instance.prepare(`SELECT address FROM trusted_peer`).all().map((r) => r.address),
  );
  const insert = db.instance.prepare(
    `INSERT OR IGNORE INTO trusted_peer (address, label, created_at) VALUES (?, NULL, ?)`,
  );

  const now = Date.now();
  let adopted = 0;
  for (const { addednode } of addedNodes) {
    if (!addednode || known.has(addednode)) continue;
    insert.run(addednode, now);
    // Same reason as in addTrustedPeer: a manual peer with no `peer` row is
    // invisible to peerRanking(), so no rotation pass can ever see it while it
    // still occupies one of the eight slots. An addnode entry Core has never
    // managed to connect is precisely the case that produces one.
    db.getOrCreatePeer(addednode);
    adopted += 1;
    logger.info('adopted externally-managed manual peer into trusted_peer', { address: addednode });
  }
  // Handed back so syncTrustedToAddnode, which always runs straight after
  // this, doesn't have to ask Core for the same list a second time.
  return { adopted, addedNodes };
}

// If Core already has a live connection to this address under some other
// connection_type (outbound-full-relay, block-relay-only, inbound, feeler),
// `addnode add` alone won't touch it: Core's ThreadOpenAddedConnections
// skips opening a duplicate/replacement connection to an address that's
// already connected, so the session just keeps its old type forever and no
// automatic-outbound slot is ever freed - even though our own dashboard
// happily labels it "manual" the moment it's in trusted_peer. Disconnect
// the existing session first (only when it isn't already 'manual' - no
// point churning a peer that's already exactly what we want) so Core's own
// reconnect logic picks it back up moments later as a genuine manual
// connection, with the slot it used to occupy now free for a new
// automatically-discovered peer.
//
// Lives here (not in manual-peer.js) so every caller of addTrustedPeer gets
// this guarantee for free - not just the interactive "Add as Manual" flow,
// but also the automated peer-rotation loop, which calls addTrustedPeer
// directly and would otherwise silently reintroduce the exact
// stuck-connection-type bug this was written to fix.
async function disconnectIfLiveNonManual(address) {
  let peers = [];
  try {
    peers = await rpc.getPeerInfo();
  } catch (err) {
    // Can't tell either way - proceed as before rather than block the add on it.
    logger.debug('getpeerinfo failed while checking for a live non-manual session', { address, error: err.message });
    return;
  }
  const existing = peers.find((p) => p.addr === address);
  if (!existing || existing.connection_type === 'manual') return;
  try {
    await rpc.disconnectNode(address);
    logger.info('disconnected existing non-manual session to free its slot before adding as manual', {
      address,
      previousType: existing.connection_type,
    });
  } catch (err) {
    // Not fatal - addnode below still queues it, Core just won't get a free
    // slot as quickly as it could have.
    logger.warn('failed to disconnect existing session before manual-add', { address, error: err.message });
  }
}

/**
 * Adds an address to the manual set. Nothing changes until the step that can
 * actually fail has succeeded.
 *
 * The order is the whole point, and it has been wrong twice. It used to write
 * the row, disconnect the peer's existing session, then addnode - so an add
 * that Core then refused had already cost the user a live connection. That was
 * fixed by moving the disconnect last. But the eviction that makes room at
 * capacity was still done up front, so a refused addnode left the manual set
 * one peer smaller than it started, with no mention of it anywhere.
 *
 * So `addnode add` now goes FIRST, before any of our own state moves. Core's
 * addnode list holds more entries than the eight connections it will maintain
 * (MAX_ADDNODE_CONNECTIONS caps concurrent connections, not list length), so a
 * momentary ninth entry is harmless and is resolved by the eviction two lines
 * later. If the call is refused, we return having touched nothing at all:
 * no row, no eviction, no dropped connection.
 *
 * Only then, in order: record the peer, take the slot back from the weakest
 * current manual peer if one was needed, and finally disconnect whatever stale
 * non-manual session the new peer still has so Core redials it as a manual one.
 *
 * `evictToFit` is off by default because the rotation loop does its own,
 * stricter capacity arithmetic (a promotion must beat the peer it replaces);
 * it must not silently get a second, laxer eviction path underneath it.
 */
async function addTrustedPeer(address, label, options = {}) {
  const { evictToFit = false } = options;
  const alreadyTrusted = Boolean(
    db.instance.prepare(`SELECT 1 FROM trusted_peer WHERE address = ?`).get(address),
  );

  // Decide capacity before anything happens, but do not act on it yet.
  let toEvict = null;
  if (!alreadyTrusted) {
    const count = countTrusted();
    if (count >= config.maxManualPeers) {
      if (!evictToFit) {
        return { ok: false, count, max: config.maxManualPeers, error: `all ${config.maxManualPeers} manual slots are taken` };
      }
      toEvict = queries.weakestTrustedPeer(queries.peerRanking().filter((p) => p.trusted));
      if (!toEvict || toEvict.address === address) {
        return {
          ok: false,
          count,
          max: config.maxManualPeers,
          error: `all ${config.maxManualPeers} manual slots are taken and none could be freed`,
        };
      }
    }
  }

  // The one step that can be refused, done before anything is at stake.
  try {
    await rpc.addNode(address, 'add');
  } catch (err) {
    // "Node already added" means the end state we wanted is already true -
    // Core's addnode list survives independently of ours (a bitcoin.conf
    // -addnode=, a bitcoin-cli call, or our own previous sync), so this is a
    // success, not a failure. Anything else is a genuine refusal, and at this
    // point nothing of ours has moved.
    if (!/already added/i.test(err.message || '')) {
      logger.warn('addnode refused, nothing changed', { address, error: err.message });
      return { ok: false, count: countTrusted(), max: config.maxManualPeers, error: err.message };
    }
    logger.debug('addnode call while trusting peer', { address, error: err.message });
  }

  db.instance
    .prepare(`INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET label = excluded.label`)
    .run(address, label || null, Date.now());

  // A manual peer must exist in `peer` too, even if Core has never reported a
  // session for it. peerRanking() is driven FROM peer, so without this row the
  // peer is invisible to every rotation pass - it can never be retired, never
  // be considered the weakest, and never be shown - while still consuming one
  // of the eight slots forever. That is exactly what happens when the TCP
  // probe answers but Core never establishes a connection (a non-Bitcoin
  // service on 8333, a peer that rejects us, Core's own slots full).
  db.getOrCreatePeer(address);

  // Only now is the parked entry safe to drop. Doing it before the addnode
  // meant a refused call destroyed the record of a peer we had spent months
  // ranking - the precise loss parking exists to prevent.
  db.instance.prepare(`DELETE FROM parked_peer WHERE address = ?`).run(address);

  let evicted = null;
  if (toEvict) {
    await removeTrustedPeer(toEvict.address);
    parkPeer(toEvict);
    evicted = toEvict;
    logger.info('freed a manual slot to stay within the cap', {
      removed: evicted.address,
      removedFirstPct: evicted.firstPct,
      forAddress: address,
      max: config.maxManualPeers,
    });
  }

  await disconnectIfLiveNonManual(address);

  return {
    ok: true,
    count: countTrusted(),
    max: config.maxManualPeers,
    evicted: evicted ? { address: evicted.address, firstPct: evicted.firstPct } : null,
  };
}

function countTrusted() {
  return db.instance.prepare(`SELECT COUNT(*) AS n FROM trusted_peer`).get().n;
}

/**
 * Remembers a peer that just lost its manual slot, so the rotation loop can
 * keep re-testing it and hand the slot back if it returns (see peer-rotation's
 * reviveParkedPeers). Losing a slot is meant to be reversible - that is the
 * entire reason this app can afford to reclaim an offline peer's slot in hours
 * rather than never.
 *
 * Never parks a peer that has no record worth keeping: an address that was
 * never once connected when a block landed is not a peer this app has an
 * opinion about, and re-probing it forever would be busywork.
 */
function parkPeer(peer) {
  if (!peer || !peer.address) return false;
  if (!peer.eligible) return false;
  db.instance
    .prepare(
      `INSERT INTO parked_peer (address, label, first_pct, eligible, parked_at, last_probe_at, probe_failures)
       VALUES (@address, @label, @firstPct, @eligible, @parkedAt, NULL, 0)
       ON CONFLICT(address) DO UPDATE SET
         first_pct = excluded.first_pct,
         eligible = excluded.eligible,
         parked_at = excluded.parked_at,
         last_probe_at = NULL,
         probe_failures = 0`,
    )
    .run({
      address: peer.address,
      label: peer.trustedLabel || peer.label || null,
      firstPct: peer.firstPct == null ? null : peer.firstPct,
      eligible: peer.eligible == null ? null : peer.eligible,
      parkedAt: Date.now(),
    });
  return true;
}

async function removeTrustedPeer(address) {
  db.instance.prepare(`DELETE FROM trusted_peer WHERE address = ?`).run(address);
  try {
    // Also tell Core to drop it as a manual/addnode entry - otherwise Core
    // keeps trying to maintain the connection even though we've forgotten
    // it, silently holding a manual slot the UI now thinks is free.
    await rpc.addNode(address, 'remove');
  } catch (err) {
    // "Node has not been added" etc. - not worth failing the remove over.
    logger.debug('addnode remove while untrusting peer', { address, error: err.message });
  }
  try {
    // `addnode remove` only stops FUTURE reconnect attempts - Core does not
    // drop an already-open manual connection just because it left the
    // addnode list, so getpeerinfo would keep reporting connection_type
    // 'manual' for it (and our own "effective trust" logic in queries.js
    // would keep treating it as trusted) until it disconnects on its own.
    // Force that now so Remove has an immediate, visible effect instead of
    // silently doing nothing until the peer happens to drop by itself.
    await rpc.disconnectNode(address);
  } catch (err) {
    // Not currently connected, or already gone - not an error worth failing over.
    logger.debug('disconnect while untrusting peer', { address, error: err.message });
  }
}

module.exports = {
  syncTrustedToAddnode,
  adoptExternalManualPeers,
  addTrustedPeer,
  removeTrustedPeer,
  disconnectIfLiveNonManual,
  parkPeer,
};
