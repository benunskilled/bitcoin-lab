'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const { isValidPort, isValidHost, validatePool } = require('../src/lib/validate');

test('accepts ports Node can actually connect to', () => {
  for (const port of [1, 80, 3333, 8333, 42069, 65535]) {
    assert.equal(isValidPort(port), true, `${port} should be valid`);
    assert.equal(isValidPort(String(port)), true, `"${port}" should be valid`);
  }
});

test('rejects every port value that makes net.connect throw synchronously', () => {
  // The reason this validator exists: net.connect() throws ERR_SOCKET_BAD_PORT
  // synchronously, and it is called from a timer in stratum-race.js - so a
  // stored bad port used to kill that process on every tick forever. Assert
  // against Node's real behaviour rather than a remembered rule.
  for (const port of [-1, 0, 65536, 99999, 333333, 1.5, NaN, null, undefined, 'abc', '']) {
    let throws = false;
    try {
      net.connect({ host: '127.0.0.1', port }).on('error', () => {}).destroy();
    } catch {
      throws = true;
    }
    if (throws) assert.equal(isValidPort(port), false, `${port} makes net.connect throw and must be rejected`);
  }
  // Independently: none of these may be accepted, whether or not Node throws.
  for (const port of [-1, 0, 65536, 99999, 333333, 1.5, NaN, null, undefined, 'abc', '']) {
    assert.equal(isValidPort(port), false, `${port} must be rejected`);
  }
});

test('accepts hostnames and IP literals, rejects URLs and junk', () => {
  for (const host of ['solo.ckpool.org', 'pool.solomining.de', '10.21.0.1', '[2001:db8::1]', 'parasite.wtf']) {
    assert.equal(isValidHost(host), true, `${host} should be valid`);
  }
  for (const host of ['', '   ', 'http://a.b', 'a b', 'a/b', 'user@host', 'a?b', 'x'.repeat(256), 42, null]) {
    assert.equal(isValidHost(host), false, `${JSON.stringify(host)} should be rejected`);
  }
});

test('validatePool reports the specific problem and normalises the value', () => {
  assert.deepEqual(validatePool({ label: '  EU CKPool  ', host: ' solo.ckpool.org ', port: '3333' }), {
    ok: true,
    value: { label: 'EU CKPool', host: 'solo.ckpool.org', port: 3333 },
  });
  assert.match(validatePool({ label: '', host: 'a.b', port: 1 }).error, /label/);
  assert.match(validatePool({ label: 'x'.repeat(65), host: 'a.b', port: 1 }).error, /64/);
  assert.match(validatePool({ label: 'X', host: 'no spaces', port: 1 }).error, /host/);
  assert.match(validatePool({ label: 'X', host: 'a.b', port: 333333 }).error, /65535/);
});
