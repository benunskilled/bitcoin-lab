'use strict';

const net = require('net');
const { EventEmitter } = require('events');

// How often a still-connected pool with no notify data emits a 'heartbeat'
// diagnostic event - turns "the race just doesn't work" into visible,
// per-pool log data (connected how long, authorized or not, how many
// notifies seen) instead of total silence, since pool connectivity can't be
// tested from outside the user's own network.
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

// A pool is somebody else's server, and the only thing keeping this buffer
// from growing without limit is that server choosing to send a newline. One
// that never does - broken, or hostile - would otherwise grow it until the
// worker dies of memory exhaustion, and Docker would restart it into the same
// stream again.
//
// 128 KiB is far beyond any real Stratum message. A mining.notify carries a
// coinbase and a merkle branch and lands in the low kilobytes; the largest
// thing seen from the eight pre-configured pools is well under 8 KiB. Anything
// past this is not a message that arrived in pieces, it is a stream with no
// message in it, so the connection goes rather than the line: the reconnect
// path below is already the right answer to a pool that has stopped making
// sense, and it backs off on its own.
const MAX_STRATUM_LINE_BYTES = 128 * 1024;

// Bitcoin block hashes are 32 bytes, and Stratum sends them as hex. Anything
// else in the prevhash slot is not a block this node will ever hear about, and
// letting it through means a stranger's socket can mint rows in stratum_race
// and timers in the worker at whatever rate it likes, one per string it makes
// up. Checked here, at the edge, because everything downstream treats a
// prevhash as an identity.
const PREVHASH_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Minimal, read-mostly Stratum V1 client used purely for timing purposes.
 * It sends `mining.subscribe` and `mining.authorize` (the same first steps
 * any miner takes) and then just listens - it never submits shares. `data`
 * events are timestamped by the caller (see stratum-race.js) at the moment
 * they arrive, before any JSON parsing, so parsing cost never pollutes
 * timing.
 *
 * Emits:
 *   'notify' ({ prevhash, cleanJobs, receivedAtHr }) - a parsed mining.notify
 *   'authorizeResult' ({ ok, error }) - response to our own mining.authorize
 *   'heartbeat' ({ connectedMs, notifyCount, authorized }) - periodic status
 *   'connect' / 'disconnect' (err?)
 */
class StratumPoolConnection extends EventEmitter {
  constructor({ host, port, label, idleTimeoutMs = 6 * 60 * 60 * 1000, authorizeAddress = '1BitcoinEaterAddressDontSendf59kuE' }) {
    super();
    this.host = host;
    this.port = port;
    this.label = label;
    this.socket = null;
    this.buffer = '';
    this.stopped = false;
    this.reconnectDelayMs = 2000;
    // Deliberately generous (6h default) - block gaps well over an hour are
    // rare but expected (exponential distribution, no upper bound), and
    // this is only a backstop; setKeepAlive below is the fast path for
    // detecting an actually-dead socket. See config.js for the full math.
    this.idleTimeoutMs = idleTimeoutMs;
    this.authorizeAddress = authorizeAddress;
    this.notifyCount = 0;
    this.authorized = null; // null = no response yet, true/false = pool's answer
    this._connectedAt = null;
    this._heartbeatTimer = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.socket) this.socket.destroy();
  }

  _connect() {
    if (this.stopped) return;
    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;

    socket.setNoDelay(true);
    // TCP-level keepalive: the real, fast way we notice a connection has
    // actually died (peer gone, NAT/firewall silently dropped the mapping,
    // half-open socket after a network blip) - it works entirely at the OS
    // level and needs no application data, so it isn't fooled by Bitcoin
    // just taking a while between blocks. First probe after 30s idle, then
    // OS-default probe interval/retry count (Linux default: ~9 probes,
    // ~75s apart) - typically well under 15 minutes to detect a truly dead
    // peer, independent of the app-level idleTimeoutMs backstop below.
    socket.setKeepAlive(true, 30_000);
    // NOTE: this used to be a flat 30000ms, which destroyed and reconnected
    // every pool socket roughly every 30 seconds - long before a real block
    // (average ~10 minutes apart) had a chance to arrive. That churn is the
    // most likely reason the race looked like it wasn't working: connections
    // rarely stayed open long enough to ever witness a genuine mining.notify.
    // It is now a generous last-resort backstop (see idleTimeoutMs above),
    // not the primary dead-connection detector - that job belongs to
    // setKeepAlive just above, which doesn't get confused by a genuinely
    // long gap between blocks.
    socket.setTimeout(this.idleTimeoutMs);

    socket.on('connect', () => {
      this.reconnectDelayMs = 2000;
      this.buffer = '';
      this.notifyCount = 0;
      this.authorized = null;
      this._connectedAt = Date.now();
      const subscribe = JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['bitcoin-lab/1.0'] });
      socket.write(`${subscribe}\n`);
      // Many stratum servers - solo-mining ckpool-based ones especially,
      // which is what GoBrrr Pool and most public solo pools run - only
      // broadcast mining.notify to a session that has successfully
      // authorized, AND validate the authorize username as a real Bitcoin
      // address (since solo payouts go straight to whoever finds the
      // block). A bare subscribe, or an authorize with a made-up
      // non-address username, both leave us subscribed but silent forever -
      // this was very likely the actual reason the race produced no data
      // even after the idle-timeout fix kept connections open. We never
      // submit shares, so the address doesn't need to be ours - see
      // config.js stratumAuthorizeAddress for why this specific one.
      const authorize = JSON.stringify({ id: 2, method: 'mining.authorize', params: [`${this.authorizeAddress}.bitcoinlab`, 'x'] });
      socket.write(`${authorize}\n`);
      this.emit('connect');
      this._startHeartbeat();
    });

    // IMPORTANT: the timestamp is captured here, at the raw 'data' event,
    // before any buffering/JSON parsing happens.
    socket.on('data', (chunk) => {
      const receivedAtHr = process.hrtime.bigint();
      // The wall clock at the same instant. hrtime says how far apart two
      // pools' jobs arrived; this says WHEN, on the clock Bitcoin Lab's other
      // processes stamp their own events with - which is what lets a race be
      // laid next to the moment Core announced the block.
      const receivedAtMs = Date.now();
      this._handleChunk(chunk, receivedAtHr, receivedAtMs);
    });

    socket.on('timeout', () => socket.destroy(new Error('idle timeout')));
    socket.on('error', (err) => this.emit('socketError', err));
    socket.on('close', () => {
      this._stopHeartbeat();
      this.emit('disconnect');
      if (!this.stopped) {
        setTimeout(() => this._connect(), this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 1.5, 30000);
      }
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this.emit('heartbeat', {
        connectedMs: Date.now() - this._connectedAt,
        notifyCount: this.notifyCount,
        authorized: this.authorized,
      });
    }, HEARTBEAT_INTERVAL_MS);
    this._heartbeatTimer.unref?.();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _handleChunk(chunk, receivedAtHr, receivedAtMs) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this._handleLine(line, receivedAtHr, receivedAtMs);
    }
    // Checked after the loop, so a legitimate burst of complete lines in one
    // chunk is never the thing that trips it. What is left here is one
    // unterminated line, and only that is measured.
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_STRATUM_LINE_BYTES) {
      this.buffer = '';
      this.emit('protocolError', {
        reason: 'line exceeds maximum size',
        limitBytes: MAX_STRATUM_LINE_BYTES,
      });
      this.socket?.destroy(new Error('stratum line exceeds maximum size'));
    }
  }

  _handleLine(line, receivedAtHr, receivedAtMs) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore malformed/partial lines from misbehaving pools
    }
    if (msg.method === 'mining.notify' && Array.isArray(msg.params) && msg.params.length >= 9) {
      const [, prevhash, , , , , , , cleanJobs] = msg.params;
      if (typeof prevhash !== 'string' || !PREVHASH_RE.test(prevhash)) {
        this.emit('protocolError', { reason: 'mining.notify without a usable prevhash' });
        return;
      }
      this.notifyCount += 1;
      this.emit('notify', {
        prevhash,
        cleanJobs: Boolean(cleanJobs),
        receivedAtHr,
        receivedAtMs,
        // The first job of a connection is the one the pool is already working
        // on - sent because somebody just subscribed, not because anything
        // happened. Its arrival is timed from our own handshake, so it cannot
        // be raced; stratum-race.js has the full argument. notifyCount is
        // reset on every 'connect', so this is per connection, not per process.
        firstAfterConnect: this.notifyCount === 1,
      });
      return;
    }
    if (msg.id === 2) {
      // Response to our own mining.authorize call - purely informational.
      // Some pools don't require it at all and notify regardless; a
      // rejection here is only useful for debugging, never fatal.
      this.authorized = Boolean(msg.result);
      this.emit('authorizeResult', { ok: this.authorized, error: msg.error || null });
    }
  }
}

module.exports = { StratumPoolConnection };
