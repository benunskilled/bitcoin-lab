'use strict';

const http = require('http');

/**
 * The other half of the pair is Peer Map: a separate app, installed on its own,
 * that puts these same peers on a world map and says what kind of software each
 * one runs. When it is installed on the same node, this dashboard offers a link
 * to it - for the dashboard as a whole and for a single peer.
 *
 * Whether it is there is a question for this process, not for the browser. From
 * inside the umbrel network the question is the real one - does the container
 * exist - and it is reachable by name, exactly like Bitcoin Core is. A browser
 * could only ever learn whether something answers on a port, and would have to
 * be allowed to talk to a second origin to do it.
 *
 * A miss is the normal case: most people will install one app and not the
 * other. So a failure is silent and simply means no link.
 */
const DEFAULT_URL = 'http://bitcoinlab-peermap_web_1:8789/api/health';
// An app is installed or removed by hand. Asking once every five minutes is
// already generous, and it keeps a missing neighbour from costing a request on
// every dashboard poll.
const RECHECK_MS = 5 * 60 * 1000;
// A miss is asked again sooner: updated together, Peer Map may still be
// starting when this app asks, and the link stayed away for five minutes
// (28.10.2026).
const RECHECK_MISS_MS = 30 * 1000;
const TIMEOUT_MS = 2000;

// Read per call rather than at load: a test sets it between cases, and there
// is no cost worth saving here.
const target = () => process.env.PEERMAP_HEALTH_URL || DEFAULT_URL;
let checkedAtMs = 0;
let present = false;
let inFlight = null;

function ask() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    let req;
    try {
      req = http.get(target(), { timeout: TIMEOUT_MS }, (res) => {
        // The body is of no interest; draining it lets the socket close.
        res.resume();
        finish(res.statusCode === 200);
      });
    } catch {
      return finish(false);
    }
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
  });
}

/**
 * Whether Peer Map answered recently. Returns the cached answer without waiting
 * whenever one is fresh enough, and never lets two checks run at once.
 */
async function isInstalled() {
  if (target() === 'off') return false;
  // A check already running is the answer everyone waits for. This has to come
  // before the freshness test: stamping the clock at the START of a check made
  // every caller during it read the previous answer instead - so the first poll
  // after a restart reported "not installed" and the page only caught up twenty
  // seconds later.
  if (inFlight) return inFlight;
  if (checkedAtMs && Date.now() - checkedAtMs < (present ? RECHECK_MS : RECHECK_MISS_MS)) return present;
  inFlight = ask().then((ok) => {
    present = ok;
    checkedAtMs = Date.now();
    inFlight = null;
    return ok;
  });
  return inFlight;
}

// What Peer Map makes of a peer that this app cannot tell from the name alone:
// a Core name on software that is not Core (Disguised), and the pool a node
// belongs to. Peer Map decides that from what the peer does - which services
// it offers, which messages it leaves out - and keeping one copy of those
// checks, in Peer Map, keeps the two apps from contradicting each other.
//
// Never waited for: the ranking is answered from what was fetched last, and a
// fetch starts at most once a minute, only while this page is being polled.
// Peer Map answers from its own cache, so this asks Core nothing new. Peer
// Map's list can take seconds when Core is slow, which is why nobody waits.
const KINDS_EVERY_MS = 60 * 1000;
const KINDS_TIMEOUT_MS = 30 * 1000;
// Peer Map's whole list, geography included: a few hundred kilobytes for a
// few hundred peers. Anything far larger is not that list.
const KINDS_MAX_BYTES = 16 * 1024 * 1024;
const kindsTarget = () => target().replace(/\/api\/health$/, '/api/peers');
let kinds = new Map();
let kindsAtMs = 0;
// Peer Map's names outlive a failed answer, but not by long: after ten
// minutes without one they are its old word on peers that have moved on.
const KINDS_STALE_MS = 10 * 60 * 1000;
let kindsOkAtMs = 0;
let kindsInFlight = false;

function fetchKinds() {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.get(kindsTarget(), { timeout: KINDS_TIMEOUT_MS }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > KINDS_MAX_BYTES) { req.destroy(); return resolve(null); }
          chunks.push(c);
        });
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      });
    } catch {
      return resolve(null);
    }
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// What the ranking needs to name a peer readably (09.11.2026: a raw user
// agent, cut short, named nobody, and 22 wallets read as Core): its kind, the
// name Peer Map gives it, why a disguise is one, whose pool, another chain,
// and whether its software passes blocks on at all.
// Only what is set; strings are Peer Map's and capped, shown escaped.
function kindsOf(body) {
  const out = new Map();
  for (const p of (body && Array.isArray(body.peers)) ? body.peers : []) {
    if (!p || typeof p.addr !== 'string' || typeof p.kind !== 'string') continue;
    const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
    const m = { kind: str(p.kind) };
    if (str(p.tell)) m.why = str(p.tell);
    if (str(p.pool)) m.pool = str(p.pool);
    if (str(p.label)) m.label = str(p.label);
    if (str(p.fork)) m.fork = str(p.fork);
    if (str(p.name)) m.name = str(p.name);
    if (p.no_relay === true) m.noRelay = true;
    if (p.linking_lion === true) m.lion = true;
    out.set(p.addr, m);
  }
  return out;
}

/**
 * Peer Map's word on each peer it marks, by address - from the last answer,
 * without waiting. An empty map when Peer Map is not installed or not yet
 * asked; a failed fetch keeps the previous answer for up to ten minutes.
 */
function peerKinds() {
  if (target() === 'off') return new Map();
  if (!present) {
    // Not installed (or not known to be): ask whether it is, for next time,
    // and say nothing - old marks from an app since removed are not shown.
    isInstalled().catch(() => {});
    kinds = new Map();
    return kinds;
  }
  if (!kindsInFlight && Date.now() - kindsAtMs >= KINDS_EVERY_MS) {
    kindsInFlight = true;
    kindsAtMs = Date.now();
    fetchKinds().then((body) => {
      if (body) { kinds = kindsOf(body); kindsOkAtMs = Date.now(); }
      else if (Date.now() - kindsOkAtMs > KINDS_STALE_MS) kinds = new Map();
    }).finally(() => { kindsInFlight = false; });
  }
  return kinds;
}

// Tests need a clean slate between cases.
function reset() {
  checkedAtMs = 0;
  present = false;
  inFlight = null;
  kinds = new Map();
  kindsAtMs = 0;
  kindsOkAtMs = 0;
  kindsInFlight = false;
}

module.exports = { isInstalled, peerKinds, reset, target };
