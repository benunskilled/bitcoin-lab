'use strict';

/**
 * Dashboard - HTTP API + static frontend. Read-only status/ranking data
 * comes straight from SQLite (written by the other three processes);
 * actions (trust/manual-add/disconnect/pool management) call Bitcoin RPC
 * or write small config rows directly. Nothing here touches block timing -
 * this process is purely the operator-facing surface.
 *
 * It does subscribe to Core's `pubhashblock` ZMQ topic, but only to push a
 * "new block" event to connected browsers (see /api/events). That is a
 * separate socket in a separate process from the relay profiler's, so it
 * cannot affect what the profiler measures.
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
const health = require('./lib/health');
const processGuard = require('./lib/process-guard');
const hashblock = require('./lib/hashblock-subscriber');
const { validatePool } = require('./lib/validate');
const { manualAddPeer, probePeer, hostFromAddress } = require('./lib/manual-peer');
const peerRotation = require('./lib/peer-rotation');
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

// How stale a worker's heartbeat may get before the dashboard reports it as
// unhealthy. All three write one every 30s (see lib/health.js), so these are
// generous multiples of that - a single missed beat under load is not a
// fault, three in a row is.
const SERVICE_STALE_MS = {
  'peer-profiler': 120_000,
  'relay-profiler': 120_000,
  'stratum-race': 120_000,
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
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Without an explicit directive, browsers apply heuristic caching to
      // these responses and can keep serving a stale index.html/app.js for
      // a long time after an app update - exactly what made the new "Show
      // all" button invisible until a hard refresh. no-cache forces a
      // conditional revalidation on every load instead (cheap for a small
      // self-hosted dashboard), so updates show up on a normal reload.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Live block events (Server-Sent Events)
//
// Replaces a 5-second poll of /api/blocks/latest - 720 requests an hour to
// catch an event that happens roughly six times an hour, and which still
// arrived up to five seconds late. The block wave is now driven by the same
// ZMQ notification Core sends the relay profiler, so it is both cheaper and
// visibly more immediate.
// ---------------------------------------------------------------------------

const sseClients = new Set();
// Core publishes the hash the moment the block is connected; the relay
// profiler writes its race row microseconds later, in a different process.
// Waiting briefly before reading means the payload carries the finished race
// (including which peer was first) rather than the previous one.
const BLOCK_SETTLE_MS = 750;
const SSE_KEEPALIVE_MS = 25_000;
let lastBroadcastRaceId = null;

function sseBroadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

function broadcastLatestBlock({ force = false } = {}) {
  let race;
  try {
    race = queries.latestBlock();
  } catch (err) {
    logger.warn('could not read latest block for event stream', { error: err.message });
    return;
  }
  if (!race) return;
  if (!force && race.id === lastBroadcastRaceId) return;
  lastBroadcastRaceId = race.id;
  sseBroadcast('block', race);
}

function handleEventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Umbrel puts every app behind its own proxy; without this a proxy may
    // buffer the stream and deliver events in batches, which would defeat
    // the entire point of switching away from polling.
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);

  // Send the current state straight away so a freshly opened dashboard shows
  // the latest block without waiting for the next one.
  try {
    const race = queries.latestBlock();
    if (race) res.write(`event: block\ndata: ${JSON.stringify(race)}\n\n`);
  } catch (err) {
    logger.debug('initial block event failed', { error: err.message });
  }

  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepalive);
    }
  }, SSE_KEEPALIVE_MS);
  keepalive.unref?.();

  const cleanup = () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ---------------------------------------------------------------------------

function serviceHealth() {
  const services = {};
  let allOk = true;
  for (const [service, maxAgeMs] of Object.entries(SERVICE_STALE_MS)) {
    const beat = health.read(db, service);
    const ageMs = beat ? Date.now() - beat.at : null;
    const ok = ageMs != null && ageMs <= maxAgeMs;
    if (!ok) allOk = false;
    services[service] = { ok, ageMs, ...(beat || {}), at: undefined };
  }
  return { allOk, services };
}

async function handleWidgetStats(req, res) {
  const { live, bestPeer, bestPool, trustedTotal, trustedOnline } = queries.widgetStats();

  sendJson(res, 200, {
    type: 'four-stats',
    // The cadence Umbrel actually uses is the `refresh` in the manifest's
    // widgets: block, not this field - it is echoed here only so the payload
    // is self-describing. Keep the two in step. 60s is plenty for a
    // home-screen glance, and this endpoint is polled whether or not anyone
    // has the dashboard open, which is why widgetStats() is four small
    // queries rather than a slice of the full rankings.
    refresh: '60s',
    link: '',
    items: [
      { title: 'Live Peers', text: String(live.total), subtext: 'connected' },
      { title: 'Best Peer', text: bestPeer ? `${bestPeer.firstPct.toFixed(0)}%` : '-', subtext: bestPeer ? bestPeer.address : 'n/a' },
      { title: 'Fastest Pool', text: bestPool && bestPool.avgMs != null ? `${bestPool.avgMs.toFixed(0)}ms` : '-', subtext: bestPool ? bestPool.label : 'n/a' },
      // "3/4" rather than just a raw trusted count - a manual peer can drop
      // and Core's own reconnect can silently stall, so whether they're
      // ACTUALLY connected right now belongs on the at-a-glance home
      // widget, not only visible after opening the dashboard.
      {
        // "Manual", not "Trusted" - the panel in the dashboard is called
        // Manual Peers and Core calls the connection type manual. One word
        // for one thing.
        title: 'Manual',
        text: `${trustedOnline}/${trustedTotal}`,
        subtext: trustedOnline === trustedTotal ? 'manual peers online' : 'manual peers - check dashboard',
      },
    ],
  });
}

async function router(req, res, pathname, url) {
  if (req.method === 'GET' && pathname === '/api/health') {
    // 200 means THIS process is serving and can read its database - that is
    // what the dashboard container's own healthcheck is asking. The state of
    // the three worker processes is reported alongside it (they have no HTTP
    // port of their own and are checked via their heartbeats) so the UI can
    // surface a stuck or crash-looping worker, which was previously
    // invisible from anywhere.
    let dbOk = true;
    try {
      db.instance.prepare('SELECT 1').get();
    } catch (err) {
      dbOk = false;
      logger.error('health check: database unreadable', { error: err.message });
    }
    const { allOk, services } = dbOk ? serviceHealth() : { allOk: false, services: {} };
    return sendJson(res, dbOk ? 200 : 503, {
      ok: dbOk,
      allServicesOk: dbOk && allOk,
      version: require('../package.json').version,
      services,
    });
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    handleEventStream(req, res);
    return true;
  }

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
      // The measurement data only ever grows - roughly four megabytes a day at
      // a couple of hundred peers, measured. Shown so that is visible from the
      // start rather than discovered when the disk fills.
      databaseBytes: db.sizeBytes(),
      // Four counts over the whole history, not the current snapshot: how many
      // outbound peers Core has handed this node, how many lasted long enough
      // to be judged, how many ever delivered, how many were kept. Cheap - one
      // aggregate over a table that already exists, plus a COUNT of a table
      // with one row per promoted IP.
      outboundFunnel: queries.outboundFunnel(),
    });
  }

  if (req.method === 'GET' && pathname === '/api/peers/ranking') {
    return sendJson(res, 200, queries.peerRanking());
  }

  // Removed in v1.13.0, all three unused by anything in this repo:
  //   GET  /api/peers/live    - /api/status already carries liveSummary()
  //   GET  /api/blocks/latest - blocks arrive over /api/events instead
  //   POST /api/peers/trust   - the dangerous one. It wrote whatever address
  //     it was handed straight into trusted_peer, with no port probe and no
  //     bracket normalisation, so an IPv6 address added through it could
  //     never match Core's own formatting and an unreachable one would be
  //     re-addnode'd every ten minutes forever. Everything in the UI goes
  //     through /api/peers/add-manual, which probes first.

  // Its own endpoint rather than a field on /api/status: dbstat walks every
  // page of the database to get exact per-table sizes, which is fine on demand
  // and wrong in a twenty-second poll.
  if (req.method === 'GET' && pathname === '/api/storage') {
    return sendJson(res, 200, db.storageBreakdown());
  }

  // Irreversible, so it takes an explicit scope rather than defaulting to
  // anything. There is no "reset everything" - the two groups are separate
  // decisions, and the manual peers are never part of either.
  if (req.method === 'POST' && pathname === '/api/reset') {
    const { scope } = await readBody(req);
    if (scope === 'peers') return sendJson(res, 200, { ok: true, scope, ...db.resetPeerData() });
    if (scope === 'pools') return sendJson(res, 200, { ok: true, scope, ...db.resetPoolHistory() });
    return sendJson(res, 400, { error: 'scope must be "peers" or "pools"' });
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

  // Reachability only - the same TCP handshake the add path runs first, with
  // nothing after it. "Is this peer even reachable?" is a question worth being
  // able to ask on its own: the answer decides whether adding it is worth a
  // manual slot at all, and asking it should not cost one.
  if (req.method === 'POST' && pathname === '/api/peers/probe') {
    const { host } = await readBody(req);
    const result = await probePeer(host);
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

  // The star. Sets or clears the protection on a manual peer and nothing
  // else - no disconnect, no addnode, no change to its record. Deliberately
  // its own route rather than a flag on add-manual: taking the star off is a
  // decision of its own, and it happens long after the peer was added.
  if (req.method === 'POST' && pathname === '/api/peers/keep') {
    const { address, kept } = await readBody(req);
    if (!address) return sendJson(res, 400, { error: 'address required' });
    const changed = peerSync.setKept(address, Boolean(kept));
    if (!changed) return sendJson(res, 404, { error: 'not a manual peer' });
    return sendJson(res, 200, { ok: true, address, kept: Boolean(kept) });
  }

  if (req.method === 'GET' && pathname === '/api/rotation') {
    return sendJson(res, 200, {
      enabled: peerRotation.isEnabled(),
      log: peerRotation.recentLog(),
      // Manual peers that lost their slot to a long absence and are being
      // re-tested. Shown so "where did my peer go?" has a visible answer on
      // the same screen that took it away.
      parked: peerRotation.parkedPeers(),
    });
  }

  if (req.method === 'POST' && pathname === '/api/rotation/toggle') {
    const { enabled } = await readBody(req);
    peerRotation.setEnabled(Boolean(enabled));
    return sendJson(res, 200, { ok: true, enabled: peerRotation.isEnabled() });
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
    const body = await readBody(req);
    // Validated properly rather than merely checked for truthiness. An
    // out-of-range port used to be stored happily and then killed the
    // stratum-race process on every tick, since net.connect() throws
    // synchronously for one - a crash loop no restart could clear, from a
    // single typo in this form. See lib/validate.js.
    const parsed = validatePool(body);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    try {
      db.instance
        .prepare(`INSERT INTO stratum_pool (label, host, port, enabled, is_default, created_at) VALUES (?, ?, ?, 1, 0, ?)`)
        .run(parsed.value.label, parsed.value.host, parsed.value.port, Date.now());
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 409, { ok: false, error: 'a pool with this host and port already exists' });
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
    const body = await readBody(req);
    // `enabled` absent used to mean `undefined` -> 0, so a PATCH with an empty
    // body silently disabled the pool and answered 200. Say what was wrong.
    if (typeof body.enabled !== 'boolean') {
      return sendJson(res, 400, { error: 'enabled must be true or false' });
    }
    const updated = db.instance
      .prepare(`UPDATE stratum_pool SET enabled = ? WHERE id = ?`)
      .run(body.enabled ? 1 : 0, id);
    if (updated.changes === 0) return sendJson(res, 404, { error: `no pool with id ${id}` });
    return sendJson(res, 200, { ok: true, enabled: body.enabled });
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
    // A malformed request body is the caller's mistake, not ours - answering
    // 500 "internal error" sends whoever is debugging it looking in the wrong
    // place entirely.
    if (/invalid JSON body|body too large/i.test(err.message || '')) {
      logger.debug('rejected a malformed request body', { path: pathname, error: err.message });
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
      return;
    }
    logger.error('request handler error', { path: pathname, error: err.message });
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

function main() {
  let subscription = null;
  let safetyTimer = null;
  processGuard.install(logger, {
    onShutdown: () => {
      if (subscription) subscription.stop();
      clearInterval(safetyTimer);
      for (const res of sseClients) {
        try { res.end(); } catch { /* client already gone */ }
      }
      server.close();
    },
  });

  db.open();
  health.start(db, 'dashboard', logger, () => ({ sseClients: sseClients.size }));

  subscription = hashblock.start({
    url: config.bitcoin.zmqHashBlockUrl,
    logger,
    onBlock: () => setTimeout(() => broadcastLatestBlock(), BLOCK_SETTLE_MS),
  });

  // Safety net for the event stream: if ZMQ is unavailable to THIS process
  // for any reason, the browser still gets its block events, just a little
  // later. One indexed single-row read, and it emits nothing unless the race
  // id actually changed.
  safetyTimer = setInterval(() => broadcastLatestBlock(), 20_000);
  safetyTimer.unref?.();

  server.on('error', (err) => {
    // Previously an EADDRINUSE surfaced as a bare stack trace with no
    // indication of which port or why.
    logger.error('http server error', { port: config.dashboardPort, error: err.message });
    process.exit(1);
  });

  server.listen(config.dashboardPort, () => {
    logger.info('dashboard listening', { port: config.dashboardPort });
  });
}

if (require.main === module) main();

module.exports = { server, main };
