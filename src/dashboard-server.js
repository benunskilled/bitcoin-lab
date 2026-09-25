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
const sibling = require('./lib/sibling');
const health = require('./lib/health');
const processGuard = require('./lib/process-guard');
const hashblock = require('./lib/hashblock-subscriber');
const { validatePool } = require('./lib/validate');
const { manualAddPeer, probePeer, hostFromAddress } = require('./lib/manual-peer');
const peerRotation = require('./lib/peer-rotation');
const stratumRace = require('./lib/stratum-race-toggle');
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

// Sent on every response this process makes - the JSON API, the static files
// and the event stream alike.
//
// The policy is character for character the one Peer Map already serves next
// door (its main.go), and that is the point rather than a coincidence: the two
// apps are two windows onto the same node, and a rule that holds in one and
// not the other is a rule nobody can reason about.
//
// The page satisfies it as it stands. index.html has no inline <script>, no
// <style> block, no style="" attribute and no inline event handler - every
// click goes through a delegated listener in app.js keyed on data-action - so
// neither 'unsafe-inline' nor a nonce is needed for scripts or styles.
// Everything it loads (app.js, style.css, favicon.svg) is same-origin, the
// stylesheet references no url(), and every request the page makes - fetch to
// /api/*, the EventSource on /api/events - is same-origin too. The one thing
// that was not was a cross-origin knock on Peer Map's port from the browser;
// that question is answered by this process now (/api/status peerMapInstalled,
// via lib/sibling.js) and the browser-side probe is gone with it.
//
// No CORS headers: nothing reads this API from another origin. Peer Map polls
// /api/blocks/latest from its own Go process, container to container, where
// the browser's origin rules never enter into it.
//
// X-Frame-Options as well as frame-ancestors - the CSP directive is the one
// that counts on anything current, the header covers whatever older proxy or
// browser sits between this and the operator.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * The `address` field the peer write endpoints act on.
 *
 * Truthiness was the whole check, and everything that got past it failed in a
 * different way, none of them good.
 *
 * `{"address": 3}` on /api/peers/disconnect is the serious one. It is not a
 * malformed address, it is a different command: rpc.disconnectNode routes a
 * number as Core's numeric peer id (Core's disconnectnode takes either), so it
 * disconnects whatever session Core currently calls peer 3 - a session nobody
 * selected, which the page need never have shown, and which the reply then
 * reports as `{"ok": true}`.
 *
 * On the other two the same number binds happily into a TEXT comparison,
 * matches nothing, and untrust answers 200 for a peer it did not untrust. A
 * boolean or an object does not bind at all: better-sqlite3 throws and the
 * caller gets a bare 500 for what was only ever a badly typed field.
 *
 * Missing stays 400 ("you left it out"); present but not a string is 422
 * ("you sent the wrong kind of thing"), which is the distinction the dashboard
 * already makes for the probe/add routes.
 */
function readAddress(res, address) {
  if (address === undefined || address === null || address === '') {
    sendJson(res, 400, { error: 'address required' });
    return null;
  }
  if (typeof address !== 'string' || address.trim() === '') {
    sendJson(res, 422, {
      error: `address must be a string like "203.0.113.50:8333", not ${typeof address}`,
    });
    return null;
  }
  return address;
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
    res.writeHead(403, SECURITY_HEADERS).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
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
const POOL_SETTLE_MS = 4000;
const SSE_KEEPALIVE_MS = 25_000;
// How many event streams may be held open at once.
//
// Every one of them costs a response object kept alive for as long as its tab
// is, a keepalive timer firing every 25 seconds, and a share of the fan-out on
// each block. Nothing bounded that: /api/events accepted connections until the
// process ran out of file descriptors, and a page anyone on the LAN can open
// in a loop is all it takes.
//
// Thirty-two because this is one household's dashboard on one node. A few tabs
// on a few devices is the real maximum; thirty-two is already generous enough
// that nobody reaches it by using the app, and small enough that the timers and
// sockets behind it stay trivial.
const MAX_SSE_CLIENTS = 32;
// The pool a block was mined by arrives a moment after the race itself (the
// relay profiler reads the coinbase once the race is written), so the same
// race is worth sending twice: once when it lands, once when it has a name.
// Keying the dedupe on both is what lets the safety net below deliver the
// second one without sending anything else.
let lastBroadcastKey = null;

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
  const key = `${race.id}:${race.poolSource || ''}`;
  if (!force && key === lastBroadcastKey) return;
  lastBroadcastKey = key;
  sseBroadcast('block', race);
}

function handleEventStream(req, res) {
  // Full. Say so, and say when to come back, rather than accepting a
  // connection this process cannot afford to keep - a stream that is opened
  // and then starved looks to the page exactly like a node that stopped
  // producing blocks.
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    logger.warn('refused an event stream, too many are already open', { open: sseClients.size, limit: MAX_SSE_CLIENTS });
    res.setHeader('Retry-After', '30');
    sendJson(res, 503, { error: `too many event streams open (limit ${MAX_SSE_CLIENTS}) - close a dashboard tab and reload` });
    return;
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
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

// How long without a single block before the ZMQ subscription is presumed
// stalled rather than merely quiet.
//
// Six hours, and the interesting part is why it is not three.
//
// Measurement first: across 2,205 gaps recorded on a live node the longest was
// 78 minutes, five were over an hour, and none reached two. Three hours looked
// like plenty. It is not, and the sample is the reason - fifteen days cannot
// see the tail of this distribution at all. A 150-minute gap would have been
// expected 0.0007 times in that sample, so finding none rules out nothing.
//
// The textbook model is no better. Treating blocks as a Poisson process at a
// constant ten minutes puts a 150-minute gap at one per sixty years. The real
// network has done better than that twice in one summer: 122 minutes on 19
// April 2021 when power cuts in Xinjiang took 45% of the hashrate off
// overnight, and 2 hours 19 minutes between blocks 689,300 and 689,301 on 1
// July 2021 during the Chinese mining ban - the longest gap since 2009. The
// model is wrong in the tail because the hashrate is not constant, and a
// difficulty period that opened with more hashrate than it closes with
// stretches every gap inside it.
//
// So three hours would sit forty minutes above the all-time record, which is
// no margin at all for a warning that must not cry wolf - least of all during
// exactly the sort of network-wide event that produces those gaps, when the
// operator has enough to think about. Six hours is more than twice the record.
// It matches the stratum idle backstop below, for the same reason, and the
// extra three hours cost nothing: this is a fault that lasts until somebody
// notices it, so finding it the same day is the whole win.
//
// It has to be this blunt because nothing better exists. zmq's connect() is
// not a connection (see hashblock-subscriber.js), so a subscription pointed at
// a dead port reports itself as connected indefinitely. Blocks arriving is the
// only evidence there is.
const ZMQ_STALL_MS = 6 * 60 * 60 * 1000;

/**
 * Is the relay profiler still hearing from Core?
 *
 * Separate from the heartbeat, which only says the process is alive - and it
 * is: it is sitting on a socket that will never speak again, writing "I am
 * well" every thirty seconds. Nothing is recorded, the tables stop growing,
 * and every other indicator on the page looks normal.
 *
 * `since` is the last block if there has been one, and otherwise when the
 * subscription started, so an install whose ZMQ was never reachable at all is
 * caught by the same rule instead of sitting at null forever.
 */
function zmqHealth(services) {
  const beat = services['relay-profiler'];
  if (!beat || !beat.ok) return null;   // a dead worker is already being reported
  const since = beat.lastBlockAtMs ?? beat.subscribedAtMs;
  if (typeof since !== 'number') return null;   // an older worker that does not report it
  const quietMs = Date.now() - since;
  return {
    ok: quietMs <= ZMQ_STALL_MS,
    quietMs,
    everReceived: typeof beat.lastBlockAtMs === 'number',
  };
}

// How far Core's clock may sit from this app's before it is worth saying so.
//
// Two seconds, set against the 2.5 the attribution window allows - so the
// warning arrives while attribution still mostly works rather than after it
// has stopped. Not lower, because an HTTP date is whole seconds and the
// estimate carries about a second of uncertainty of its own; a threshold at
// one second would be reporting its own rounding.
//
// The whole question only exists for a Core on another machine. Two processes
// on one host read one clock, so this is nought by construction on Umbrel.
const CLOCK_OFFSET_WARN_MS = 2000;

/**
 * Whether the two clocks agree, read from the Date header Core puts on every
 * RPC response (see rpc.js).
 *
 * Deliberately separate from the attribution check. That one says "nothing is
 * being credited", which is the damage, and can only speak once three blocks
 * have gone by. This says "the clocks are four seconds apart", which is the
 * cause, and it can say it on the first call - before First % has had a chance
 * to stick at zero.
 */
function clockHealth() {
  const reading = rpc.clockOffset();
  if (!reading) return null;
  return {
    ok: Math.abs(reading.offsetMs) < CLOCK_OFFSET_WARN_MS,
    offsetMs: reading.offsetMs,
    samples: reading.samples,
    maxRttMs: reading.maxRttMs,
  };
}

// The largest "last N races" window /api/pools will answer.
//
// The range turns into one bound parameter per race in an IN() list
// (queries/stratum.js builds it), and SQLite refuses to compile a statement
// with more than SQLITE_MAX_VARIABLE_NUMBER of them - 32,766 on the build
// better-sqlite3 ships. Number(range) was taken as given, so the size of that
// list was set by the caller and bounded only by how much history the install
// had accumulated: with a long enough race table, range=100000 stopped being a
// slow query and became a prepare() that throws, i.e. a 500 on a panel that
// used to work.
//
// A thousand because nothing legitimate wants more: the selector offers 10,
// 100 and "all", and "all" takes the unfiltered path that binds no parameters
// at all, so it is both the cheapest answer and the one somebody asking for
// "everything" actually means. A hand-written range past this is clamped
// rather than refused - there is no wrong answer to give them, only a smaller
// window than they typed.
const MAX_POOL_RANGE = 1000;

function poolRange(raw) {
  if (raw === null || raw === '') return '10';
  if (raw === 'all') return 'all';
  const n = Number(raw);
  // Anything unrecognisable is passed through untouched: stratumRanking() has
  // its own rule for that (fail open to all-time), and it is not this
  // function's business to change it.
  if (!Number.isFinite(n) || n <= 0) return raw;
  return String(Math.min(Math.floor(n), MAX_POOL_RANGE));
}

// "12.3 GB" - the widget has room for a number and a unit, nothing more.
function fmtBytesShort(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes || 0;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1024; i += 1; }  // 1024-based, like the dashboard
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1)} ${units[i]}`;
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
    // Every worker can be alive and reporting in while the thing they exist to
    // do quietly produces nothing - which is what a clock disagreement between
    // Core and this app looks like. Reported beside the heartbeats because it
    // is the same question from the user's side: is this working?
    //
    // Not part of `ok`: the HTTP status answers the container's healthcheck,
    // and a clock problem on the node is not a reason for Docker to restart
    // this process in a loop.
    let attribution = null;
    if (dbOk) {
      try {
        attribution = queries.attributionHealth();
      } catch (err) {
        logger.warn('attribution health check failed', { error: err.message });
      }
    }
    return sendJson(res, dbOk ? 200 : 503, {
      ok: dbOk,
      allServicesOk: dbOk && allOk,
      version: require('../package.json').version,
      services,
      attribution,
      zmq: dbOk ? zmqHealth(services) : null,
      coreClock: clockHealth(),
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
      // Named in a column heading, so it is read from the config rather than
      // written into the page: a heading that states the wrong window is worse
      // than one that states none.
      recentScoreWindowBlocks: config.recentScoreWindowBlocks,
      // The measurement data only ever grows - roughly four megabytes a day at
      // a couple of hundred peers, measured. Shown so that is visible from the
      // start rather than discovered when the disk fills.
      databaseBytes: db.sizeBytes(),
      // How many recorded blocks credited more than one peer - the resolution
      // of the First measurement, stated rather than assumed. Cheap because of
      // the partial index on the First rows; null on an install that has not
      // seen a block yet.
      firstTies: queries.firstTies(),
      // Four counts over the whole history, not the current snapshot: how many
      // outbound peers Core has handed this node, how many lasted long enough
      // to be judged, how many ever delivered, how many were kept. Cheap - one
      // aggregate over a table that already exists, plus a COUNT of a table
      // with one row per promoted IP.
      outboundFunnel: queries.outboundFunnel(),
      // Whether the pool race is running at all. The page needs it before it
      // renders anything of that card: switched off there is nothing to show
      // and, more to the point, nothing being measured, so a table of
      // yesterday's numbers would be a lie told by a stale row.
      stratumRaceEnabled: stratumRace.isEnabled(),
      // Whether Peer Map is installed beside this app. The page uses it to
      // decide whether to offer a link there at all - a link to an app nobody
      // installed is worse than no link.
      peerMapInstalled: await sibling.isInstalled(),
    });
  }

  if (req.method === 'GET' && pathname === '/api/peers/ranking') {
    return sendJson(res, 200, queries.peerRanking());
  }

  // For the app next door. Peer Map shows the same peers on a map and marks
  // the one that delivered the last block, so it needs the block - but it
  // polls every ten seconds and holds no connection open, which is why this
  // is a plain reply and not the event stream this page uses.
  //
  // Deliberately narrow: the height, when it arrived, who mined it, and the
  // addresses that were credited. Not whatever latestBlock() grows later, and
  // not the labels the owner gave his peers.
  if (req.method === 'GET' && pathname === '/api/blocks/latest') {
    const race = queries.blockDetail();
    if (!race) return sendJson(res, 200, null);
    return sendJson(res, 200, {
      hash: race.blockHash,
      height: race.blockHeight,
      detectedAt: race.detectedAt,
      pool: race.pool,
      poolName: race.poolName,
      poolTag: race.poolTag,
      poolSource: race.poolSource,
      firstPeers: race.firstPeers.map((p) => p.address),
      // How many peers could have delivered it - the denominator behind the
      // one that did.
      eligible: race.eligible,
      // The same block seen from the mining side, when a race was recorded
      // for it. null is the normal answer with Stratum Race switched off.
      stratum: race.stratum,
      // The route's two remaining stops: how long after the announcement
      // Core had a new block template ready, and the delivering peer's ping
      // from the snapshot that credited it. null on older blocks.
      templateMs: race.templateMs ?? null,
      // How many transactions that template carried - why one block's job
      // takes longer than the next.
      templateTx: race.templateTx ?? null,
      firstPingMs: race.firstPingMs ?? null,
      // The same route for the typical block - the median over the last
      // hundred - so a change shows up as a shorter stretch.
      routeMedian: queries.routeMedian(),
      // Every address ever credited with a First, so Peer Map can tint the
      // rows of the connections that have actually brought a block.
      deliveredEver: queries.deliveredEver(),
    });
  }

  // Removed in v1.13.0, both unused by anything in this repo:
  //   GET  /api/peers/live    - /api/status already carries liveSummary()
  //
  // /api/blocks/latest went the same way and came back above in 1.20.0: this
  // page still gets its blocks over /api/events, but Peer Map next door has
  // no event stream and should not open one.
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
    if (!readAddress(res, address)) return true;
    await peerSync.removeTrustedPeer(address);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/peers/manual-add') {
    // The typed-in box, and the only path that stars what it adds: an address
    // entered by hand names a peer this node may have no record of, so the
    // rotation must not take it away before its owner has seen it work.
    const { host } = await readBody(req);
    const result = await manualAddPeer(host, undefined, { kept: true });
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
    //
    // Unstarred, unlike the typed-in box above. This peer is in the ranking
    // because the app measured it, so promoting it by hand is the same call
    // the rotation makes on merit - and the peers this button sits next to
    // are the pool the rotation promotes FROM.
    const { address, label } = await readBody(req);
    if (!readAddress(res, address)) return true;
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
    if (!readAddress(res, address)) return true;
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
    if (!readAddress(res, address)) return true;
    try {
      await rpc.disconnectNode(address);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 422, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/stratum/toggle') {
    const { enabled } = await readBody(req);
    stratumRace.setEnabled(Boolean(enabled));
    // The worker closes or opens its sockets on its own 30-second check - this
    // process has no way to reach into it, and should not have one.
    return sendJson(res, 200, { ok: true, enabled: stratumRace.isEnabled() });
  }

  if (req.method === 'GET' && pathname === '/api/pools') {
    return sendJson(res, 200, queries.stratumRanking(poolRange(url.searchParams.get('range'))));
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

  // The node's traffic: the chart and totals.
  if (req.method === 'GET' && pathname === '/api/traffic') {
    return sendJson(res, 200, queries.trafficDays(30));
  }

  // The second home-screen widget: today up, today down, the last 30 days.
  if (req.method === 'GET' && pathname === '/api/widget/traffic') {
    const t = queries.trafficDays(30);
    return sendJson(res, 200, {
      type: 'three-stats',
      refresh: '3600s',
      link: '',
      items: [
        { text: fmtBytesShort(t.today.sent), subtext: 'sent today' },
        { text: fmtBytesShort(t.today.recv), subtext: 'received today' },
        { text: fmtBytesShort(t.month.sent + t.month.recv), subtext: 'last 30 days' },
      ],
    });
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
    onBlock: () => {
      setTimeout(() => broadcastLatestBlock(), BLOCK_SETTLE_MS);
      // And again once the coinbase has been read - two RPC calls after the
      // race, so a second or two later. Sends nothing if the answer has not
      // changed, and the 20-second net below catches a slow one.
      setTimeout(() => broadcastLatestBlock(), POOL_SETTLE_MS);
    },
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
