'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const config = require('./config');
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

function make(scope) {
  const line = (level, msg, extra) => {
    if (LEVELS[level] > currentLevel) return;
    const ts = new Date().toISOString();
    const suffix = extra !== undefined ? ` ${JSON.stringify(extra)}` : '';
    // Plain stdout/stderr - Docker/Umbrel capture this, no file logging.
    const stream = level === 'error' ? console.error : console.log;
    stream(`${ts} [${level.toUpperCase()}] [${scope}] ${msg}${suffix}`);
  };
  return {
    error: (msg, extra) => line('error', msg, extra),
    warn: (msg, extra) => line('warn', msg, extra),
    info: (msg, extra) => line('info', msg, extra),
    debug: (msg, extra) => line('debug', msg, extra),
  };
}

module.exports = { make };
