'use strict';

const net = require('net');
const { EventEmitter } = require('events');

// How often a still-connected pool with no notify data emits a 'heartbeat'
// diagnostic event - turns "the race just doesn't work" into visible,
// per-pool log data (connected how long, authorized or not, how many
// notifies seen) instead of total silence, since pool connectivity can't be
// tested from outside the user's own network.
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

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
      this._handleChunk(chunk, receivedAtHr);
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

  _handleChunk(chunk, receivedAtHr) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this._handleLine(line, receivedAtHr);
    }
  }

  _handleLine(line, receivedAtHr) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore malformed/partial lines from misbehaving pools
    }
    if (msg.method === 'mining.notify' && Array.isArray(msg.params) && msg.params.length >= 9) {
      const [, prevhash, , , , , , , cleanJobs] = msg.params;
      this.notifyCount += 1;
      this.emit('notify', { prevhash, cleanJobs: Boolean(cleanJobs), receivedAtHr });
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
