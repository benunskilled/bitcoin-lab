'use strict';

const net = require('net');
const { EventEmitter } = require('events');

/**
 * Minimal, read-mostly Stratum V1 client used purely for timing purposes.
 * It sends `mining.subscribe` (the same first step any miner takes) and
 * then just listens - it never submits shares. `data` events are
 * timestamped by the caller (see stratum-race.js) at the moment they
 * arrive, before any JSON parsing, so parsing cost never pollutes timing.
 *
 * Emits:
 *   'notify' ({ prevhash, cleanJobs, receivedAtHr }) - a parsed mining.notify
 *   'connect' / 'disconnect' (err?)
 */
class StratumPoolConnection extends EventEmitter {
  constructor({ host, port, label, idleTimeoutMs = 20 * 60 * 1000 }) {
    super();
    this.host = host;
    this.port = port;
    this.label = label;
    this.socket = null;
    this.buffer = '';
    this.stopped = false;
    this.reconnectDelayMs = 2000;
    // Deliberately generous (2h default) - block gaps well over an hour are
    // rare but expected (exponential distribution, no upper bound), and
    // this is only a backstop; setKeepAlive below is the fast path for
    // detecting an actually-dead socket. See config.js for the full math.
    this.idleTimeoutMs = idleTimeoutMs;
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
      const subscribe = JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['bitcoin-lab/1.0'] });
      socket.write(`${subscribe}\n`);
      // Many stratum servers only broadcast mining.notify to sessions that
      // have authorized a worker - a bare subscribe is not enough for them,
      // and this was very likely the actual reason the race produced no
      // data even after the idle-timeout fix kept connections open: the
      // notify we were waiting for was simply never sent to us. We never
      // submit shares, so the worker/password don't need to be real - this
      // is the same "authorize with a throwaway worker" approach read-only
      // job-spy/timing tools (like the well-known Atlas stratum race) use.
      const authorize = JSON.stringify({ id: 2, method: 'mining.authorize', params: ['bitcoinlab.observer', 'x'] });
      socket.write(`${authorize}\n`);
      this.emit('connect');
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
      this.emit('disconnect');
      if (!this.stopped) {
        setTimeout(() => this._connect(), this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 1.5, 30000);
      }
    });
  }

  _handleChunk(chunk, receivedAtHr) {
    this.buffer += chunk.toString('utf8');
    let idx;
    // eslint-disable-next-line no-cond-assign
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
      this.emit('notify', { prevhash, cleanJobs: Boolean(cleanJobs), receivedAtHr });
      return;
    }
    if (msg.id === 2) {
      // Response to our own mining.authorize call - purely informational.
      // Some pools don't require it at all and notify regardless; a
      // rejection here is only useful for debugging, never fatal.
      this.emit('authorizeResult', { ok: Boolean(msg.result), error: msg.error || null });
    }
  }
}

module.exports = { StratumPoolConnection };
