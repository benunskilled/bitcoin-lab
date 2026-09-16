'use strict';

/**
 * The one test that checks this app against Bitcoin Core rather than against
 * its own mocks.
 *
 * Everything else in test/ proves that the code does what it was written to
 * do. None of it can prove the thing the whole app rests on: that Core reports
 * what this app assumes it reports. getpeerinfo's last_block, connection_type
 * and addr; addnode and getaddednodeinfo; a pubhashblock message carrying a
 * display-order hash. Those are somebody else's promises, they change between
 * major versions, and a mock agrees with whatever it was taught.
 *
 * So this runs two real regtest nodes. Node A mines; node B is the one this
 * app watches. B learns about the block the only way a real node ever does -
 * from a peer, over P2P - and the test then asks whether the app credits A
 * with it. That is the core claim of the product, and until now nothing tested
 * it at all.
 *
 * Needs bitcoind on PATH. Skipped, loudly but without failing, when there is
 * none, so `npm test` on a laptop stays green; CI installs one and means it.
 *
 *   node test/integration/regtest.js
 *   BITCOIND=/path/to/bitcoind node test/integration/regtest.js
 */

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BITCOIND = process.env.BITCOIND || 'bitcoind';
const BITCOIN_CLI = process.env.BITCOIN_CLI || 'bitcoin-cli';
const RPC_USER = 'bitcoinlab';
const RPC_PASS = 'regtest-only-not-a-secret';

// Two nodes, fixed ports. High enough to stay clear of anything a developer is
// likely to be running, and regtest's own defaults are deliberately avoided so
// this cannot talk to a node somebody left open.
const NODES = {
  miner: { p2p: 19555, rpc: 19556, zmq: null },
  watched: { p2p: 19565, rpc: 19566, zmq: 19567 },
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcoinlab-regtest-'));
const started = [];
let failures = 0;
let passes = 0;

function log(...args) {
  console.log(...args);
}

function cliArgs(node) {
  return [
    '-regtest',
    `-rpcport=${node.rpc}`,
    `-rpcuser=${RPC_USER}`,
    `-rpcpassword=${RPC_PASS}`,
    `-datadir=${node.dir}`,
  ];
}

function cli(node, ...args) {
  const res = spawnSync(BITCOIN_CLI, [...cliArgs(node), ...args], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`bitcoin-cli ${args.join(' ')} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  const out = res.stdout.trim();
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function startNode(name, node) {
  node.dir = path.join(tmpRoot, name);
  fs.mkdirSync(node.dir, { recursive: true });
  const args = [
    '-regtest',
    '-server=1',
    '-listen=1',
    `-datadir=${node.dir}`,
    `-port=${node.p2p}`,
    `-rpcport=${node.rpc}`,
    `-rpcuser=${RPC_USER}`,
    `-rpcpassword=${RPC_PASS}`,
    '-rpcbind=127.0.0.1',
    '-rpcallowip=127.0.0.1',
    '-bind=127.0.0.1',
    '-fallbackfee=0.0002',
    // Nothing here should ever reach a real network, and a regtest node with
    // dns seeding on is a regtest node trying to.
    '-dnsseed=0',
    // Deliberately no -upnp: Core removed the option, and a flag that no longer
    // exists is a node that refuses to start. Nothing needs it - UPnP is off by
    // default, and -bind=127.0.0.1 above is what actually keeps this local.
  ];
  if (node.zmq) args.push(`-zmqpubhashblock=tcp://127.0.0.1:${node.zmq}`);

  const proc = spawn(BITCOIND, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { name, node, proc, stderr: '', exited: null };
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => {
    record.stderr += d;
    process.stderr.write(`[${name}] ${d}`);
  });
  // A node that refuses to start says why in one line and then exits. Without
  // this the harness waits out its whole timeout and then reports that nothing
  // answered on a port - true, useless, and thirty seconds late. The first CI
  // run of this file died exactly that way, on a flag Core had removed.
  proc.on('exit', (code) => { record.exited = code; });
  started.push(record);
  return proc;
}

// Throws if any node has given up, carrying what it said about it.
function assertNodesAlive() {
  for (const r of started) {
    if (r.exited === null) continue;
    const why = r.stderr.trim().split('\n').filter(Boolean).pop() || `exit code ${r.exited}`;
    throw new Error(`the ${r.name} node exited instead of starting: ${why}`);
  }
}

async function waitFor(what, fn, { timeoutMs = 30000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    assertNodesAlive();
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`
        + (last ? ` (last error: ${last.message})` : ''));
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function check(name, fn) {
  try {
    await fn();
    passes += 1;
    log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    log(`  FAIL ${name}`);
    log(`       ${err.message}`);
  }
}

function shutDown() {
  for (const { proc } of started) {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function main() {
  const probe = spawnSync(BITCOIND, ['-version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    log('');
    log('SKIPPED: no bitcoind on PATH.');
    log('This is the only test that checks the app against real Bitcoin Core rather');
    log('than against its own mocks. Install Core, or set BITCOIND, and run it.');
    log('');
    return 0;
  }
  log(`bitcoind: ${probe.stdout.split('\n')[0]}`);

  // ---- two nodes, connected ---------------------------------------------
  startNode('miner', NODES.miner);
  startNode('watched', NODES.watched);

  await waitFor('both nodes to answer RPC', () => {
    cli(NODES.miner, 'getblockchaininfo');
    cli(NODES.watched, 'getblockchaininfo');
    return true;
  });

  cli(NODES.watched, 'addnode', `127.0.0.1:${NODES.miner.p2p}`, 'add');
  const peer = await waitFor('the watched node to have a peer', () => {
    const peers = cli(NODES.watched, 'getpeerinfo');
    return peers.length > 0 ? peers[0] : null;
  });

  // ---- the app, pointed at the watched node ------------------------------
  const dataDir = path.join(tmpRoot, 'app');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.SQLITE_PATH = path.join(dataDir, 'bitcoinlab.db');
  process.env.DATA_DIR = dataDir;
  process.env.LOG_LEVEL = 'error';
  process.env.BITCOIN_RPC_HOST = '127.0.0.1';
  process.env.BITCOIN_RPC_PORT = String(NODES.watched.rpc);
  process.env.BITCOIN_RPC_USER = RPC_USER;
  process.env.BITCOIN_RPC_PASS = RPC_PASS;
  process.env.BITCOIN_ZMQ_HOST = '127.0.0.1';
  process.env.BITCOIN_ZMQ_HASHBLOCK_PORT = String(NODES.watched.zmq);
  process.env.BITCOIN_NETWORK = 'regtest';

  const config = require('../../src/lib/config');
  const db = require('../../src/lib/db');
  const rpc = require('../../src/lib/rpc');
  const queries = require('../../src/lib/queries');
  const subscriber = require('../../src/lib/hashblock-subscriber');
  const relay = require('../../src/relay-profiler');
  const peerProfiler = require('../../src/peer-profiler');
  const peerSync = require('../../src/lib/peer-sync');
  db.open();

  log('');
  log('Bitcoin Core, as this app assumes it behaves:');

  // ---- what getpeerinfo actually gives us --------------------------------
  await check('getpeerinfo carries addr, connection_type and last_block', async () => {
    const peers = await rpc.getPeerInfo();
    assert.ok(peers.length > 0, 'the watched node has a peer');
    const p = peers[0];
    assert.equal(typeof p.addr, 'string', 'addr is a string');
    assert.equal(typeof p.connection_type, 'string', `connection_type present, got ${p.connection_type}`);
    assert.equal(typeof p.last_block, 'number', 'last_block is a number');
    assert.equal(typeof p.conntime, 'number', 'conntime is a number');
    assert.ok(['inbound', 'outbound'].includes(p.inbound ? 'inbound' : 'outbound'));
  });

  await check('a peer added with addnode is reported as connection_type "manual"', async () => {
    const peers = await rpc.getPeerInfo();
    const manual = peers.find((p) => p.connection_type === 'manual');
    assert.ok(manual, `expected one manual peer, saw ${peers.map((p) => p.connection_type).join(', ')}`);
  });

  await check('getaddednodeinfo lists what addnode was given', async () => {
    const added = await rpc.getAddedNodeInfo();
    assert.ok(Array.isArray(added), 'an array comes back');
    assert.ok(
      added.some((a) => String(a.addednode).includes(String(NODES.miner.p2p))),
      `expected the miner among ${JSON.stringify(added.map((a) => a.addednode))}`,
    );
  });

  // ---- the ZMQ path, end to end -----------------------------------------
  const seen = [];
  const sub = subscriber.start({
    url: config.bitcoin.zmqHashBlockUrl,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    onBlock: (event) => {
      seen.push(event);
      relay.handleHashBlock(event);
    },
  });
  // The subscriber has to be listening before the block is mined, and zmq's
  // connect() returns before the connection exists.
  await new Promise((r) => setTimeout(r, 1500));

  const minerAddress = (() => {
    try { return cli(NODES.miner, 'getnewaddress'); } catch { /* no wallet yet */ }
    cli(NODES.miner, '-named', 'createwallet', 'wallet_name=test');
    return cli(NODES.miner, 'getnewaddress');
  })();

  const mined = cli(NODES.miner, 'generatetoaddress', '1', minerAddress);
  const minedHash = Array.isArray(mined) ? mined[0] : mined;

  await check('a block mined on one node arrives at the other over ZMQ', async () => {
    const event = await waitFor('the hashblock message', () => seen.find((e) => e.blockHash === minedHash),
      { timeoutMs: 20000 });
    assert.equal(event.blockHash, minedHash,
      'the hash Core published is the hash bitcoin-cli reported - not byte-reversed');
  });

  await check('the race is recorded, with the height Core reports', async () => {
    const race = await waitFor('the race row', () => {
      const row = db.instance
        .prepare('SELECT block_hash AS h, block_height AS height FROM relay_race WHERE block_hash = ?')
        .get(minedHash);
      return row && row.height != null ? row : null;
    }, { timeoutMs: 20000 });
    const header = cli(NODES.watched, 'getblockheader', minedHash);
    assert.equal(race.height, header.height, 'the height stored matches getblockheader');
  });

  // The claim the whole app is built on.
  await check('the peer that delivered the block is the one credited with it', async () => {
    const race = db.instance.prepare('SELECT id FROM relay_race WHERE block_hash = ?').get(minedHash);
    assert.ok(race, 'the race exists');
    const credited = db.instance
      .prepare(
        `SELECT p.address AS address FROM relay_observation ro
           JOIN peer p ON p.id = ro.peer_id
          WHERE ro.race_id = ? AND ro.first = 1`,
      )
      .all(race.id);
    assert.equal(credited.length, 1, `exactly one peer credited, got ${credited.length}`);
    assert.ok(
      credited[0].address.includes(String(NODES.miner.p2p)) || credited[0].address.startsWith('127.0.0.1'),
      `the miner was credited, got ${credited[0].address}`,
    );
  });

  await check('every connected peer is recorded as eligible for that block', async () => {
    const race = db.instance.prepare('SELECT id FROM relay_race WHERE block_hash = ?').get(minedHash);
    const eligible = db.instance
      .prepare('SELECT COUNT(*) AS n FROM relay_observation WHERE race_id = ?').get(race.id).n;
    const peers = await rpc.getPeerInfo();
    assert.equal(eligible, peers.length, 'one observation per connected peer');
  });

  await check('attribution reports itself as working', async () => {
    const health = queries.attributionHealth();
    assert.equal(health.ok, true, `attribution health said ${JSON.stringify(health)}`);
  });

  await check('the two clocks agree, read off Core own Date header', async () => {
    await rpc.getBlockCount();
    const reading = rpc.clockOffset();
    assert.ok(reading, 'a reading was taken from the response headers');
    assert.ok(Math.abs(reading.offsetMs) < 2000,
      `one machine, so the offset should be ~0, got ${reading.offsetMs}ms`);
  });

  // ---- sessions ----------------------------------------------------------
  await check('the peer profiler records a session for the live peer', async () => {
    await peerProfiler.pollOnce();
    const row = db.instance
      .prepare(`SELECT connection_type AS type, direction, ended_at AS endedAt FROM peer_session ORDER BY id DESC LIMIT 1`)
      .get();
    assert.ok(row, 'a session was written');
    assert.equal(row.endedAt, null, 'and it is open');
    assert.equal(row.direction, 'outbound', 'the addnode peer is outbound');
    assert.equal(row.type, 'manual', 'and Core calls it manual');
  });

  await check('a manual peer is restored to Core after it forgets', async () => {
    // What happens on every bitcoind restart: Core's runtime addnode list is
    // memory only, and this app putting it back is the feature.
    const address = `127.0.0.1:${NODES.miner.p2p}`;
    await peerSync.addTrustedPeer(address, 'the miner', { kept: true });
    await rpc.addNode(address, 'remove');
    await waitFor('Core to forget the node', async () => (await rpc.getAddedNodeInfo()).length === 0);

    await peerSync.syncTrustedToAddnode();
    const added = await waitFor('Core to have it again', async () => {
      const list = await rpc.getAddedNodeInfo();
      return list.length > 0 ? list : null;
    });
    assert.ok(
      added.some((a) => String(a.addednode).includes(String(NODES.miner.p2p))),
      `restored, got ${JSON.stringify(added.map((a) => a.addednode))}`,
    );
  });

  sub.stop();
  // db has no close() of its own; the underlying better-sqlite3 handle does,
  // and leaving it open holds the process past the last assertion.
  try { db.instance.close(); } catch { /* already closed */ }
  rpc.agent.destroy();

  log('');
  log(`${passes} passed, ${failures} failed`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => { shutDown(); process.exit(code); })
  .catch((err) => {
    log('');
    log(`the harness itself failed: ${err.stack || err.message}`);
    shutDown();
    process.exit(1);
  });
