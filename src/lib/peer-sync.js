'use strict';

const db = require('./db');
const rpc = require('./rpc');
const config = require('./config');
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
async function syncTrustedToAddnode() {
  const trusted = db.instance.prepare(`SELECT address FROM trusted_peer ORDER BY created_at ASC`).all();
  let addedNodes = [];
  try {
    addedNodes = await rpc.getAddedNodeInfo();
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

async function addTrustedPeer(address, label) {
  db.instance
    .prepare(`INSERT INTO trusted_peer (address, label, created_at) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET label = excluded.label`)
    .run(address, label || null, Date.now());
  try {
    await rpc.addNode(address, 'add');
  } catch (err) {
    // addnode is idempotent-ish; "Node already added" is not an error worth failing on.
    logger.debug('addnode call while trusting peer', { address, error: err.message });
  }

  const count = db.instance.prepare(`SELECT COUNT(*) AS n FROM trusted_peer`).get().n;
  const overCapacity = count > config.maxManualPeers;
  return { count, max: config.maxManualPeers, overCapacity };
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
}

module.exports = { syncTrustedToAddnode, addTrustedPeer, removeTrustedPeer };
