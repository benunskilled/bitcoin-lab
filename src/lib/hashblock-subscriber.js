'use strict';

const zmq = require('zeromq');

/**
 * Shared Bitcoin Core `pubhashblock` subscriber.
 *
 * Both the relay profiler (which records the race) and the dashboard (which
 * pushes a live block event to the browser) need to know the instant a block
 * arrives. ZMQ publish/subscribe fans out to every subscriber independently,
 * so a second subscriber costs Core nothing and, importantly, cannot delay or
 * perturb the first one's measurement - they are separate processes holding
 * separate sockets.
 *
 * The high-resolution timestamp is still captured as the very first statement
 * after the message arrives, before decoding, so nothing downstream can
 * pollute the measurement.
 */
function start({ url, logger, onBlock, reconnectDelayMs = 5000 }) {
  let stopped = false;
  let socket = null;
  const state = { connected: false, lastBlockAtMs: null };

  (async () => {
    while (!stopped) {
      const sock = new zmq.Subscriber();
      socket = sock;
      try {
        sock.connect(url);
        sock.subscribe('hashblock');
        state.connected = true;
        logger.info('subscribed to hashblock', { url });

        for await (const [, msg] of sock) {
          // Capture the timestamp FIRST, before any parsing or async work.
          const t0 = process.hrtime.bigint();
          const detectedAtMs = Date.now();
          // pubhashblock payload is the 32-byte block hash in internal
          // (little-endian) byte order; reverse for the conventional
          // display/RPC hex string.
          const blockHash = Buffer.from(msg).reverse().toString('hex');
          state.lastBlockAtMs = detectedAtMs;
          try {
            onBlock({ blockHash, detectedAtMs, t0 });
          } catch (err) {
            logger.error('block handler threw', { blockHash, error: err.stack || err.message });
          }
        }
        // Falling out of the loop without an error means the stream ended
        // cleanly. Before v1.12.0 that path skipped the delay below (it only
        // existed in the catch) and never closed the socket, so it span at
        // full CPU while leaking a file descriptor per iteration.
        if (!stopped) logger.warn('hashblock stream ended, reconnecting', { url });
      } catch (err) {
        if (!stopped) logger.error('zmq subscriber error, reconnecting', { url, error: err.message });
      } finally {
        state.connected = false;
        try { sock.close(); } catch { /* already closed */ }
      }
      if (stopped) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
    }
  })();

  return {
    state,
    stop() {
      stopped = true;
      try { if (socket) socket.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = { start };
