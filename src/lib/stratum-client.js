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
  constructor({ host, port, label }) {
    super();
    this.host = host;
    this.port = port;
    this.label = label;
    this.socket = null;
    this.buffer = '';
    this.stopped = false;
    this.reconnectDelayMs = 2000;
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
    socket.setTimeout(30000);

    socket.on('connect', () => {
      this.reconnectDelayMs = 2000;
      this.buffer = '';
      const subscribe = JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['bitcoin-lab/1.0'] });
      socket.write(`${subscribe}\n`);
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
    }
  }
}

module.exports = { StratumPoolConnection };
