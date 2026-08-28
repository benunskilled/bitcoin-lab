'use strict';

const db = require('./db');
const rpc = require('./rpc');
const logger = require('./logger').make('peer-sync');

/**
 * Makes sure every persisted trusted/manual peer is actually registered
 * with Bitcoin Core as an addnode. Bitcoin Core's own outbound/inbound
 * connections are never touched here - this only ever adds, it never
 * removes or replaces the normal automatic peers Core discovers on its
 * own (design principle: outbound discovery keeps working).
 */
async function syncTrustedToAddnode() {
  const trusted = db.instance.prepare(`SELECT address FROM trusted_peer`).all();
  let addedNodes = [];
  try {
    addedNodes = await rpc.getAddedNodeInfo();
  } catch (err) {
    logger.warn('getaddednodeinfo failed, skipping addnode sync this round', { error: err.message });
    return { trusted: trusted.length, existing: 0, added: 0 };
  }
  const existingAddrs = new Set(addedNodes.map((n) => n.addednode));

  let added = 0;
  for (const { address } of trusted) {
    if (existingAddrs.has(address)) continue;
    try {
      await rpc.addNode(address, 'add');
      added += 1;
      logger.info('restored trusted peer as addnode', { address });
    } catch (err) {
      logger.warn('failed to restore trusted peer as addnode', { address, error: err.message });
    }
  }

  logger.info('trusted/addnode sync complete', {
    trusted: trusted.length,
    existingAddnodes: existingAddrs.size,
    added,
  });
  return { trusted: trusted.length, existing: existingAddrs.size, added };
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
}

function removeTrustedPeer(address) {
  db.instance.prepare(`DELETE FROM trusted_peer WHERE address = ?`).run(address);
}

module.exports = { syncTrustedToAddnode, addTrustedPeer, removeTrustedPeer };
