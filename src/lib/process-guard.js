'use strict';

/**
 * One shared safety net for all four long-running processes.
 *
 * Two problems this solves:
 *
 * 1. An unhandled promise rejection terminates the process on Node >= 15 -
 *    silently, with no log line of our own. The relay profiler was the worst
 *    place for that: it calls handleHashBlock() fire-and-forget from the ZMQ
 *    loop, so any throw inside it (a SQLite write failing past busy_timeout,
 *    a full disk) took the whole process down with nothing in `docker logs`
 *    explaining why. Now every exit of that kind names its cause first.
 *
 * 2. Only stratum-race.js handled SIGTERM, so the other three were SIGKILLed
 *    ten seconds into every `docker stop` / app update. WAL made that safe
 *    rather than corrupting, but it also meant no process ever got to close
 *    its database handle or its sockets deliberately.
 *
 * Handlers still exit non-zero on a genuine fault so Docker's restart policy
 * takes over - the goal is a diagnosable restart, not a suppressed one.
 */

function install(logger, { onShutdown } = {}) {
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandled promise rejection - exiting so the restart policy can recover', {
      error: err.stack || err.message,
    });
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception - exiting so the restart policy can recover', {
      error: err.stack || err.message,
    });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      if (onShutdown) onShutdown();
    } catch (err) {
      logger.warn('error during shutdown', { error: err.message });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { install };
