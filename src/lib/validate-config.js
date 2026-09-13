'use strict';

/**
 * Checks the numbers in config.js once, at load, and refuses to start on a
 * setting that cannot mean anything.
 *
 * Every value there arrives as `Number(process.env.X)`, which turns a typo
 * into `NaN` rather than into an error. `NaN` does not throw anywhere: it
 * makes `setInterval` fire as fast as the event loop allows, makes every
 * comparison in the rotation false, and makes a division produce another
 * `NaN` that is stored as NULL. The app keeps running and quietly does
 * nothing correct, which is the worst of the available failure modes - worse
 * than a crash, because a crash is visible in the app's logs on the first
 * restart.
 *
 * Ranges, not just types. `RECENT_SCORE_WINDOW_BLOCKS=0` is a number and a
 * meaningless one: the score divides by the window, and a peer's ranking would
 * come out as a division by zero dressed up as a percentage. Same for a poll
 * interval of 0, which is a busy loop against Core's RPC.
 *
 * The upper bounds are deliberately loose. They are there to catch a wrong
 * unit - milliseconds typed where hours were meant - not to have an opinion
 * about how somebody runs their node.
 */

// [min, max], both inclusive. `integer: false` for the two that are genuinely
// fractional; everything else counts something and must be whole.
const RULES = {
  dashboardPort: { min: 1, max: 65535 },
  maxManualPeers: { min: 1, max: 8, note: "Bitcoin Core's own MAX_ADDNODE_CONNECTIONS is 8" },
  minEligibleForJudgement: { min: 1, max: 100000 },
  newManualGraceBlocks: { min: 0, max: 100000 },
  minSwapMarginPct: { min: 0, max: 100, integer: false },
  recentScoreWindowBlocks: { min: 1, max: 1000000 },
  offlineGraceMinHours: { min: 0, max: 8760, integer: false },
  offlineGraceMaxHours: { min: 0, max: 8760, integer: false },
  offlineGraceHoursPerPct: { min: 0, max: 8760, integer: false },
  parkedPeerProbesPerTick: { min: 0, max: 1000 },
  parkedPeerMinProbeIntervalMinutes: { min: 0, max: 525600, integer: false },
  parkedPeerMaxProbeIntervalHours: { min: 0, max: 8760, integer: false },
  parkedPeerSlowProbeIntervalHours: { min: 0, max: 8760, integer: false },
  parkedPeerFullSpeedPct: { min: 0, max: 100, integer: false },
  parkedPeerRetentionDaysPerPct: { min: 0, max: 36500, integer: false },
  parkedPeerMinRetentionDays: { min: 0, max: 36500, integer: false },
  parkedPeerMaxRetentionDays: { min: 0, max: 36500, integer: false },
  stratumRaceTimeoutMs: { min: 100, max: 600000 },
  stratumIdleTimeoutMs: { min: 1000, max: 7 * 24 * 60 * 60 * 1000 },
  stratumHistoryRetentionDays: { min: 1, max: 36500 },
  feelerPeerRetentionDays: { min: 1, max: 36500 },
  peerPollIntervalMs: { min: 1000, max: 3600000, note: 'below a second this is a busy loop against Core' },
  rotationLogEntries: { min: 1, max: 100000 },
};

// The env var a given config key came from, so the message names what the
// operator actually typed rather than an internal property name.
const ENV_NAMES = {
  dashboardPort: 'DASHBOARD_PORT',
  maxManualPeers: 'MAX_MANUAL_PEERS',
  minEligibleForJudgement: 'MIN_ELIGIBLE_FOR_JUDGEMENT',
  newManualGraceBlocks: 'NEW_MANUAL_PEER_GRACE_BLOCKS',
  minSwapMarginPct: 'MIN_SWAP_MARGIN_PCT',
  recentScoreWindowBlocks: 'RECENT_SCORE_WINDOW_BLOCKS',
  offlineGraceMinHours: 'OFFLINE_GRACE_MIN_HOURS',
  offlineGraceMaxHours: 'OFFLINE_GRACE_MAX_HOURS',
  offlineGraceHoursPerPct: 'OFFLINE_GRACE_HOURS_PER_PCT',
  parkedPeerProbesPerTick: 'PARKED_PEER_PROBES_PER_TICK',
  parkedPeerMinProbeIntervalMinutes: 'PARKED_PEER_MIN_PROBE_INTERVAL_MINUTES',
  parkedPeerMaxProbeIntervalHours: 'PARKED_PEER_MAX_PROBE_INTERVAL_HOURS',
  parkedPeerSlowProbeIntervalHours: 'PARKED_PEER_SLOW_PROBE_INTERVAL_HOURS',
  parkedPeerFullSpeedPct: 'PARKED_PEER_FULL_SPEED_PCT',
  parkedPeerRetentionDaysPerPct: 'PARKED_PEER_RETENTION_DAYS_PER_PCT',
  parkedPeerMinRetentionDays: 'PARKED_PEER_MIN_RETENTION_DAYS',
  parkedPeerMaxRetentionDays: 'PARKED_PEER_MAX_RETENTION_DAYS',
  stratumRaceTimeoutMs: 'STRATUM_RACE_TIMEOUT_MS',
  stratumIdleTimeoutMs: 'STRATUM_IDLE_TIMEOUT_MS',
  stratumHistoryRetentionDays: 'STRATUM_HISTORY_RETENTION_DAYS',
  feelerPeerRetentionDays: 'FEELER_PEER_RETENTION_DAYS',
  peerPollIntervalMs: 'PEER_POLL_INTERVAL_MS',
  rotationLogEntries: 'ROTATION_LOG_ENTRIES',
};

/**
 * Returns the list of problems, newest-first is meaningless here so simply in
 * declaration order. An empty array means the config is usable.
 *
 * Deliberately returns rather than throws, so the test suite can read the
 * messages and assertConfig below decides what to do about them.
 */
function checkConfig(config) {
  const problems = [];

  for (const [key, rule] of Object.entries(RULES)) {
    const value = config[key];
    const name = ENV_NAMES[key];
    const where = rule.note ? ` (${rule.note})` : '';

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${name} is not a number: ${JSON.stringify(process.env[name] ?? value)}`);
      continue;
    }
    if (rule.integer !== false && !Number.isInteger(value)) {
      problems.push(`${name} must be a whole number, got ${value}`);
      continue;
    }
    if (value < rule.min || value > rule.max) {
      problems.push(`${name} must be between ${rule.min} and ${rule.max}${where}, got ${value}`);
    }
  }

  // Pairs, where each value is fine on its own and the combination is not.
  if (Number.isFinite(config.offlineGraceMinHours) && Number.isFinite(config.offlineGraceMaxHours)
      && config.offlineGraceMinHours > config.offlineGraceMaxHours) {
    problems.push('OFFLINE_GRACE_MIN_HOURS must not exceed OFFLINE_GRACE_MAX_HOURS');
  }
  if (Number.isFinite(config.parkedPeerMinRetentionDays) && Number.isFinite(config.parkedPeerMaxRetentionDays)
      && config.parkedPeerMinRetentionDays > config.parkedPeerMaxRetentionDays) {
    problems.push('PARKED_PEER_MIN_RETENTION_DAYS must not exceed PARKED_PEER_MAX_RETENTION_DAYS');
  }
  if (Number.isFinite(config.parkedPeerMaxProbeIntervalHours) && Number.isFinite(config.parkedPeerSlowProbeIntervalHours)
      && config.parkedPeerMaxProbeIntervalHours > config.parkedPeerSlowProbeIntervalHours) {
    problems.push(
      'PARKED_PEER_MAX_PROBE_INTERVAL_HOURS is the ceiling for a good peer and must not exceed '
      + 'PARKED_PEER_SLOW_PROBE_INTERVAL_HOURS, the ceiling for a poor one',
    );
  }
  if (Number.isFinite(config.recentScoreWindowBlocks) && Number.isFinite(config.minEligibleForJudgement)
      && config.recentScoreWindowBlocks < config.minEligibleForJudgement) {
    problems.push(
      'RECENT_SCORE_WINDOW_BLOCKS must not be smaller than MIN_ELIGIBLE_FOR_JUDGEMENT - '
      + 'no peer could ever fill the window enough to be judged',
    );
  }

  return problems;
}

/**
 * Called once from config.js. Prints every problem rather than only the first,
 * so somebody fixing a compose file is not sent round the loop once per typo,
 * and exits non-zero: Docker restarts the container, the same message appears
 * again, and it is visible in the app's logs instead of being invisible in its
 * behaviour.
 */
function assertConfig(config, { exit = (code) => process.exit(code), log = console.error } = {}) {
  const problems = checkConfig(config);
  if (problems.length === 0) return;
  log('Bitcoin Lab cannot start - the configuration is not usable:');
  for (const problem of problems) log(`  - ${problem}`);
  log('See docs/configuration.md for what each setting means.');
  exit(1);
}

module.exports = { checkConfig, assertConfig, RULES, ENV_NAMES };
