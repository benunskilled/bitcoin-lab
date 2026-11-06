'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWriteSource, readGateway } = require('../src/lib/write-source');

// A stand-in for Docker's DNS: answers from a table, counts the questions.
function fakeDns(table) {
  const fn = async (host) => {
    fn.calls += 1;
    if (!(host in table)) throw new Error('ENOTFOUND');
    return table[host].map((address) => ({ address, family: 4 }));
  };
  fn.calls = 0;
  return fn;
}

test('only the app proxy and the container itself may write', async () => {
  const allowed = makeWriteSource({ gateway: null, host: 'bitcoinlab-node_app_proxy_1', lookup: fakeDns({ 'bitcoinlab-node_app_proxy_1': ['10.21.0.5'] }) });
  assert.equal(await allowed('10.21.0.5'), true);
  assert.equal(await allowed('::ffff:10.21.0.5'), true);
  assert.equal(await allowed('127.0.0.1'), true);
  assert.equal(await allowed('::1'), true);
  // Another app on the same Docker network.
  assert.equal(await allowed('10.21.0.9'), false);
});

test('without a proxy name any source may write, as in tests and local runs', async () => {
  const allowed = makeWriteSource({ gateway: null, host: '', lookup: fakeDns({}) });
  assert.equal(await allowed('10.21.0.9'), true);
});

test('a name that does not resolve refuses writes rather than letting them through', async () => {
  const allowed = makeWriteSource({ gateway: null, host: 'bitcoinlab-node_app_proxy_1', lookup: fakeDns({}) });
  assert.equal(await allowed('10.21.0.5'), false);
  assert.equal(await allowed('127.0.0.1'), true);
});

test('a recreated proxy with a new address is found again', async () => {
  let t = 0;
  const table = { proxy: ['10.21.0.5'] };
  const lookup = fakeDns(table);
  const allowed = makeWriteSource({ gateway: null, host: 'proxy', lookup, now: () => t });
  assert.equal(await allowed('10.21.0.5'), true);
  table.proxy = ['10.21.0.7'];
  // Within the retry pause the old answer stands.
  t = 1000;
  assert.equal(await allowed('10.21.0.7'), false);
  // After it, a write from an unknown address asks once more.
  t = 3000;
  assert.equal(await allowed('10.21.0.7'), true);
  assert.equal(await allowed('10.21.0.5'), false);
});

test('known addresses are not looked up on every write', async () => {
  let t = 0;
  const lookup = fakeDns({ proxy: ['10.21.0.5'] });
  const allowed = makeWriteSource({ gateway: null, host: 'proxy', lookup, now: () => t });
  for (let i = 0; i < 5; i++) {
    t += 1000;
    await allowed('10.21.0.5');
  }
  assert.equal(lookup.calls, 1);
});

// umbrelOS 2.x: the proxy runs inside umbreld and connects from the network's
// gateway (measured on 2.0.1: 10.21.0.1). Another app's container has its own address.
test('on umbrelOS 2.x the gateway may write and other containers may not', async () => {
  const allowed = makeWriteSource({ gateway: '10.21.0.1', host: 'bitcoinlab-node_app_proxy_1', lookup: fakeDns({}) });
  assert.equal(await allowed('10.21.0.1'), true);
  assert.equal(await allowed('::ffff:10.21.0.1'), true);
  assert.equal(await allowed('10.21.0.37'), false);
  assert.equal(await allowed('127.0.0.1'), true);
});

test('without a proxy name the gateway alone may write', async () => {
  const allowed = makeWriteSource({ gateway: '10.21.0.1', host: '', lookup: fakeDns({}) });
  assert.equal(await allowed('10.21.0.1'), true);
  assert.equal(await allowed('10.21.0.37'), false);
});

test('an unknown proxy name is not asked about on every write', async () => {
  let t = 0;
  const lookup = fakeDns({});
  const allowed = makeWriteSource({ gateway: '10.21.0.1', host: 'gone', lookup, now: () => t });
  for (let i = 0; i < 5; i++) { t += 500; await allowed('10.21.0.37'); }
  assert.ok(lookup.calls <= 2, `looked up ${lookup.calls} times`);
});

test('the gateway is read from the default route', () => {
  const route = 'Iface\tDestination\tGateway \tFlags\n' +
    'eth0\t00000000\t010015AC\t0003\n' +
    'eth0\t000015AC\t00000000\t0001\n';
  assert.equal(readGateway(() => route), '172.21.0.1');
  assert.equal(readGateway(() => 'Iface\tDestination\tGateway\n'), null);
  assert.equal(readGateway(() => { throw new Error('ENOENT'); }), null);
});
