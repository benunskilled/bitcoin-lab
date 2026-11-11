'use strict';

const db = require('./db');
const rpc = require('./rpc');
const config = require('./config');
const queries = require('./queries');
const { hostFromAddress, addressKey } = require('./address');
const { evictableTrusted } = require('./peer-rotation/rules');
const spread = require('./peer-rotation/spread');
const logger = require('./logger').make('peer-sync');

const keyOf = (address) => addressKey(address, config.bitcoin.network);

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
  // Compared by key: Core echoes an addnode in the spelling it was given, and
  // the same node written another way is still the same entry to Core.
  const existingAddrs = new Set(addedNodes.map((n) => keyOf(n.addednode)));

  // Peers Core already has addnode'd count against the cap too, so we don't
  // starve them out just because they sort later than a newly-queued one.
  let slotsUsed = trusted.filter(({ address }) => existingAddrs.has(keyOf(address))).length;

  let added = 0;
  let queued = 0;
  for (const { address } of trusted) {
    if (existingAddrs.has(keyOf(address))) continue;
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

  // A read-only copy never issues an addnode of its own, so Core's list is the
  // whole truth for it and its table is only a mirror of that list. Left to
  // the adoption below alone it could only grow: a peer removed in the real
  // app stayed here as an offline manual peer, and once eight stale rows had
  // piled up the limit kept every new one out.
  if (config.readOnly) {
    const inCore = new Set(addedNodes.map((n) => keyOf(n.addednode)));
    const drop = db.instance.prepare(`DELETE FROM trusted_peer WHERE address = ?`);
    for (const { address } of db.instance.prepare(`SELECT address FROM trusted_peer`).all()) {
      if (inCore.has(keyOf(address))) continue;
      drop.run(address);
      logger.info('read-only: dropped a manual peer Core no longer has', { address });
    }
  }

  const known = new Set(
    db.instance.prepare(`SELECT address FROM trusted_peer`).all().map((r) => keyOf(r.address)),
  );
  // Protected on the way in. An addnode this app did not issue is somebody's
  // choice - a bitcoin.conf line, a peer set in Umbrel's settings - and an
  // unprotected row is one the rotation may later `addnode remove`, undoing
  // that choice behind the person's back.
  const insert = db.instance.prepare(
    `INSERT OR IGNORE INTO trusted_peer (address, label, kept, created_at) VALUES (?, NULL, 1, ?)`,
  );

  const now = Date.now();
  let adopted = 0;
  const skipped = [];
  const pending = pendingRemovals();
  let pendingChanged = false;
  for (const { addednode } of addedNodes) {
    if (!addednode || known.has(keyOf(addednode))) continue;
    // One we removed ourselves while Core did not listen: remove it again,
    // never adopt it.
    if (pending[keyOf(addednode)]) {
      try {
        await rpc.addNode(addednode, 'remove');
        delete pending[keyOf(addednode)];
        pendingChanged = true;
        logger.info('retried addnode remove for a peer this app had dropped', { address: addednode });
      } catch (err) {
        if (notAdded(err)) {
          delete pending[keyOf(addednode)];
          pendingChanged = true;
        } else {
          logger.warn('addnode remove retry failed', { address: addednode, error: err.message });
        }
      }
      continue;
    }
    // Taken out a moment ago, by this process: Core's list was read before
    // that, or the remove is still on its way. Not somebody else's addnode.
    if (removedJustNow(keyOf(addednode))) continue;
    // The slot fill's candidate, between its addnode and its row: the slot
    // fill's to settle, not somebody else's addnode to adopt and padlock.
    if (slotFillCandidate() === keyOf(addednode)) continue;
    // Never past the limit. Core keeps its own list either way; what does not
    // fit is only left out of ours, and said so in the log.
    if (known.size >= config.maxManualPeers) {
      skipped.push(addednode);
      continue;
    }
    insert.run(addednode, now);
    known.add(keyOf(addednode));
    // Same reason as in addTrustedPeer: a manual peer with no `peer` row is
    // invisible to peerRanking(), so no rotation pass can ever see it while it
    // still occupies one of the eight slots. An addnode entry Core has never
    // managed to connect is precisely the case that produces one.
    db.getOrCreatePeer(addednode);
    adopted += 1;
    logger.info('adopted externally-managed manual peer into trusted_peer', { address: addednode });
  }
  if (pendingChanged) savePendingRemovals(pending);
  if (skipped.length > 0) {
    logger.warn('manual peer limit reached, addnode entries not adopted', {
      max: config.maxManualPeers,
      skipped,
    });
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
// The networks whose peers all arrive under one shared proxy address. Matching
// by host is what makes this function work at all (see below), and on these it
// would match every peer on that network at once - disconnecting the lot.
const SHARED_PROXY_NETWORKS = new Set(['onion', 'i2p', 'cjdns']);

// Every non-manual connection Core currently holds to the same host, with the
// proxy networks left alone.
//
// By host, not by address, and that is the whole fix. An inbound peer is added
// under the LISTENING address the port probe found (ip:8333), while its live
// session is reported under the ephemeral port it dialled from
// (ip:51234) - the two strings never matched, so the disconnect below silently
// did nothing and the node ended up connected twice: once inbound, once
// manual. Core credits a delivered block to whichever connection carried it,
// so the manual slot then measured as worthless while its twin did the work.
function liveNonManualSessionsForHost(peers, address) {
  const host = hostFromAddress(address);
  return peers.filter(
    (p) => p.connection_type !== 'manual'
      && !SHARED_PROXY_NETWORKS.has(String(p.network || '').toLowerCase())
      && hostFromAddress(p.addr) === host,
  );
}

async function disconnectSession(peer) {
  try {
    // By Core's own peer id where it has one: the address of an inbound
    // session carries an ephemeral port, and passing that back is one more
    // place for the two spellings of the same peer to disagree.
    await rpc.disconnectNode(typeof peer.id === 'number' ? peer.id : peer.addr);
    logger.info('disconnected a non-manual session to the same host', {
      address: peer.addr,
      previousType: peer.connection_type,
    });
    return true;
  } catch (err) {
    logger.warn('failed to disconnect a session', { address: peer.addr, error: err.message });
    return false;
  }
}

async function disconnectIfLiveNonManual(address) {
  let peers = [];
  try {
    peers = await rpc.getPeerInfo();
  } catch (err) {
    // Can't tell either way - proceed as before rather than block the add on it.
    logger.debug('getpeerinfo failed while checking for a live non-manual session', { address, error: err.message });
    return;
  }
  for (const peer of liveNonManualSessionsForHost(peers, address)) {
    await disconnectSession(peer);
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
 * So `addnode add` now comes before any of our own state moves - with one
 * exception, which goes before it: a live non-manual session to the same host
 * is disconnected first, because Core will not dial a host it is already
 * connected to (see the comment at that call for what that costs). Core's
 * addnode list holds more entries than the eight connections it will maintain
 * (MAX_ADDNODE_CONNECTIONS caps concurrent connections, not list length), so a
 * momentary ninth entry is harmless and is resolved by the eviction below. If
 * the call is refused, we return with no row written and nothing evicted.
 *
 * Only then, in order: count the slots again and record the peer in one
 * IMMEDIATE transaction - another add may have taken the last slot during the
 * RPCs, and then nothing is written and the addnode is taken back - and
 * finally take the slot back from the peer being replaced, if there is one.
 *
 * `evictToFit` is off by default because the slot fill does its own,
 * stricter capacity arithmetic (only a surplus peer leaves, only for a
 * missing region); it must not silently get a second, laxer eviction path
 * underneath it.
 */
async function addTrustedPeer(address, label, options = {}) {
  // `kept` is the star: set for anything a person typed in, unset for anything
  // the slot fill added. Typing an address in is already the decision - the
  // slot fill's own additions are not, and must stay swappable or it would
  // freeze itself out of every slot it ever filled.
  // `neverDisconnect` is the slot fill's: it only ever adds addresses Core is
  // not connected to, and if one turns out to be connected after all it is
  // left alone rather than dropped and redialled - Core's own connections are
  // not the slot fill's to touch. Nor is an addnode entry somebody else made:
  // "already added" is a refusal there, not a success, or a failed trial would
  // later remove that entry.
  const { evictToFit = false, kept = false, neverDisconnect = false } = options;
  // The same node under another spelling is already in the set: adding it
  // again would take a second slot for one connection.
  const sameNode = db.instance
    .prepare(`SELECT address FROM trusted_peer`)
    .all()
    .find((r) => keyOf(r.address) === keyOf(address));
  if (sameNode && sameNode.address !== address) {
    return {
      ok: false,
      count: countTrusted(),
      max: config.maxManualPeers,
      error: `${address} is already a manual peer, written as ${sameNode.address}`,
    };
  }
  const alreadyTrusted = Boolean(sameNode);

  // Decide capacity before anything happens, but do not act on it yet.
  let toEvict = null;
  if (!alreadyTrusted) {
    const count = countTrusted();
    if (count >= config.maxManualPeers) {
      if (!evictToFit) {
        return { ok: false, count, max: config.maxManualPeers, error: `all ${config.maxManualPeers} manual slots are taken` };
      }
      // Only a peer the rotation itself could displace: not one with the
      // padlock, not one still inside its new-slot grace. Typing an address in
      // used to take the weakest of all eight, a protected one included - the
      // one thing the padlock promises cannot happen. Of those, the one the
      // spread misses least (spread.leastMissed).
      const ranking = queries.peerRanking();
      const trusted = ranking.filter((p) => p.trusted);
      toEvict = spread.leastMissed(
        { address },
        evictableTrusted(trusted).filter((p) => p.address !== address),
        trusted,
        ranking,
        queries.weakestTrustedPeer,
      );
      if (!toEvict) {
        return {
          ok: false,
          count,
          max: config.maxManualPeers,
          error: `all ${config.maxManualPeers} manual slots are taken by protected or newly added peers - release one with its padlock first`,
        };
      }
    }
  }

  // Before the addnode, not after it, and this is a deliberate trade. Core
  // will not open an outbound connection to a host it is already connected to,
  // so with the inbound session still up the addnode entry is accepted and
  // then simply never dials - the slot is spent on a connection that does not
  // exist. Clearing the way first is the only order that actually produces a
  // manual connection to a peer that dialled in.
  //
  // What it costs: if the addnode below is then refused, a live connection was
  // dropped for nothing. That is a real regression against the old order, and
  // it is accepted because the old order did not work for this case at all.
  // The exposure is small - this runs only when there IS such a session, and
  // the handshake that found the listening address ran moments earlier.
  if (neverDisconnect) {
    let peers = [];
    try {
      peers = await rpc.getPeerInfo();
    } catch (err) {
      return { ok: false, count: countTrusted(), max: config.maxManualPeers, error: `could not ask Core: ${err.message}` };
    }
    if (liveNonManualSessionsForHost(peers, address).length) {
      return { ok: false, count: countTrusted(), max: config.maxManualPeers, error: `${address} is already connected to Core` };
    }
  } else {
    await disconnectIfLiveNonManual(address);
  }

  // The one step that can be refused.
  let alreadyInCore = false;
  try {
    await rpc.addNode(address, 'add');
  } catch (err) {
    // "Node already added" means the end state we wanted is already true -
    // Core's addnode list survives independently of ours (a bitcoin.conf
    // -addnode=, a bitcoin-cli call, or our own previous sync), so this is a
    // success, not a failure. Anything else is a genuine refusal, and at this
    // point nothing of ours has moved.
    if (!/already added/i.test(err.message || '') || neverDisconnect) {
      logger.warn('addnode refused, nothing changed', { address, error: err.message });
      return { ok: false, count: countTrusted(), max: config.maxManualPeers, error: err.message };
    }
    logger.debug('addnode call while trusting peer', { address, error: err.message });
    alreadyInCore = true;
  }

  // The count again, in the same write transaction as the row. The one above
  // was read before two RPCs; another add - from the dashboard, from the
  // rotation in the other process - can have taken the last slot in the
  // meantime, and both used to write their row. IMMEDIATE takes the write
  // lock first, so no other writer can slip between this count and the
  // insert.
  //
  // The peer being displaced (a person adding to a full set) is claimed in
  // the same transaction: its row goes here, not after the RPCs below. It was
  // chosen before two RPCs too, and in that time another add can have chosen
  // and freed the same slot (both then wrote their row: one manual peer too
  // many), or the padlock can have gone on it. So it only frees a slot if it
  // is still there and still unlocked now; otherwise this add has to fit on
  // its own.
  let claimed = false;
  const written = db.instance.transaction(() => {
    const exists = db.instance.prepare(`SELECT 1 FROM trusted_peer WHERE address = ?`).get(address);
    if (!exists) {
      const holder = toEvict && db.instance.prepare(`SELECT kept FROM trusted_peer WHERE address = ?`).get(toEvict.address);
      const freeable = Boolean(holder && !holder.kept);
      if (countTrusted() - (freeable ? 1 : 0) >= config.maxManualPeers) return false;
      if (freeable) {
        db.instance.prepare(`DELETE FROM trusted_peer WHERE address = ?`).run(toEvict.address);
        claimed = true;
      }
    }
    db.instance
      .prepare(
        `INSERT INTO trusted_peer (address, label, kept, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET label = excluded.label,
         -- Re-adding by hand can set the star, but re-adding must never CLEAR
         -- one: the rotation calls this too (adopting a peer Core already knows,
         -- reviving a parked one), and those calls pass kept=false. Taking the
         -- star off is the star's own control, not a side effect of something
         -- else touching the row.
         kept = CASE WHEN excluded.kept = 1 THEN 1 ELSE trusted_peer.kept END`,
      )
      .run(address, label || null, kept ? 1 : 0, Date.now());
    return true;
  }).immediate();

  if (!written) {
    // Lost the race for the last slot. Core was already told to add it, so it
    // is told to drop it again - unless the entry was Core's before we came.
    if (!alreadyInCore) {
      try {
        await rpc.addNode(address, 'remove');
      } catch (err) {
        logger.debug('addnode remove after losing the last slot', { address, error: err.message });
      }
    }
    logger.warn('manual slot taken while adding, nothing written', { address, max: config.maxManualPeers });
    return {
      ok: false,
      count: countTrusted(),
      max: config.maxManualPeers,
      error: `all ${config.maxManualPeers} manual slots are taken`,
    };
  }

  // A manual peer must exist in `peer` too, even if Core has never reported a
  // session for it. peerRanking() is driven FROM peer, so without this row the
  // peer is invisible to every rotation pass - it can never be retired, never
  // be considered the weakest, and never be shown - while still consuming one
  // of the eight slots forever. That is exactly what happens when the TCP
  // probe answers but Core never establishes a connection (a non-Bitcoin
  // service on 8333, a peer that rejects us, Core's own slots full).
  db.getOrCreatePeer(address);

  let evicted = null;
  if (claimed) {
    // The row is already gone (above); this tells Core and drops the session.
    await removeTrustedPeer(toEvict.address);
    evicted = toEvict;
    logger.info('freed a manual slot to stay within the cap', {
      removed: evicted.address,
      removedFirstPct: evicted.firstPct,
      forAddress: address,
      max: config.maxManualPeers,
    });
  }

  return {
    ok: true,
    count: countTrusted(),
    max: config.maxManualPeers,
    evicted: evicted ? { address: evicted.address, firstPct: evicted.firstPct, live: Boolean(evicted.live) } : null,
  };
}

function countTrusted() {
  return db.instance.prepare(`SELECT COUNT(*) AS n FROM trusted_peer`).get().n;
}

// Addresses this app took out of the manual set while Core refused the
// matching `addnode remove` (Core restarting, an RPC timeout). Core still has
// the entry, and the next sync would read it as somebody else's addnode and
// adopt it back - protected, since 1.25.8, so for good. Kept in `meta` for a
// day; the sync retries the remove instead of adopting.
const PENDING_REMOVAL_KEY = 'pending_addnode_removal';
const PENDING_REMOVAL_MS = 24 * 60 * 60 * 1000;

function pendingRemovals() {
  try {
    const row = db.instance.prepare(`SELECT value FROM meta WHERE key = ?`).get(PENDING_REMOVAL_KEY);
    const all = row ? JSON.parse(row.value) : {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, at]) => now - at < PENDING_REMOVAL_MS));
  } catch {
    return {};
  }
}

function savePendingRemovals(map) {
  db.instance
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(PENDING_REMOVAL_KEY, JSON.stringify(map));
}

function slotFillCandidate() {
  try {
    const row = db.instance.prepare(`SELECT value FROM meta WHERE key = 'slot_fill_trial'`).get();
    return row ? keyOf(JSON.parse(row.value).address) : null;
  } catch {
    return null;
  }
}

// Removed in this process within the last few minutes (see removeTrustedPeer).
const RECENTLY_REMOVED_MS = 5 * 60 * 1000;
const recentlyRemoved = new Map();
function removedJustNow(key) {
  const at = recentlyRemoved.get(key);
  if (at == null) return false;
  if (Date.now() - at < RECENTLY_REMOVED_MS) return true;
  recentlyRemoved.delete(key);
  return false;
}

const notAdded = (err) => /not been added|not added/i.test((err && err.message) || '');

/**
 * Take an address out of the manual set, and out of Core's addnode list.
 *
 * `disconnect` (on by default) also drops the connection. It has to for any
 * swap: a manual connection left up keeps its addnode grant, and with eight
 * of them Core never dials the newcomer (test/integration/regtest.js).
 */
async function removeTrustedPeer(address, { disconnect = true } = {}) {
  // Noted before the row goes: an adoption pass already holding Core's list
  // from a moment ago would otherwise see the entry there and none here, and
  // take it back in as somebody else's addnode - padlocked.
  recentlyRemoved.set(keyOf(address), Date.now());
  db.instance.prepare(`DELETE FROM trusted_peer WHERE address = ?`).run(address);
  try {
    // Also tell Core to drop it as a manual/addnode entry - otherwise Core
    // keeps trying to maintain the connection even though we've forgotten
    // it, silently holding a manual slot the UI now thinks is free.
    await rpc.addNode(address, 'remove');
  } catch (err) {
    // "Node has not been added" is the end state we wanted. Anything else
    // means Core may still hold the entry: remember it, so the sync removes
    // it again instead of adopting it back.
    if (!notAdded(err)) {
      const pending = pendingRemovals();
      pending[keyOf(address)] = Date.now();
      savePendingRemovals(pending);
      logger.warn('addnode remove failed, will retry on the next sync', { address, error: err.message });
    } else {
      logger.debug('addnode remove while untrusting peer', { address, error: err.message });
    }
  }
  if (!disconnect) return;
  // `addnode remove` only stops FUTURE reconnect attempts - Core does not
  // drop an already-open manual connection just because it left the addnode
  // list, so getpeerinfo would keep reporting connection_type 'manual' for it
  // (and our own "effective trust" logic in ranking-row.js would keep
  // treating it as trusted) until it disconnects on its own. So it is dropped
  // here - the manual session only, by Core's peer id. disconnectnode by
  // address drops whatever connection carries that name, and Core may have
  // dialled the same address on its own meanwhile.
  let peers = [];
  try {
    peers = await rpc.getPeerInfo();
  } catch (err) {
    logger.warn('could not ask Core which session to drop; the manual one stays until it ends', { address, error: err.message });
    return;
  }
  for (const peer of peers.filter((p) => p.connection_type === 'manual' && keyOf(p.addr) === keyOf(address))) {
    try {
      await rpc.disconnectNode(peer.id);
    } catch (err) {
      // Already gone - not an error worth failing over.
      logger.debug('disconnect while untrusting peer', { address, error: err.message });
    }
  }
}

/**
 * Turns the star on or off for a manual peer. Nothing else changes: the peer
 * keeps its slot, its record and its connection either way. Off simply means
 * the rotation may consider it again from the next pass on - no fresh grace
 * period, no exception, exactly as if the star had never been set.
 *
 * Returns false for an address that is not a manual peer, so the caller can
 * say so rather than silently doing nothing.
 */
function setKept(address, kept) {
  const result = db.instance
    .prepare(`UPDATE trusted_peer SET kept = ? WHERE address = ?`)
    .run(kept ? 1 : 0, address);
  if (result.changes > 0) {
    logger.info(kept ? 'peer protected from rotation' : 'protection removed, peer is rotatable again', { address });
  }
  return result.changes > 0;
}

module.exports = {
  syncTrustedToAddnode,
  setKept,
  adoptExternalManualPeers,
  addTrustedPeer,
  removeTrustedPeer,
};
