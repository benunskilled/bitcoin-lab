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
  if (checkedAtMs && Date.now() - checkedAtMs < RECHECK_MS) return present;
  inFlight = ask().then((ok) => {
    present = ok;
    checkedAtMs = Date.now();
    inFlight = null;
    return ok;
  });
  return inFlight;
}

// Tests need a clean slate between cases.
function reset() {
  checkedAtMs = 0;
  present = false;
  inFlight = null;
}

module.exports = { isInstalled, reset, target };
