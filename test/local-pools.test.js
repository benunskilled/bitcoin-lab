'use strict';

const test = require('node:test');
const assert = require('node:assert');
const localPools = require('../src/lib/local-pools');

test('only pool apps whose container name resolves count as installed', async () => {
  localPools._setLookup(async (host) => {
    if (host === 'datum_datum_1' || host === 'bassin_ckpool_1') return { address: '10.21.0.9', family: 4 };
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  });
  const list = await localPools.list([]);
  assert.deepStrictEqual(list.filter((p) => p.installed).map((p) => p.key), ['bassin', 'datum']);
  assert.strictEqual(list.length, localPools.LOCAL_POOLS.length, 'every template is listed, installed or not');
});

test('a pool already among the user\'s pools is marked as added', async () => {
  localPools._setLookup(async () => ({ address: '10.21.0.9', family: 4 }));
  const list = await localPools.list([{ host: 'DATUM_datum_1', port: 23334 }, { host: 'bassin_ckpool_1', port: 4444 }]);
  const byKey = Object.fromEntries(list.map((p) => [p.key, p]));
  assert.strictEqual(byKey.datum.added, true, 'same host (any case) and port');
  assert.strictEqual(byKey.bassin.added, false, 'other port is another pool');
});

test('a lookup that hangs counts as not installed instead of blocking', async () => {
  localPools._setLookup(() => new Promise(() => {}));
  const t0 = Date.now();
  const keys = await localPools.installed();
  assert.strictEqual(keys.size, 0);
  assert.ok(Date.now() - t0 < 5000);
});

test('the answer is cached between polls', async () => {
  let calls = 0;
  localPools._setLookup(async () => { calls += 1; return { address: '10.21.0.9', family: 4 }; });
  await localPools.installed();
  await localPools.installed();
  assert.strictEqual(calls, localPools.LOCAL_POOLS.length);
});
