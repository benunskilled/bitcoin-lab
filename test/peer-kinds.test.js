'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * The dashboard strikes through a peer whose software cannot pass a block on.
 * Peer Map, the app next door, paints the same peers on a map from the same
 * node and makes the same judgement in kinds.go. The two lists drifted: the
 * Go side had learned about mempool/electrum indexers, university scanners
 * (.ac., uni-) and Bitcoin XT, and the Lab had not - so one node's peer could
 * be a live relay in one window and a struck-through wallet in the other.
 *
 * This reads the real Go file rather than a copy of its patterns, so the two
 * cannot drift again without something failing here.
 */

const KINDS_GO = '/root/work/audit/peer-map/kinds.go';
const APP_JS = path.join(__dirname, '..', 'src', 'dashboard', 'public', 'app.js');

// {"Indexer", regexp.MustCompile(`(?i)electrs|...`), false},
const GO_RULE = /^\s*\{"([^"]+)",\s*regexp\.MustCompile\(`(.+?)`\),\s*(true|false)\},\s*$/gm;

function goRules() {
  const src = fs.readFileSync(KINDS_GO, 'utf8');
  const rules = [];
  for (const [, name, pattern, relays] of src.matchAll(GO_RULE)) {
    // Go spells the case-insensitive flag inside the pattern; JavaScript
    // spells it beside it. Everything else in these patterns is the same
    // syntax in both languages.
    const ci = pattern.startsWith('(?i)');
    rules.push({ name, re: new RegExp(ci ? pattern.slice(4) : pattern, ci ? 'i' : ''), relays: relays === 'true' });
  }
  return rules;
}

// The Go side's own answer, by its own rules, in its own order.
function goRelaysBlocks(rules, subver) {
  if (!subver) return true;
  for (const rule of rules) if (rule.re.test(subver)) return rule.relays;
  return true; // "Other" - unrecognised software still relays
}

// app.js is a browser script: it touches the DOM at the top level, so it
// cannot simply be required. The classifier is lifted out of the real file and
// run as it is written there.
function labCannotRelayReason() {
  const src = fs.readFileSync(APP_JS, 'utf8');
  const start = src.indexOf('const KIND_RULES = [');
  assert.ok(start > 0, 'app.js must still define KIND_RULES');
  const fnStart = src.indexOf('function cannotRelayReason', start);
  assert.ok(fnStart > 0, 'app.js must still define cannotRelayReason');
  const end = src.indexOf('\n}', fnStart) + 2;
  return vm.runInNewContext(`${src.slice(start, end)}\ncannotRelayReason;`);
}

// One agent per alternative in every rule on the Go side, plus the awkward
// ones. Real strings, in the shape peers actually send them.
const AGENTS = [
  // Pool software, and an operator naming their pool in the bracketed comment.
  '/ckpool/', '/ckp2p:1.0/', '/Satoshi:29.1.0(PyBLOCK-POOL)/Knots:20250903/',
  // The case that makes the order matter: "mempool" is an indexer's name and
  // also the letters "pool" inside a bracketed comment. Whichever way it is
  // judged, both apps have to judge it the same way.
  '/Satoshi:28.0.0(mempool.space)/', '/mempool/', '/mempool.space:1.0/',
  // Other chains.
  '/Bitcoin ABC:28.0.0/', '/BUCash:1.9.0/', '/Bitcoin SV:1.1.0/', '/BCHUnlimited:1.10.0/', '/Bitcoin XT:0.11.0/',
  // Scanners, as a service and as a university department.
  '/bitcoin@dsn.tm.kit.edu/', '/dsn.kastel:1/', '/Satoshi:25.0.0(node.cs.ac.uk)/', '/uni-goettingen.de/',
  '/bitnodes.io:0.1/', '/metrika:1.0/', '/nodemap/', '/some-crawler:2/', '/portscanner/',
  // Indexers and wallets.
  '/electrs:0.10.0/', '/electrumx:1.16/', '/esplora/',
  '/bitcoinj:0.15/', '/breadwallet:1.0/', '/bither/', '/MultiBit:0.5/', '/wasabi:2.0/', '/Bitcoin Wallet:9.0/',
  '/neutrino:0.2.0/',
  // Software that does relay, and software nobody here has heard of.
  '/Satoshi:29.0.0/', '/Satoshi:28.1.0/Knots:20250903/', '/btcwire:0.5.0/', '/Sat0shi:31.0.0/', '',
];

test('the Lab and Peer Map judge every peer the same way', () => {
  const rules = goRules();
  assert.ok(rules.length >= 8, 'the Go rules must actually have been parsed');
  const cannotRelayReason = labCannotRelayReason();

  for (const agent of AGENTS) {
    const labRelays = cannotRelayReason(agent) === null;
    assert.equal(
      labRelays,
      goRelaysBlocks(rules, agent),
      `${JSON.stringify(agent)} is painted differently in the two apps`,
    );
  }
});

test('a peer that sent no user agent at all is given the benefit of the doubt', () => {
  const cannotRelayReason = labCannotRelayReason();
  for (const nothing of ['', null, undefined]) {
    assert.equal(cannotRelayReason(nothing), null, 'not knowing is not the same as knowing it cannot');
  }
});

test('the reason shown names the family the Go side named', () => {
  // The colour is what has to match, but a peer marked "a wallet" in one app
  // and "an address indexer" in the other is still two answers to one
  // question. The names differ in wording by design ("Indexer" vs "an address
  // indexer"), so this checks they are about the same thing.
  const cannotRelayReason = labCannotRelayReason();
  const expectations = [
    ['/Bitcoin XT:0.11.0/', 'another chain'],
    ['/Satoshi:25.0.0(node.cs.ac.uk)/', 'research scanner'],
    ['/uni-goettingen.de/', 'research scanner'],
    ['/mempool.space:1.0/', 'indexer'],
    ['/electrumx:1.16/', 'indexer'],
  ];
  for (const [agent, fragment] of expectations) {
    assert.match(cannotRelayReason(agent) || '', new RegExp(fragment), agent);
  }
});
