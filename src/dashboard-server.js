'use strict';

/**
 * Dashboard - HTTP API + static frontend. Read-only status/ranking data
 * comes straight from SQLite (written by the other three processes);
 * actions (trust/manual-add/disconnect/pool management) call Bitcoin RPC
 * or write small config rows directly. Nothing here touches ZMQ or block
 * timing - this process is purely the operator-facing surface.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('./lib/config');
const db = require('./lib/db');
const rpc = require('./lib/rpc');
const queries = require('./lib/queries');
const peerSync = require('./lib/peer-sync');
const { manualAddPeer, hostFromAddress } = require('./lib/manual-peer');
const logger = require('./lib/logger').make('dashboard');

const PUBLIC_DIR = path.join(__dirname, 'dashboard', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleWidgetStats(req, res) {
  const ranking = queries.peerRanking();
  const stratum = queries.stratumRanking();
  const bestPeer = ranking.filter((p) => p.eligible >= 5).sort((a, b) => (b.firstPct || 0) - (a.firstPct || 0))[0];
  const bestPool = stratum.filter((p) => p.seen >= 3).sort((a, b) => (a.avgMs ?? Infinity) - (b.avgMs ?? Infinity))[0];
  const live = queries.liveSummary();

  sendJson(res, 200, {
    type: 'four-stats',
    refresh: '30s',
    link: '',
    items: [
      { title: 'Live Peers', text: String(live.total), subtext: 'connected' },
      { title: 'Best Peer', text: bestPeer ? `${bestPeer.firstPct.toFixed(0)}%` : '-', subtext: bestPeer ? bestPeer.address : 'n/a' },
      { title: 'Fastest Pool', text: bestPool && bestPool.avgMs != null ? `${bestPool.avgMs.toFixed(0)}ms` : '-', subtext: bestPool ? bestPool.label : 'n/a' },
      { title: 'Trusted', text: String(ranking.filter((p) => p.trusted).length), subtext: 'manual peers' },
    ],
  });
}

async function router(req, res, pathname, url) {
  if (req.method === 'GET' && pathname === '/api/status') {
    let blockHeight = null;
    try {
      blockHeight = await rpc.getBlockCount();
    } catch (err) {
      logger.debug('getblockcount failed', { error: err.message });
    }
    return sendJson(res, 200, {
      blockHeight,
      network: config.bitcoin.network,
      live: queries.liveSummary(),
      maxManualPeers: config.maxManualPeers,
    });
  }

  if (req.method === 'GET' && pathname === '/api/peers/ranking') {
    return sendJson(res, 200, queries.peerRanking());
  }

  if (req.method === 'GET' && pathname === '/api/peers/live') {
    return sendJson(res, 200, queries.liveSummary());
  }

  if (req.method === 'GET' && pathname === '/api/blocks/latest') {
    return sendJson(res, 200, queries.latestBlock());
  }

  if (req.method === 'POST' && pathname === '/api/peers/trust') {
    const { address, label } = await readBody(req);
    if (!address) return sendJson(res, 400, { error: 'address required' });
    const capacity = await peerSync.addTrustedPeer(address, label);
    return sendJson(res, 200, { ok: true, ...(capacity.overCapacity ? { warning: `queued - Bitcoin Core only maintains ${capacity.max} manual connections at once` } : {}) });
  }

  if (req.method === 'POST' && pathname === '/api/peers/untrust') {
    const { address } = await readBody(req);
    if (!address) return sendJson(res, 400, { error: 'address required' });
    await peerSync.removeTrustedPeer(address);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/peers/manual-add') {
    const { host } = await readBody(req);
    const result = await manualAddPeer(host);
    return sendJson(res, result.ok ? 200 : 422, result);
  }

  if (req.method === 'POST' && pathname === '/api/peers/add-manual') {
    // Same probe-then-persist flow as /api/peers/manual-add, but starting
    // from an existing peer row's address (live or not) instead of raw user
    // input - we always re-derive the bare host and re-probe 8333/9333
    // ourselves rather than trust whatever port that peer happened to be
    // observed on (see manual-peer.js for why that matters for inbound peers).
    const { address, label } = await readBody(req);
    if (!address) return sendJson(res, 400, { error: 'address required' });
    const host = hostFromAddress(address);
    const result = await manualAddPeer(host, label);
    return sendJson(res, result.ok ? 200 : 422, result);
  }

  if (req.method === 'POST' && pathname === '/api/peers/disconnect') {
    const { address } = await readBody(req);
    if (!address) return sendJson(res, 400, { error: 'address required' });
    try {
      await rpc.disconnectNode(address);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 422, { ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/pools') {
    const range = url.searchParams.get('range') || '10';
    return sendJson(res, 200, queries.stratumRanking(range));
  }

  if (req.method === 'POST' && pathname === '/api/pools') {
    const { label, host, port } = await readBody(req);
    if (!label || !host || !port) return sendJson(res, 400, { error: 'label, host and port are required' });
    try {
      db.instance
        .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 0, ?)`)
        .run(String(label).slice(0, 64), String(host).slice(0, 255), Number(port), Date.now());
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 409, { ok: false, error: err.message });
    }
  }

  const poolMatch = pathname.match(/^\/api\/pools\/(\d+)$/);
  if (poolMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const id = Number(poolMatch[1]);
    if (req.method === 'DELETE') {
      try {
        queries.deletePool(id);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
      return sendJson(res, 200, { ok: true });
    }
    const { enabled } = await readBody(req);
    db.instance.prepare(`UPDATE stratum_pool SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/widget/stats') {
    return handleWidgetStats(req, res);
  }

  return null; // not an API route
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  const { pathname } = url;

  try {
    if (pathname.startsWith('/api/')) {
      const handled = await router(req, res, pathname, url);
      if (handled === null) sendJson(res, 404, { error: 'not found' });
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    logger.error('request handler error', { path: pathname, error: err.message });
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

db.open();
server.listen(config.dashboardPort, () => {
  logger.info('dashboard listening', { port: config.dashboardPort });
});
