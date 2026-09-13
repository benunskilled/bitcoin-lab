'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkConfig, assertConfig, RULES, ENV_NAMES } = require('../src/lib/validate-config');

// A config that passes, to vary one field at a time against.
function good(overrides = {}) {
  return {
    dashboardPort: 8788,
    maxManualPeers: 8,
    minEligibleForJudgement: 50,
    newManualGraceBlocks: 50,
    minSwapMarginPct: 0.2,
    recentScoreWindowBlocks: 500,
    offlineGraceMinHours: 1,
    offlineGraceMaxHours: 24,
    offlineGraceHoursPerPct: 1,
    parkedPeerProbesPerTick: 3,
    parkedPeerMinProbeIntervalMinutes: 30,
    parkedPeerMaxProbeIntervalHours: 12,
    parkedPeerSlowProbeIntervalHours: 48,
    parkedPeerFullSpeedPct: 20,
    parkedPeerRetentionDaysPerPct: 5,
    parkedPeerMinRetentionDays: 2,
    parkedPeerMaxRetentionDays: 180,
    stratumRaceTimeoutMs: 8000,
    stratumIdleTimeoutMs: 6 * 60 * 60 * 1000,
    stratumHistoryRetentionDays: 365,
    feelerPeerRetentionDays: 14,
    peerPollIntervalMs: 15000,
    rotationLogEntries: 30,
    ...overrides,
  };
}

test('the shipped defaults pass', () => {
  // Not the object built above but the real one, so a default that drifts out
  // of its own rule is caught here rather than on somebody's node.
  const config = require('../src/lib/config');
  assert.deepEqual(checkConfig(config), []);
});

test('every rule has an environment variable name to report', () => {
  for (const key of Object.keys(RULES)) {
    assert.ok(ENV_NAMES[key], `${key} has no env name, so its message would be unreadable`);
  }
});

test('a typo becomes a refusal, not NaN', () => {
  // Number('banana') is NaN, which compares false against everything and makes
  // setInterval fire as fast as the loop allows. Nothing throws on its own.
  const problems = checkConfig(good({ peerPollIntervalMs: Number('banana') }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /PEER_POLL_INTERVAL_MS is not a number/);
});

test('a window of zero is refused', () => {
  const problems = checkConfig(good({ recentScoreWindowBlocks: 0 }));
  assert.ok(problems.some((p) => p.startsWith('RECENT_SCORE_WINDOW_BLOCKS must be between 1')));
});

test('a poll interval fast enough to hammer Core is refused', () => {
  const problems = checkConfig(good({ peerPollIntervalMs: 0 }));
  assert.ok(problems.some((p) => /PEER_POLL_INTERVAL_MS must be between 1000/.test(p)));
});

test('more manual peers than Core will hold is refused', () => {
  const problems = checkConfig(good({ maxManualPeers: 20 }));
  assert.ok(problems.some((p) => p.includes("MAX_ADDNODE_CONNECTIONS is 8")));
});

test('counts must be whole numbers, rates need not be', () => {
  assert.ok(checkConfig(good({ recentScoreWindowBlocks: 500.5 })).some((p) => /whole number/.test(p)));
  assert.deepEqual(checkConfig(good({ minSwapMarginPct: 0.25 })), [], 'a fractional margin is the point of it');
});

test('values that are each fine but wrong together are caught', () => {
  assert.ok(
    checkConfig(good({ offlineGraceMinHours: 48, offlineGraceMaxHours: 24 }))
      .some((p) => /OFFLINE_GRACE_MIN_HOURS must not exceed/.test(p)),
  );
  assert.ok(
    checkConfig(good({ parkedPeerMinRetentionDays: 200, parkedPeerMaxRetentionDays: 180 }))
      .some((p) => /PARKED_PEER_MIN_RETENTION_DAYS must not exceed/.test(p)),
  );
  assert.ok(
    checkConfig(good({ parkedPeerMaxProbeIntervalHours: 72 }))
      .some((p) => /PARKED_PEER_MAX_PROBE_INTERVAL_HOURS/.test(p)),
  );
  assert.ok(
    checkConfig(good({ recentScoreWindowBlocks: 10 }))
      .some((p) => /no peer could ever fill the window/.test(p)),
  );
});

test('every problem is reported, not just the first', () => {
  const problems = checkConfig(good({ dashboardPort: 0, rotationLogEntries: 0, stratumRaceTimeoutMs: 0 }));
  assert.equal(problems.length, 3, 'somebody fixing a compose file should not go round the loop three times');
});

test('assertConfig exits, and says which variable', () => {
  const lines = [];
  let code = null;
  assertConfig(good({ dashboardPort: 99999 }), {
    exit: (c) => { code = c; },
    log: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.ok(lines.join('\n').includes('DASHBOARD_PORT'));

  lines.length = 0;
  code = null;
  assertConfig(good(), { exit: (c) => { code = c; }, log: (line) => lines.push(line) });
  assert.equal(code, null, 'a usable config is not interrupted');
  assert.equal(lines.length, 0, 'and says nothing');
});
