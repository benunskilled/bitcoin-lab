'use strict';

// This window answers to a name, and links to Peer Map aim at Peer Map's name: clicking back and forth between the two
// apps then reuses one window each instead of opening a new one per click. That needs the opener kept, so these links
// carry no rel="noopener" - both windows are this Umbrel's own apps.
window.name = 'bitcoin-lab';
// On a phone or tablet Safari loads a named tab in the background and stays where it is, so a tap seemed to do nothing.
// There the jump stays in the same tab, and Back returns.
const TOUCH_ONLY = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const PEER_MAP_TARGET = TOUCH_ONLY ? '_self' : 'peer-map';

// Peer/pool ranking is a slow-moving, historical stat, not a live combat
// feed - it doesn't need sub-10s freshness, and peerRanking() in particular
// runs several joined aggregate queries. Manual actions (add/remove/
// disconnect a peer, delete a pool) already trigger their own immediate
// refreshPeers()/refreshPools() call, so this interval only governs how
// stale the tables are allowed to get from someone else's activity (Core
// itself connecting/dropping peers) between clicks.
const REFRESH_MS = 20000;
// The rotation loop acts at most once every ten minutes, so its panel has no
// reason to be on the same schedule as the live peer tables.
const ROTATION_REFRESH_MS = 2 * 60 * 1000;
// New blocks no longer arrive by polling at all. /api/events is a
// Server-Sent Events stream the dashboard process feeds from Core's own ZMQ
// notification, so the wave fires when the block actually lands instead of
// up to five seconds later - and the old 5s poll (720 requests an hour to
// catch roughly six events) is gone entirely.
const HIGHLIGHT_MS = 2 * 60 * 1000; // how long the first-peer row(s) stay tinted after a new block

// address -> expiry timestamp (ms). Rebuilt into row classes on every
// refreshPeers() render, since the table bodies are fully re-rendered each
// poll rather than patched in place.
const highlightUntil = new Map();
let lastRaceId = null; // null = "haven't loaded the latest race yet", not "no races"
let lastKnownHeight = null;
let MAX_MANUAL_PEERS = 8; // overwritten from /api/status once loaded (config.maxManualPeers)
// The window the ranking judges a peer on, in blocks. Overwritten from
// /api/status (config.recentScoreWindowBlocks) rather than hardcoded, because
// it names a number in a column heading and a heading that lies about the
// window is worse than one that omits it.
let RECENT_WINDOW_BLOCKS = null;

// Peer Map is the other app in the pair: the same peers on a world map, with
// what kind of software each one runs. Whether it is installed is answered by
// this app's own server (it can see the container; a browser cannot), and the
// port is the one Peer Map's store manifest publishes.
let PEER_MAP_INSTALLED = false;
const PEER_MAP_PAGE = 'https://github.com/benunskilled/peer-map';
let PEER_MAP_PORT = 8791; // the store port; a test copy passes its own (peerMapLinkPort)
function peerMapURL(address) {
  const base = `${location.protocol}//${location.hostname}:${PEER_MAP_PORT}/`;
  return address ? `${base}?peer=${encodeURIComponent(address)}` : base;
}

// A peer another app pointed at, via ?peer=<address>. Marked once and scrolled
// to, then left alone: it is a starting point, not a filter, and a row that
// jumped under the cursor on every refresh would be its own kind of rude.
const FOCUS_ADDRESS = new URLSearchParams(location.search).get('peer');
let focusDone = false;

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtDuration(ms) {
  if (ms == null) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  // Seconds below a minute, as Peer Map writes it: "41s", not "0m".
  if (m === 0) return `${s}s`;
  return `${m}m`;
}

function fmtPct(p) {
  return p == null ? '-' : `${p.toFixed(1)}%`;
}

// Disk used by the measurement data, and traffic. One decimal below a
// gigabyte and two above it, so the number stays readable as the file grows
// past the point where anyone would care about the megabytes. Steps of 1000,
// as Peer Map counts them, and the number never apart from its unit.
function fmtBytes(bytes) {
  const mb = bytes / 1e6;
  if (mb < 1000) return `${mb.toFixed(1)}\u00a0MB`;
  return `${(mb / 1000).toFixed(2)}\u00a0GB`;
}

// The colour says what kind of connection this is, and nothing else. Manual,
// inbound, outbound - the same three colours Peer Map paints its markers with;
// an app on this Umbrel gets a fourth of its own.
function statusPillClass(status) {
  if (status === UMBREL_APP) return 'umbrel';
  if (status === 'OFFLINE' || status === 'MANUAL OFFLINE') return 'offline';
  if (status === 'TESTING') return 'manual';
  if (status.includes('MANUAL')) return 'manual';
  if (status.includes('INBOUND')) return 'inbound';
  return 'outbound';
}

// Software that does not pass blocks on at all. These peers are connected,
// they count in every total, and they can never win a block - a phone wallet
// has nothing to relay, a crawler is there to look, an indexer serves someone
// else's wallet. Measured over 2,270 peers on one node: 790 observations
// between them, not one first.
//
// The test is the user agent, which the peer writes itself, so it is a hint
// and not proof. That is fine for a colour: nothing is excluded from the
// ranking, nothing is decided - a green pill just stops claiming that this
// connection was ever in the running.
//
// Deliberately NOT in here: block-relay-only peers. They refuse transactions
// and pass blocks on, which is the opposite of this list.
//
// This is Peer Map's kindRules (peer-map/kinds.go), same patterns in the same
// order, and it has to stay that way. The two apps show the same node's peers
// in two windows, and a peer that is marked in one and not the other
// is worse than no marking at all. The Go side names each family; here only
// the answer to "can this thing pass a block on" is needed, so a family that
// relays carries a null reason and is simply a stop.
//
// Order is load-bearing, exactly as it is there: first match wins, so a pool
// node is recognised before anything else gets to read its user agent. A
// solo-pool operator who puts the pool's name in the bracketed comment -
// "/Satoshi:29.1.0(mempool-pool)/" and the like - is running a relaying node,
// and without that rule first the word inside the brackets would have it
// painted as an indexer.
const KIND_RULES = [
  // Core's name misspelt ("/Sat0shi:", "/Satoshi2:"): Peer Map's Disguised.
  // What it runs is unknown, so it is not struck - and it comes first, so the
  // rest of its agent is not read as a crawler or a wallet either.
  [/^\/Sat0shi:|^\/Satoshi[0-9X]+:|^Satoshi:/, null, 'whole'],
  // Mining pool software speaking p2p, or a node whose operator says in the
  // bracketed comment that it belongs to a pool. Relays.
  [/ckpool|^\/ckp2p:|^\/CKCoinD:|\([^)]*pool[^)]*\)|^\/P2Pool:|^\/[^:/(]*pool[^:/(]*:/i, null, 'no-mempool'],
  // Bitcoin Classic's "(EB8)" is Bitcoin Cash's block size; SuperBitcoin,
  // Irium and VDS are forks and altcoins of their own. Bitcoin Purity, a hard
  // fork of Knots, says "/Satoshi:29.4/Purity:1.1.0/".
  [/Bitcoin ABC|BUCash|Bitcoin SV|BCHUnlimited|Bitcoin XT|Classic:|\(EB[0-9]|SuperBitcoin|iriumd|vds[_ ]|^\/Aurum:|\/Purity:|^\/dexcash-nodes:/i, 'a client of another chain', 'whole'],
  // Scanners run as a service and scanners run by universities - the second
  // kind announces itself with its department's domain.
  [/kit\.edu|dsn\.tm|dsn\.kastel|\.ac\.|uni-|^\/btcwire:[^/]*\/Satoshi:|^\/rske-research:|^\/acsrg-research:|^\/dataforge-observer:|^\/connector\/$/i, 'a research scanner'],
  // Crawlers, seeders and node counters, including the ones that only say
  // "scan", "seeder", "census" or "monitor".
  [/bitnodes|bluematt-tokio-client|metrika|nodemap|crawl|scan|seeder|census|monitor|observatory|sonar|scout|nebula|watch|listener|argus|readonly|bitdash|logosnaut|dnsseed|survey|lionseed|gnoban|^\/p2p-observer:|^\/p2p-extractor:|^\/bip324-probe:|^\/topology-probe:|^\/p2p-probe:|^\/probe:|^\/btc-peers:|^\/bip110-observer:/i, 'a network crawler'],
  // Address indexers for wallets: they follow the chain and relay nothing.
  [/electrs|electrum|esplora|\/mempool|^NBXplorer-|^\/symphony:/i, 'an address indexer'],
  [/bitcoinj|breadwallet|\/bread:|bither|multibit|wasabi|Bitcoin Wallet|^\/blueberry:|^\/winnow:|^\/BitcoinKit:|^\/WalletKit:|^\/Ladybug:|^\/hodlwallet:|\/spvwallet:/i, 'a wallet'],
  // Lightning wallets on lnd, which follow the chain through neutrino.
  [/neutrino|\/lit:v/i, 'a Lightning wallet'],
  // Other BIP157 light clients: Kyoto, which says "Rust BIP-157". VerifiedX
  // validators follow the chain the same way for a chain of their own: headers,
  // some blocks, no transactions.
  // EMPORION and its new name SYMMARTYS fetch headers for OpenTimestamps
  // verification (bitcoin_headers.py in alexar76/emporion).
  [/BIP-157|^\/bip157-fetch:|kyoto|^Yuki \/|^\/VerifiedX:|^\/nakamoto:|^\/bitcoin-s:|^Stacks\/|\/CaribouSPV:|^\/EMPORION:|^\/SYMMARTYS:/i, 'a light client'],
];

// Rules marked 'whole' read the whole agent: a pool or another chain may be
// named in the brackets (the pool rule without the word "mempool"). The rest read only the name outside them - a word
// like "monitor" or "electrs" in an operator's label does not make a Core
// node a crawler or an indexer. Peer Map's classify does the same.
// The first rule that names this client, as its place in KIND_RULES, or -1.
function kindRuleIndex(client) {
  if (!client) return -1;
  const bare = client.replace(/\([^)]*\)/g, '');
  // "pool" inside "mempool" is no pool: "(mempool.guide)" is a node's label.
  const noMempool = client.replace(/mempool/gi, '');
  return KIND_RULES.findIndex(([re, , reads]) => re.test(reads === 'whole' ? client : reads === 'no-mempool' ? noMempool : bare));
}
// The two rules the ranking marks a peer by when Peer Map is not there to ask.
const MISSPELT_RULE = 0;
const POOL_RULE = 1;

function cannotRelayReason(client) {
  const i = kindRuleIndex(client);
  return i < 0 ? null : KIND_RULES[i][1];
}

// Whether any rule names this client at all. Peer Map flags a fork only on
// nodes and unknown software, not on a peer it already named as something
// else (a pool, a misspelt Core), so the Lab asks the same.
const namedByKindRule = (client) => kindRuleIndex(client) >= 0;
const otherChainShown = (p) => (p.otherChain && !namedByKindRule(p.client) ? p.otherChain : null);

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// subver (Client) is fully attacker-controlled - any P2P peer can set an
// arbitrary user-agent string - so it must never go into innerHTML
// unescaped. Applied to address/label too as cheap defense in depth.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

// Address and Client can both be long enough to blow up the whole table's
// width (a long subver string in particular forces every other column wide
// too under auto table layout) - cap them visually with an ellipsis. The full
// value goes into a tooltip only when the ellipsis actually cut it; a tooltip
// that repeats the cell says nothing (see the mouseover handler below).
function truncatedCell(text, cls = '') {
  const safe = escapeHtml(text);
  return `<td class="cell-truncate${cls ? ' ' + cls : ''}" data-full="${safe}">${safe}</td>`;
}

// A table that does not fit its panel first gives up its least important
// columns, a step at a time (data-drop="1".."4" on the <th>: sessions, then
// session, ping and last the client; for the pools seen/miss, then
// host). Only when even that is too wide does each row turn
// into a small card of its own (see
// .table-wrap.cards in style.css) instead of scrolling sideways - on a phone,
// in practice. Cards came too early before: a laptop window a little narrower
// than usual already broke every table into ragged, wrapping lines.
// Decided by measuring, not by a fixed screen width, and for all tables
// together - one panel as cards and the next as a table looked like two
// different pages. The rows are re-rendered all the time, so the labels are
// put back after every change.
const DROP_LEVELS = 4;

// Column widths of the peer tables, set for each step: the short columns as
// wide as their content, the other four as wide as each needs - an IPv4
// address with its port, a client name like /Satoshi:31.0.0/ (a longer one is
// cut, the open row has it whole), the longest pill (MANUAL OFFLINE), First %
// with its ⚡ and 📡. A window too narrow for that shrinks those four
// together, so none is cut while another has room to spare. A wider one
// shares what is left among those four, the client twice over: in one or
// two columns only, it stood as an empty band (under Type and First %, then
// under the client), and beside the short numbers it was a gap too.
const COL_FIXED = { 'col-ping': 72, 'col-session': 78, 'col-sessions': 56, 'col-actions': 240 };
const COL_NEED = { 'col-address': 161, 'col-client': 140, 'col-status': 139, 'col-pct': 141 };
function sizeColumns() {
  for (const t of document.querySelectorAll('table.peer-table')) {
    if (!t.offsetWidth) continue;
    const ths = [...t.tHead.rows[0].cells];
    for (const th of ths) th.style.width = '';
    const shown = ths.filter((th) => getComputedStyle(th).display !== 'none');
    const col = (th) => [...th.classList].find((c) => c.startsWith('col-'));
    // Only the tables with these columns.
    if (!shown.every((th) => COL_FIXED[col(th)] || COL_NEED[col(th)])) continue;
    let fixed = 0;
    let need = 0;
    for (const th of shown) {
      if (COL_FIXED[col(th)]) fixed += COL_FIXED[col(th)];
      else need += COL_NEED[col(th)] || 0;
    }
    // Without the Client column the address cell carries the client too,
    // and the two buttons stand one above the other (style.css).
    const last = t.closest('.table-wrap')?.dataset.drops === String(DROP_LEVELS);
    if (last) {
      fixed -= COL_FIXED['col-actions'] - 136;
      need += COL_NEED['col-client'] - COL_NEED['col-address'];
    }
    const spare = Math.max(0, t.offsetWidth - fixed);
    const want = (c) => (last && c === 'col-address' ? COL_NEED['col-client'] : COL_NEED[c] || 0);
    const fixOf = (c) => (last && c === 'col-actions' ? 136 : COL_FIXED[c]);
    const base = new Map(shown.map((th) => [th, fixOf(col(th)) || (spare < need ? spare * want(col(th)) / need : want(col(th)))]));
    const rest = spare > need ? spare - need : 0;
    const share = (th) => (col(th) === 'col-client' ? 2 : COL_NEED[col(th)] ? 1 : 0);
    const shares = shown.reduce((sum, th) => sum + share(th), 0);
    const add = (th) => (shares ? rest * share(th) / shares : 0);
    for (const th of shown) th.style.width = Math.floor(base.get(th) + add(th)) + 'px';
  }
}

function fitTables() {
  const y = window.scrollY;
  const wraps = [...document.querySelectorAll('.table-wrap')];
  for (const w of wraps) {
    const ths = [...w.querySelectorAll('thead th')];
    for (const tr of w.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, i) => {
        const th = ths[i];
        if (!th || td.dataset.label != null) return;
        // A card has no room for "(last 500)": the value next to it says x/500 anyway.
        // A header may name a shorter label for the card (data-card: "Last").
        td.dataset.label = th.dataset.card || th.textContent.replace(/\s*\(.*\)\s*$/, '').trim();
        const col = [...th.classList].find((c) => c.startsWith('col-'));
        if (col) td.dataset.col = col;
        if (th.dataset.drop) td.dataset.drop = th.dataset.drop;
      });
    }
  }
  // Measuring from scratch means taking the cards away and laying out the full
  // table first: the page shrinks and grows again, and whatever the reader was
  // looking at jumps. That is only needed when the window got wider - a page
  // that needed cards at this width still needs them, and one that needed two
  // columns dropped still needs at least that. Otherwise the check starts
  // where the last one ended.
  const width = document.documentElement.clientWidth;
  const wider = width > fitState.width;
  fitState.width = width;
  if (fitState.cards && !wider) return false;
  // What the reader is looking at: the first heading or row at the top of the
  // window. When the layout changes, that stays where it was - restoring the
  // old scroll position instead threw the reader a screen or more down the
  // moment the tables above turned into taller cards. (The panels opt out of
  // the browser's own scroll anchoring, see .card in style.css.)
  const anchor = window.scrollY > 0
    ? [...document.querySelectorAll('h2, h3, .table-wrap tbody tr')].find((e) => {
      // A hidden element has a rect of zeros.
      const r = e.getBoundingClientRect();
      return r.height > 0 && r.top >= 0;
    })
    : null;
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  const before = `${fitState.level}${fitState.cards}`;
  const tight = () => wraps.some((w) => w.clientWidth && w.scrollWidth > w.clientWidth + 1);
  // An address cut to "..." counts as too tight while there are columns left
  // to give up before it - an ordinary one, that is: an onion address is not
  // worth four columns on a wide screen. A client name may be cut; the open
  // row shows it whole.
  const clientCut = () => [...document.querySelectorAll('table.peer-table td[data-col="col-address"]')]
    .some((td) => td.clientWidth && (td.dataset.full || '').length <= 24 && td.scrollWidth > td.clientWidth);
  // A type pill cut to "MANUAL LI..." counts as too tight as well: the column
  // can squeeze below its 140px before the table as a whole overflows.
  const typeCut = () => [...document.querySelectorAll('table.peer-table td[data-col="col-status"]')]
    .some((td) => td.clientWidth && td.scrollWidth > td.clientWidth + 1);
  if (wider) for (const w of wraps) w.classList.remove('cards');
  let level = wider ? 0 : fitState.level;
  for (; ; level++) {
    for (const w of wraps) w.dataset.drops = String(level);
    sizeColumns();
    if (level === DROP_LEVELS || !(tight() || clientCut() || typeCut())) break;
  }
  const cards = level === DROP_LEVELS && tight();
  for (const w of wraps) w.classList.toggle('cards', cards);
  fitState.level = level;
  fitState.cards = cards;
  if (anchor && anchor.isConnected && before !== `${level}${cards}`) {
    window.scrollBy(0, anchor.getBoundingClientRect().top - anchorTop);
    return true;
  }
  if (window.scrollY !== y) window.scrollTo(0, y);
  return false;
}
// A reload puts the reader back where they were. The browser tries it before
// the peers have arrived, finds a short page and settles near the top. So the position is kept here, set again once the
// tables are in, and let go when the reader moves the page, when the page has
// grown to it, or after six seconds.
let reloadY = null;
let restoredY = null;  // where this code last put the page
try {
  // Always manual: with the browser's own restore on, it and this code pull the page two ways.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const nav = performance.getEntriesByType('navigation')[0];
  const key = 'scrollY:' + location.pathname;
  if (nav && (nav.type === 'reload' || nav.type === 'back_forward')) {
    const v = Number(sessionStorage.getItem(key));
    if (v > 0) reloadY = v;
  }
  // Still waiting to be restored, the page is short: keep the position that waits.
  const save = () => { try { sessionStorage.setItem(key, String(reloadY !== null ? reloadY : Math.round(window.scrollY))); } catch { /* private window */ } };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  const letGo = () => { reloadY = null; };
  for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) window.addEventListener(ev, letGo, { passive: true });
  // A drag on the scrollbar or a fling is the reader's, not ours.
  window.addEventListener('scroll', () => { if (reloadY !== null && restoredY !== null && Math.abs(window.scrollY - restoredY) > 40) letGo(); }, { passive: true });
  setTimeout(letGo, 6000);
} catch {
  // No storage: nothing is saved, so the browser's own restore has to do.
  try { history.scrollRestoration = 'auto'; } catch { /* old browser */ }
}
function restoreReloadY() {
  if (reloadY === null) return;
  if (FOCUS_ADDRESS) { reloadY = null; return; }
  const max = document.documentElement.scrollHeight - window.innerHeight;
  window.scrollTo(0, Math.min(reloadY, max));
  restoredY = window.scrollY;
  if (max >= reloadY) reloadY = null;
}

// The width of the last check and what it decided. The first check always
// counts as wider, so it measures from scratch.
const fitState = { width: -Infinity, level: 0, cards: false };
let fitTimer = null;
const scheduleFit = () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => { fitTables(); fitSeconds(); fitPct(); notePlace(); }, 50); };
// On a phone card, First % with ⚡ and 📡 must stay one line: a card taller
// than the others moves every card below it. Where the line does not fit, the
// count (312/500) goes in that card alone - the share and the marks stay, and
// the count is still in the table on a wide screen (28.10.2026). Measured per
// card: the share and the count are as wide as their digits. The count's
// width comes from its text, so a hidden one is measured the same way.
const textWidth = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  return (el, text) => { ctx.font = getComputedStyle(el).font; return ctx.measureText(text).width; };
})();
// Each second part only where it fits whole in its cell or line; cut short,
// it said less than the first alone (09.11.2026). The client cell is cut to
// its column, so the longer text never widens it. Measured, not tried: the
// page watches every change to keep the reader's place and fits again on
// one, so a text put in to try was a loop that never ended. Written only when
// the answer changes.
function fitSeconds() {
  for (const e of document.querySelectorAll('.cname[data-full]')) {
    const box = e.closest('small, td');
    if (!box || !box.offsetWidth) continue;
    const sep = e.previousElementSibling && e.previousElementSibling.querySelector('.sep');
    // Where the name starts in its box, and how far the box reaches: a cut
    // box does not report how wide its content is.
    const cs = getComputedStyle(box);
    const start = e.getBoundingClientRect().left - box.getBoundingClientRect().left - box.clientLeft - parseFloat(cs.paddingLeft)
      + (sep && sep.hidden ? textWidth(sep, sep.textContent) : 0);
    const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const fits = (t) => start + textWidth(e, t) <= room + 1;
    // An opened card's line wraps: everything, whole. A table cell does not.
    const next = (box.closest('tr.open') && cs.whiteSpace !== 'nowrap') || fits(e.dataset.full) ? e.dataset.full : fits(e.dataset.one) || !e.dataset.word ? e.dataset.one : '';
    if (e.textContent !== next) e.textContent = next;
    if (sep && sep.hidden !== !next) sep.hidden = !next;
  }
}

function fitPct() {
  for (const td of document.querySelectorAll('.cards table.peer-table td[data-col="col-pct"]')) {
    const marks = [...td.querySelectorAll('.hb')];
    const cnt = td.querySelector('.cnt');
    if (!cnt || !marks.length) { td.classList.remove('tight'); continue; }
    const pct = td.querySelector('.pct');
    const need = pct.getBoundingClientRect().width + textWidth(cnt, '\u00a0' + cnt.textContent)
      + marks.reduce((w, m) => w + m.getBoundingClientRect().width + parseFloat(getComputedStyle(m).marginLeft), 0);
    // Only on a change, so the observer below is not set off again.
    if (td.classList.contains('tight') !== need > td.clientWidth) td.classList.toggle('tight');
  }
}
// Re-rendered rows are cards without their labels until fitTables runs, and
// fitTables takes the cards away for a moment to measure: either way the page
// is shorter for an instant, and Safari clamps the scroll position to it and
// keeps it there - a reader far down was thrown up on every refresh. The
// position from the last frame is put back before anything is painted. Only a
// jump upwards of more than a flick, so a scroll in progress is left alone.
let lastScrollY = window.scrollY;
// Keeping the scroll position is not enough either: with all peers shown, a
// refresh adds and drops rows above the reader, and everything below moved
// by a few hundred pixels every twenty seconds (iPhone, 24.10.2026). Safari
// has no scroll anchoring of its own, so the page does it: what is at the top
// of the window - a heading, or a row in a table - is noted, and after any
// change of the page it is put back where it was.
// A row is held by its place in its table, never by the peer in it
// (28.10.2026): the lists are sorted by how well a peer delivers, and a page
// that followed one peer up or down the ranking jumped under a reader who
// was only looking. When a peer moves, another one stands in its place; the
// list does not move. Every change goes through here: new data, a card
// folded, a row opened (the observer below also watches those classes).
//
// Headings and tables are found again by name, not by their number on the
// page (06.11.2026): with all peers shown, a reader near the top of the
// ranking was thrown 36,000 px down to Traffic on a refresh, because "the
// nth heading" or "table n" had come to mean another one further down. A
// heading's name is its own text, without the counts in its hint.
const PLACE_SELECTOR = 'h2, h3, .table-wrap tbody tr';
let placeMarks = [];
let placePageHeight = 0;
const headName = (h) => (h.firstChild && h.firstChild.textContent || '').trim();
function notePlace() {
  placeMarks = [];
  placePageHeight = document.documentElement.scrollHeight;
  if (window.scrollY <= 0) return;
  for (const e of document.querySelectorAll(PLACE_SELECTOR)) {
    const r = e.getBoundingClientRect();
    if (r.height === 0 || r.bottom <= 0) continue;
    if (r.top >= window.innerHeight) break;
    const table = e.tagName === 'TR' && e.closest('table');
    if (table && !table.id) continue;
    const key = table ? [table.id, [...e.parentNode.children].indexOf(e)] : [null, headName(e)];
    if (!table && !key[1]) continue;
    placeMarks.push({ key, top: r.top });
    if (placeMarks.length === 3) break;
  }
}
function findPlace([table, which]) {
  if (table) return document.getElementById(table)?.tBodies[0]?.children[which];
  return [...document.querySelectorAll('h2, h3')].find((h) => headName(h) === which);
}
// Back where it was, by the first of the noted elements still there. Content
// above the reader can only push it down as far as the page has grown, give or
// take what moved around it: a move far beyond that found the wrong element,
// and is not made.
function keepPlace() {
  const grown = document.documentElement.scrollHeight - placePageHeight;
  for (const { key, top } of placeMarks) {
    const e = findPlace(key);
    if (!e || e.getBoundingClientRect().height === 0) continue;
    const d = e.getBoundingClientRect().top - top;
    if (Math.abs(d) > Math.abs(grown) + window.innerHeight / 2) continue;
    if (Math.abs(d) >= 1) window.scrollBy(0, d);
    return true;
  }
  return false;
}
let placeFrame = 0;
window.addEventListener('scroll', () => {
  lastScrollY = window.scrollY;
  if (!placeFrame) placeFrame = requestAnimationFrame(() => { placeFrame = 0; notePlace(); });
}, { passive: true });
// A class or attribute matters only where it can change the height of the
// page's content: inside main, and not the beating dot or the bar that rides
// along at the top. The jump bar outside main changes its class on every
// scroll; counting that put the reader back after each flick, and the page
// could not be scrolled at all (2.0.1-62/63 in the test store, 28.10.2026).
const QUIET = '.live-dot, .stick';
const counts = (m) => m.type === 'childList' || (m.target.closest('main') && !m.target.closest(QUIET));
new MutationObserver((list) => {
  if (!list.some(counts)) return;
  const y = lastScrollY;
  // Not when fitTables has just kept the reader's place itself: that move is
  // meant, and putting the old position back would undo it.
  const anchored = fitTables();
  fitSeconds();
  fitPct();
  // The old position only where the page still reaches it: after "Show top 10
  // only" it no longer does, and forcing it landed the reader at the bottom.
  const reachable = y <= document.documentElement.scrollHeight - window.innerHeight;
  // A fold keeps the reader's place itself, by what was tapped (foldInPlace).
  if (!folding && !anchored && !keepPlace() && y - window.scrollY > 100 && reachable) window.scrollTo(0, y);
  lastScrollY = window.scrollY;
  notePlace();
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open', 'hidden'] });
// Only a change of width can change whether the tables fit. On an iPhone the
// height changes all the time - Safari's toolbar shrinks and grows while the
// page scrolls - and measuring on each of those threw the reader up the page.
let fitWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === fitWidth) return;
  fitWidth = window.innerWidth;
  scheduleFit();
});
document.addEventListener('toggle', scheduleFit, true);

// Whether a cell is cut off depends on the screen, so it is decided when the
// pointer gets there. A link inside keeps its own hint and gets the full
// value in front of it.
document.addEventListener('mouseover', (e) => {
  const td = e.target.closest && e.target.closest('td[data-full]');
  if (!td) return;
  const cut = td.scrollWidth > td.clientWidth;
  const link = td.querySelector('a[data-tip]');
  if (link) link.title = (cut ? td.dataset.full + '\n' : '') + link.dataset.tip;
  else td.title = cut ? td.dataset.full : '';
});

async function refreshStatus() {
  const s = await api('/api/status');
  if (s.maxManualPeers) MAX_MANUAL_PEERS = s.maxManualPeers;
  if (s.recentScoreWindowBlocks && s.recentScoreWindowBlocks !== RECENT_WINDOW_BLOCKS) {
    RECENT_WINDOW_BLOCKS = s.recentScoreWindowBlocks;
    for (const th of document.querySelectorAll('.js-first-pct-head')) {
      th.textContent = `First % (last ${RECENT_WINDOW_BLOCKS})`;
    }
  }
  applyStratumEnabled(Boolean(s.stratumRaceEnabled));
  // Folded, the Storage card says how big the database is.
  if (s.dbBytes != null) document.getElementById('storage-total').textContent = fmtBytes(s.dbBytes);
  PEER_MAP_INSTALLED = Boolean(s.peerMapInstalled);
  if (s.peerMapLinkPort) PEER_MAP_PORT = s.peerMapLinkPort;
  const readOnlyBanner = document.getElementById('readonly-banner');
  if (readOnlyBanner) readOnlyBanner.hidden = !s.readOnly;
  const rotationToggleBox = document.getElementById('rotation-toggle');
  if (rotationToggleBox && s.readOnly) rotationToggleBox.disabled = true;
  const siblingLink = document.getElementById('sibling-link');
  if (siblingLink) {
    // Without Peer Map the same link leads to where it can be had: the
    // header is the one quiet place for it, not a line in the tables.
    siblingLink.hidden = false;
    siblingLink.target = PEER_MAP_INSTALLED ? PEER_MAP_TARGET : '_blank';
    siblingLink.href = PEER_MAP_INSTALLED ? peerMapURL(null) : PEER_MAP_PAGE;
    if (PEER_MAP_INSTALLED) siblingLink.removeAttribute('title');
    else siblingLink.title = 'See where your peers are and what software they run';
  }
  // The peer count comes from SQLite and the block height from a Bitcoin
  // Core RPC call. Tying them together meant a single RPC hiccup (Core
  // restarting, still in IBD, a timeout) replaced a perfectly good peer
  // count with "connecting…" - reporting the app as broken when only the
  // one cosmetic value was missing.
  const el = document.getElementById('status');
  const parts = [s.network, `${s.live.total} peers connected`];
  el.textContent = parts.join(' · ');
  el.prepend(liveDot);
  // How often a block could not be credited to one peer, in the line that
  // already exists rather than a new one: Core's last_block has one-second
  // resolution, and when the block before arrived only a moment earlier two
  // peers match and neither is credited (relay-profiler.js). Counted rather
  // than claimed, and its own element because it needs explaining.
  if (s.unclearFirsts) {
    const unclear = document.createElement('span');
    unclear.className = 'status-ties';
    unclear.textContent = ` · ${s.unclearFirsts.unclear.toLocaleString('en-US')} unclear`
      + ` in ${s.unclearFirsts.races.toLocaleString('en-US')} ${s.unclearFirsts.races === 1 ? 'block' : 'blocks'}`;
    unclear.title = 'The block before arrived only a moment earlier, often right after a restart,'
      + " so who delivered which one can't be told apart. Neither peer gets the First.";
    el.appendChild(unclear);
  }

  setBlockHeight(s.blockHeight);

  // The whole history behind the table below, in four numbers: how many
  // outbound peers Core has handed this node, how many stayed long enough to
  // be judged, how many ever delivered a block first, how many were kept.
  // Counted by IP, so a host that reconnected or was promoted under a second
  // address counts once. The table underneath shows ten peers right now; this
  // says what those ten are a sample of.
  const funnel = document.getElementById('outbound-funnel');
  if (funnel) {
    const f = s.outboundFunnel;
    funnel.textContent = f
      ? `${f.seen} seen · ${f.tested} tested · ${f.delivered} delivered · ${f.promoted} kept`
      : '';
  }

  // The last field is the colour strip along the tile's foot, in the group's
  // own colour. Outbound leaves out the manual peers, which have a tile of
  // their own - as in Peer Map, so the three groups add up to the total.
  // Full relay and block relay are told apart in the Outbound table below.
  const stats = [
    ['Total', s.live.total, ''],
    ['Inbound', s.live.inbound, 'inbound'],
    ['Outbound', s.live.outbound - s.live.manual, 'outbound'],
    ['Manual', s.live.manual, 'manual', `of ${MAX_MANUAL_PEERS}`],
  ];
  document.getElementById('live-stats').innerHTML = stats
    .map(([label, n, k, sub]) => `<div class="stat${k ? ' s-' + k : ''}"><div class="l">${label}</div><div class="n">${n}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`)
    .join('');
}

// Shared by the status poll and the live block event, so whichever learns of
// a new height first can show it. Never moves the number backwards: the two
// sources race on every block, and the poll can be answering with the
// previous height at the moment the event arrives with the new one.
function setBlockHeight(height) {
  const heightEl = document.getElementById('block-height-number');
  // The height is Core's own getblockcount, so it is there from the first
  // status response - it does not wait for a block. Null means Core did not
  // answer, and until one ever does, the slot says so in small type rather
  // than showing a big dash that reads as a fault in this app. The markup
  // starts as "–" instead: that is the fraction of a second before the first
  // response, which is not the same thing as no answer.
  if (height == null) {
    if (lastKnownHeight == null) {
      heightEl.textContent = 'no answer from Bitcoin Core yet';
      heightEl.classList.add('waiting');
    }
    return;
  }
  if (lastKnownHeight != null && height < lastKnownHeight) return;

  heightEl.classList.remove('waiting');
  heightEl.textContent = height.toLocaleString('en-US');
  if (lastKnownHeight != null && height > lastKnownHeight) {
    heightEl.classList.remove('bump');
    void heightEl.offsetWidth; // restart the animation
    heightEl.classList.add('bump');
  }
  lastKnownHeight = height;
}

// Who mined the block that just landed. Three states, and the difference
// matters: a pool we recognise gets its name, an unknown miner gets the
// text he wrote into his own coinbase (in quotes, so it never reads as a name
// we are vouching for), and a block that says neither reads Unknown - as on
// mempool.space - once its coinbase has been read.
function setBlockPool(race) {
  const el = document.getElementById('block-pool');
  if (!el) return;
  const known = race && race.pool;
  const raw = race && !known && race.poolTag ? race.poolTag : null;
  const unknown = race && !known && !raw && race.poolSource === 'none';
  el.classList.toggle('raw', Boolean(raw));
  el.textContent = '';
  if (known || raw || unknown) {
    const name = document.createElement('b');
    name.textContent = known ? (race.poolName || race.pool) : raw ? `"${raw}"` : 'Unknown';
    el.append('mined by ', name);
    el.title = known ? `Mined by ${race.poolName || race.pool}, from the block's coinbase`
      : raw ? 'No pool we know of. This is the text the miner wrote into the block.'
        : 'No pool we know of, and no name in the block.';
  } else {
    el.removeAttribute('title');
    // A new block comes without its pool: the coinbase is read a few seconds
    // later. Once the line has been there it keeps its height meanwhile -
    // gone and back, it moved the page twice under a reader at the bottom
    // (iPhone, 04.11.2026).
    if (!el.hidden) el.textContent = '\u00a0';
  }
  if (known || raw || unknown) el.hidden = false;
}

function triggerBlockWave() {
  const wave = document.getElementById('block-wave');
  wave.classList.remove('roll');
  void wave.offsetWidth; // restart the CSS animation
  wave.classList.add('roll');
}

// Called with the payload of a `block` event from /api/events (and once on
// connect with the current state), so this no longer fetches anything.
function applyBlockUpdate(race) {
  if (!race) return;

  // The height rides along on this event. Reading it here is what keeps the
  // big number in step with the wave and the highlighted rows - it used to
  // wait for the next 20-second status poll, so it jumped at a moment
  // unrelated to anything the viewer had just seen. Nullable in the schema
  // (it is backfilled by a separate RPC after the race is recorded), so only
  // set it when it is actually there.
  if (race.blockHeight != null) setBlockHeight(race.blockHeight);
  setBlockPool(race);

  const isNewRace = lastRaceId !== null && race.id !== lastRaceId;
  lastRaceId = race.id;
  if (!isNewRace) return;

  triggerBlockWave();
  const expiry = Date.now() + HIGHLIGHT_MS;
  // Only the newest block's peers are tinted: a second block inside the two
  // minutes left two orange rows, and which one brought the new block was a
  // guess (05.11.2026).
  highlightUntil.clear();
  for (const peer of race.firstPeers) highlightUntil.set(peer.address, expiry);
  refreshPeers();
}

// address -> "row-first-block" if still within its highlight window, pruning
// expired entries as we go (cheap - the map only ever holds recent misses).
// Two different marks that must not be confused: row-first-block is "this peer
// delivered the block that just landed" and fades on its own; row-focus is
// "another app asked about this one" and stays until the page is left.
function rowClassFor(address) {
  const classes = [highlightClassFor(address)];
  if (FOCUS_ADDRESS && address === FOCUS_ADDRESS) classes.push('row-focus');
  return classes.filter(Boolean).join(' ');
}

// Somebody arrived from Peer Map asking about one peer. Put it in front of them
// once, and only once - the tables re-render every twenty seconds.
// On a phone the page is still changing when the row first exists: the tables
// turn into cards and the panels above fill in, and a smooth scroll aimed at
// the first position ended far from the row. So jump
// once the layout has settled, and for a few seconds keep the row in the middle
// while things above it move - until the reader scrolls or touches the page.
const FOCUS_HOLD_MS = 4000;
function scrollToFocusOnce() {
  if (!FOCUS_ADDRESS || focusDone) return;
  if (!document.querySelector('tr.row-focus')) return;
  focusDone = true;
  // A card the reader folded is opened for this visit, not for good: the
  // peer asked for is in it, and a reload keeps it folded as before.
  const shut = document.querySelector('tr.row-focus').closest('section.card.folded');
  if (shut) {
    shut.classList.remove('folded');
    shut.querySelector(':scope > h2')?.setAttribute('aria-expanded', 'true');
    fitTables();
  }
  const until = Date.now() + FOCUS_HOLD_MS;
  let readerMoved = false;
  const listening = new AbortController();
  const stop = () => { readerMoved = true; listening.abort(); };
  for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) window.addEventListener(ev, stop, { passive: true, signal: listening.signal });
  const place = () => {
    if (readerMoved) return;
    const row = document.querySelector('tr.row-focus');
    if (row) {
      const r = row.getBoundingClientRect();
      const off = r.top + r.height / 2 - window.innerHeight / 2;
      if (Math.abs(off) > 40) {
        window.scrollTo(0, window.scrollY + off);
        // Our own jump, not the clamp the observer below undoes.
        lastScrollY = window.scrollY;
        notePlace();
      }
    }
    if (Date.now() < until) setTimeout(place, 250);
    else listening.abort();
  };
  requestAnimationFrame(() => requestAnimationFrame(place));
}

function highlightClassFor(address) {
  const expiry = highlightUntil.get(address);
  if (expiry == null) return '';
  if (expiry <= Date.now()) {
    highlightUntil.delete(address);
    return '';
  }
  return 'row-first-block';
}

// Trusted/manual peers show "Remove" (forgets the peer AND force-disconnects
// it - see peer-sync.js removeTrustedPeer) instead of "Add as Manual", and no
// Disconnect, in every table: as long as a peer is still addnode'd, Core
// reconnects it within a minute or two, so a bare Disconnect changed nothing
// that lasted. The Live Peer Ranking used to offer it anyway, to force a
// reconnect; Core does that by itself when a connection really hangs.
//
// Both actions always render into a fixed two-slot layout (primary action,
// then Disconnect) using an empty placeholder - never an omitted element -
// for whichever slot doesn't apply to a given row. Without this, a row
// missing its first slot (e.g. a source-obscured peer with no "Add as
// Manual") would have Disconnect visually collapse into the first slot's
// position instead of staying put, making the column misalign row to row.
// The lock: closed means this peer keeps its slot - a person adding a peer to
// a full set never displaces it, and it is not removed when it goes offline.
// Both the state and the control, because they are the same thing to the
// person looking at it. A lock on its own explains nothing, so the title says
// in words what it does and what clicking will do next.
function keepStar(p) {
  const on = Boolean(p.kept);
  const title = on ? 'Kept - click to release' : 'Click to keep';
  return `<button class="keep-star${on ? ' on' : ''}" data-action="keep" data-address="${escapeHtml(p.address)}" data-kept="${on ? '1' : '0'}" title="${title}" aria-pressed="${on}"><span aria-hidden="true">🔒</span><span class="sr-only">Keep this peer</span></button>`;
}

// A manual peer's Remove takes the second slot, under Disconnect, in every
// list: the red buttons stand in one line, the blue Add as Manual in the
// other. In the manual list the lock sits in the first slot.
function actionsCell(p, { lock = '' } = {}) {
  const placeholder = `<span class="action-slot" aria-hidden="true"></span>`;

  // Three kinds of peer have nothing this app can do to them, and all three
  // now look the same here: an empty slot.
  //
  // A source-obscured peer's "address" is Docker's own relay gateway, not the
  // peer's real one (see queries/ranking-row.js). A local Umbrel app is not a peer worth
  // acting on. And a Tor, I2P or CJDNS peer reaches us over a network this
  // container cannot dial out on, so there is no address to call back.
  //
  // The third used to print "Tor only" where the button goes, which was a
  // word about the peer standing in a place that is otherwise a reason, and
  // said Tor twice in a row that already begins "Tor peer". The explanation
  // moved to that cell's own tooltip, which is where someone wondering about
  // the row will already be pointing.
  //
  // What must NOT come back is the button: it used to be offered here and
  // always failed with "no node answering on 8333 or 9333", which reads as
  // though the peer had the wrong port open rather than the truth, which is
  // that this container has no way to reach that network at all.
  const remove = `<button class="secondary danger action-slot" data-action="untrust" data-address="${escapeHtml(p.address)}">Remove</button>`;
  if (p.trusted) return (lock ? `<span class="action-slot lock-slot">${lock}</span>` : placeholder) + remove;
  // A peer that can never deliver a block first ("never first") would only
  // hold a manual slot the rotation then has to free again; a disguised one
  // is not to be trusted with it.
  const disguised = p.mapKind === 'Disguised' || p.mapLion || kindRuleIndex(p.client) === MISSPELT_RULE;
  const primary = ((p.sourceObscured || p.localUmbrelPeer || p.privateNetwork || disguised || (neverFirstReason(p) && !p.first))
      ? placeholder
      : `<button class="secondary action-slot" data-action="add-manual" data-address="${escapeHtml(p.address)}">Add as Manual</button>`);

  // Disconnect still works fine for a source-obscured peer: it's exactly
  // the (masked) address Core itself uses internally for the connection.
  // A local Umbrel peer (another app on this same host, e.g. electrs) is
  // different - deliberately disconnecting it could interrupt whatever that
  // app is doing, and Core would likely just let it right back in anyway,
  // so there's no real action to offer there either.
  const canDisconnect = p.live && !p.localUmbrelPeer;
  const disconnect = canDisconnect
    ? `<button class="secondary danger action-slot" data-action="disconnect" data-address="${escapeHtml(p.address)}">Disconnect</button>`
    : placeholder;

  return `${primary}${disconnect}`;
}

// Who a peer is, readably (09.11.2026): a raw user agent, cut short, named
// nobody - "/dsn.tm.kit.edu/bitcoin:0.…" - and 22 wallets that call
// themselves /Satoshi:…/ read as Core. Peer Map's word comes first, as it
// goes by what the peer does; without it, the user agent shortened. The raw
// agent stays on hover and on an opened card.
//
// Its parts: a red word in front for a disguise (Disguised, LinkingLion -
// red as in Peer Map; it may still deliver, the First % beside it says
// whether), then the name.

// "/Satoshi:28.0.0(FutureBit-Apollo-Node)/" -> "Core 28.0.0",
// "/Satoshi:29.2.0/Knots:20260507/" -> "Knots 29.2.0",
// "/electrs:0.11.1/" -> "electrs 0.11.1"; anything else without its slashes.
function shortClient(ua) {
  const m = /^\/Satoshi:([0-9][0-9.]*)(?:\([^)]*\))?\/(?:([A-Za-z][\w ]*):[^/]*\/)?/.exec(ua);
  if (m) return `${m[2] ? m[2].replace(/^LibreRelay$/, 'Libre Relay') : 'Core'} ${m[1]}`;
  return bareAgent(ua);
}
// The agent as it is, only without its slashes: what a client nobody has
// named yet is called.
function bareAgent(ua) {
  return ua.replace(/^\/|\/$/g, '').split('/').map((part) => part.replace(':', ' ')).join(' / ');
}

// No agent stored: either the peer sent an empty one, or - for its first
// seconds, before it has answered a ping - it has not said anything yet.
function ownName(p) {
  if (p.client) return shortClient(p.client);
  if (!p.live) return '-';
  return p.minPingMs == null && (p.currentSessionMs ?? 0) < 60000 ? 'connecting\u2026' : 'no user agent';
}

function clientName(p) {
  const ua = p.client;
  const own = ownName(p);
  if (p.localUmbrelPeer) return { name: ua ? own : p.localAppName || own };
  if (p.mapLion) return { word: 'LinkingLion', bad: true, name: p.mapWhy || "on 0xB10C's list" };
  if (p.mapKind === 'Disguised') return { word: 'Disguised', bad: true, name: p.mapWhy || own };
  if (p.mapKind === 'Pool node') {
    const label = p.mapLabel || 'pool node';
    if (!p.mapPool) return { name: p.mapLabel || 'Pool node' };
    return { name: label.includes(p.mapPool) ? label : `${p.mapPool} \u00b7 ${label.charAt(0).toLowerCase()}${label.slice(1)}` };
  }
  if (p.mapKind && p.mapKind.startsWith('Node')) {
    if (p.mapFork) return { name: `${own} \u00b7 ${p.mapFork}` };
    return { name: p.mapLabel || own };
  }
  if (p.mapKind === 'No user agent') return { name: `no user agent${p.mapWhy || p.mapLabel ? ` \u00b7 ${(p.mapWhy || p.mapLabel).toLowerCase()}` : ''}` };
  if (p.mapKind) {
    // The name where the label does not carry it: "Brno University of
    // Technology", not "Probably a university"; "KIT network monitoring".
    const named = p.mapName && !(p.mapLabel || '').toLowerCase().includes(p.mapName.toLowerCase());
    const name = (named ? p.mapName : p.mapLabel) || p.mapWhy || own;
    return { name: p.mapFork ? `${name} \u00b7 ${p.mapFork}` : name };
  }
  // No word from Peer Map (not installed, or the peer is newer than its
  // last answer): what the name alone gives away.
  const i = kindRuleIndex(ua);
  if (i === MISSPELT_RULE) return { word: 'Disguised', bad: true, name: 'misspelt name' };
  if (i === POOL_RULE) return { name: `Pool node \u00b7 ${own}` };
  return { name: own };
}

// A second part (" · ") stays only where it fits whole, as in Peer Map, and
// after a red word the reason only where it fits at all - "Disguised" alone
// says more than "Disguised · offers no s…". fitSeconds decides.
// LinkingLion is 0xB10C's name and list: the word leads there.
const LION_PAGE = 'https://b10c.me/observations/06-linkinglion/';
function clientHtml(p) {
  const c = clientName(p);
  const parts = c.name.split(' \u00b7 ');
  // Peer Map's "Probably …" names can go without the word where they would
  // be cut: "Wasabi or Ginger" rather than "Probably Wasabi or Gi…".
  const one = parts.length > 1 ? parts[0] : c.name.replace(/^Probably /, '');
  const fit = one !== c.name || c.word
    ? ` data-full="${escapeHtml(c.name)}" data-one="${escapeHtml(one)}"${c.word ? ' data-word="1"' : ''}` : '';
  const word = c.word === 'LinkingLion'
    ? `<a class="lion-link" href="${LION_PAGE}" target="_blank" rel="noopener noreferrer" title="Tracked by 0xB10C">${c.word}</a>`
    : escapeHtml(c.word || '');
  return (c.word ? `<span class="kind-tag${c.bad ? ' disg' : ''}">${word}<span class="sep"> \u00b7 </span></span>` : '')
    + `<span class="cname"${fit}>${escapeHtml(c.name)}</span>`;
}

// The raw agent on hover: always, not only when the name is cut.
function clientCell(p) {
  const title = p.client ? ` title="${escapeHtml(p.client)}"` : '';
  return `<td class="cell-truncate client"${title}>${clientHtml(p)}</td>`;
}

// Session column: current connected duration when live, otherwise how long
// a trusted peer has been offline. Core keeps trying to reconnect a manual
// peer on its own, but that can silently stall (peer went dark, network
// hiccup, slot contention) - a flat "OFFLINE" pill doesn't say
// whether that happened 30 seconds or 3 days ago, so show the duration
// instead of just '-'.
function sessionCell(p) {
  if (p.live) return `<td>${fmtDuration(p.currentSessionMs)}</td>`;
  if (p.offlineSinceMs != null) {
    // The OFFLINE pill in the same row already says it; the cell keeps to the
    // duration, so it fits one line like every other session.
    const d = fmtDuration(p.offlineSinceMs);
    return `<td class="hint" title="offline for ${escapeHtml(d)}">${escapeHtml(d)}</td>`;
  }
  return `<td>-</td>`;
}

/**
 * The rate over the window the ranking actually sorts by - not the lifetime
 * rate it used to show.
 *
 * Showing one number in a table ordered by a different one made the order look
 * broken, and there was no way to check it from the page: two manual peers sat
 * at 21.2% and 37.5%, in that order, because over the last five hundred blocks
 * they were 33.8% and 33.4% - level, and in exactly the order shown. The
 * deciding number appeared nowhere.
 *
 * The lifetime rate is not dropped: it is in the cell's tooltip, and in the
 * slot fill log. It is still the right number for what a peer has been worth
 * over its life, and it is still what the offline grace is scaled by - so the
 * log keeps showing it.
 */
function firstPctCell(p) {
  // A peer that cannot deliver a block reads "never first" instead of its
  // 0.0% - unless it did deliver one after all (software that names itself a
  // wallet and relays anyway): then its number, as for every other peer.
  const never = neverFirstReason(p);
  if (never && !p.first) return `<td title="${escapeHtml(neverFirstTitle(never))}"><span class="never">never first</span>${hbMark(p)}</td>`;
  const windowed = p.recentEligible > 0;
  const pct = windowed ? (100 * p.recentFirst) / p.recentEligible : p.firstPct;
  const counts = windowed ? `${p.recentFirst}/${p.recentEligible}` : `${p.first}/${p.eligible}`;
  // The lifetime rate only on hover, once there is more lifetime than window:
  // a second number in every cell was noise in a table sorted by the first.
  const lifetime = windowed && p.eligible > p.recentEligible;
  // Without a block in the window the cell holds the lifetime rate, under a
  // heading that says "last N": the tooltip says which it is.
  const title = lifetime ? `Lifetime: ${fmtPct(p.firstPct)} (${p.first} of ${p.eligible} blocks first)`
    : !windowed && p.eligible > 0 ? `Lifetime: not connected for any of the last ${RECENT_WINDOW_BLOCKS || 'recent'} blocks` : '';
  return `<td${title ? ` title="${escapeHtml(title)}"` : ''}><span class="pct">${fmtPct(pct)}</span>&nbsp;<span class="cnt">${counts}</span>${hbMark(p)}</td>`;
}

// The network note under Outbound Peers used to get a live count of Tor/I2P
// peers appended to it. Removed: the note is advice about a setting, and the
// peers it talks about are already named as Tor or I2P in their own address
// cell, with the reason in that cell's tooltip. A sentence repeating that
// above the table said the same thing twice.

const LIVE_PEER_LIMIT = 10;
let showAllLivePeers = false; // toggled by #live-peer-limit-toggle

// The log is a diary, and a diary is mostly interesting at the end: the four
// most recent rows answer "what changed lately". The rest of what the server
// keeps - thirty - is behind "Show all".
const ROTATION_LOG_LIMIT = 4;
let showAllLog = false; // toggled by #rotation-log-toggle
// A reload keeps what was opened, like the scroll position: "Show all" stays.
const OPENED_KEY = 'opened:' + location.pathname;
try {
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav && (nav.type === 'reload' || nav.type === 'back_forward')) {
    const o = JSON.parse(sessionStorage.getItem(OPENED_KEY) || 'null');
    if (o) { showAllLivePeers = !!o.live; showAllLog = !!o.log; }
  }
  const keep = () => { try { sessionStorage.setItem(OPENED_KEY, JSON.stringify({ live: showAllLivePeers, log: showAllLog })); } catch { /* private window */ } };
  window.addEventListener('pagehide', keep);
  document.addEventListener('visibilitychange', () => { if (document.hidden) keep(); });
} catch { /* no storage: nothing to keep */ }

// Smooth scrolling, unless the reader asked the system for less motion.
function glide() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

// Folding in place (10.11.2026): what was tapped stays where it is on the
// screen. What opens rolls out downwards and what closes rolls up, gently,
// and the page never jumps - not to bring something into view, not because
// the page got shorter at its end. Every fold goes through here: a card, a
// peer's card, "Show all", a "How it works", so they all behave alike.
//
//   anchor  what stays put (what was tapped, or what is above the change)
//   box     what grows or shrinks
//   set     puts the page in the open (true) or closed (false) state
const FOLD_MS = 300;
let folding = 0;
// Room below the page's end while something shrinks there: a page that got
// shorter under the reader would otherwise pull everything down with it. It
// goes as soon as the reader scrolls up far enough not to need it.
let runway = 0;
function setRunway(px) {
  runway = Math.max(0, Math.ceil(px));
  document.body.style.paddingBottom = runway ? `${runway}px` : '';
}
window.addEventListener('scroll', () => {
  if (!runway || folding) return;
  const spare = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
  if (spare > 0) setRunway(runway - spare);
}, { passive: true });

function foldInPlace({ anchor, box, set, open }) {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches || !box || !box.animate;
  const top0 = anchor.getBoundingClientRect().top;
  // To where, not by how much: Safari reports a scroll a frame late, and
  // moving by the difference moved twice and swung back and forth.
  const pin = () => {
    // A row redrawn under the fold is gone from the page and says it is at
    // the top: following it would throw the reader up by a screen.
    if (!anchor.isConnected) return;
    const want = anchor.getBoundingClientRect().top + window.scrollY - top0;
    if (Math.abs(window.scrollY - want) >= 0.5) window.scrollTo(0, want);
  };
  folding += 1;
  // Room at the end for as much as the box could lose, lent before anything
  // is measured: measuring a page that got shorter is already enough for the
  // browser to pull everything down. When the fold is over, only what the
  // reader still needs stays.
  const lent = runway;
  const h0 = box ? box.getBoundingClientRect().height : 0;
  if (box) setRunway(lent + h0);
  const giveBack = () => {
    const end = document.documentElement.scrollHeight - runway;
    setRunway(Math.max(lent, window.scrollY + window.innerHeight - end));
  };
  // The place-keeping of a refresh waits a frame more: the last changes of a
  // fold reach it after the fold has pinned the anchor, and it would move the
  // page by the top of the window instead.
  const done = () => { pin(); giveBack(); pin(); requestAnimationFrame(() => {
    pin(); folding -= 1; notePlace();
    // A refresh that came in while it rolled waited for it.
    if (!folding) setTimeout(flushDeferredRenders, 0);
  }); };
  // Fitted before it is measured: re-rendered rows are cards only once
  // fitTables has run, and the end of the roll would be off by that.
  const settle = (state) => { set(state); fitTables(); fitSeconds(); fitPct(); };
  // A fold that fails half way must not leave the page thinking it is
  // still folding: the runway and the place-keeping would stay off.
  try { settle(open); } catch (err) { folding -= 1; throw err; }
  const h1 = box ? box.getBoundingClientRect().height : 0;
  // A whole list of peers is tens of thousands of pixels: rolled in a third
  // of a second that rushes past at a screen per frame. That opens and shuts
  // in place at once, the rows fading in.
  const huge = Math.abs(h1 - h0) > window.innerHeight * 1.5;
  if (huge && open && !still && box.animate) box.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  if (still || huge || Math.abs(h1 - h0) < 2) { pin(); done(); return; }
  // Closing rolls up what is still there: back to open for the animation,
  // closed at its end.
  if (!open) settle(true);
  const anim = box.animate([{ height: `${h0}px`, overflow: 'hidden' }, { height: `${h1}px`, overflow: 'hidden' }],
    { duration: FOLD_MS, easing: open ? 'cubic-bezier(.2,.7,.3,1)' : 'cubic-bezier(.5,0,.3,1)' });
  let frame = requestAnimationFrame(function follow() { pin(); frame = requestAnimationFrame(follow); });
  anim.onfinish = anim.oncancel = () => {
    cancelAnimationFrame(frame);
    try { if (!open) settle(false); } finally { done(); }
  };
}

// A peer that was not there at the last refresh lights up once, so what
// changed since the last look is seen without searching. Not on the first
// load: then everything would be new.
const arrivedAt = new Map();
let knownAddresses = null;
function markArrivals(ranking) {
  const now = Date.now();
  const seen = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.address === 'string') seen.add(v.address);
      else Object.values(v).forEach(walk);
    }
  };
  walk(ranking);
  if (knownAddresses) for (const a of seen) if (!knownAddresses.has(a)) arrivedAt.set(a, now);
  for (const [a, t] of arrivedAt) if (now - t > 3000 || !seen.has(a)) arrivedAt.delete(a);
  knownAddresses = seen;
}
let lastRotationLog = null; // kept so "Show all" can open without refetching

// The most recent ranking payload, kept so purely visual changes (the "show
// all" toggle) can re-render from it instead of re-fetching the single most
// expensive endpoint this app has just to slice the same array differently.
let lastPeerRanking = null;

// Several things ask for the ranking at once (the poll, a new block, an
// action just taken); an answer that left before a newer one must not be
// drawn over it - a lock just closed would open again for twenty seconds.
let peerRequestSeq = 0;
async function refreshPeers() {
  const seq = ++peerRequestSeq;
  const peers = await api('/api/peers/ranking');
  if (seq !== peerRequestSeq) return;
  lastPeerRanking = peers;
  markArrivals(peers);
  renderPeerTables(peers);
}

// A peer that connected in over IPv6 through Docker's docker-proxy relay
// (rather than a direct/NAT-preserved connection) has its real address
// replaced by Core with Docker's own internal gateway - showing that raw
// address would just be confusing/misleading, since it looks like a real
// peer IP but isn't and can't be acted on (see actionsCell). Label it
// honestly instead.
// The client again, as a second line under the address: shown once a narrow
// table has given up the Client column, and on the phone cards (style.css,
// .addr-client) - so the name stays on screen to the end.
function withClientLine(cell, p) {
  // Never left out: a card without it was a line shorter than the rest. An
  // opened card shows the raw agent under it, where nothing can be hovered -
  // unless the name is that agent already, only without its slashes.
  // Broken only after a slash where it is too long: "/bitcoinj:0.14.5/" and
  // "Bitcoin Wallet:5.43/", not "…0.9." and "99/".
  const raw = p.client && clientName(p).name !== bareAgent(p.client) ? `<span class="ua-raw">${escapeHtml(p.client).replace(/\//g, '/<wbr>')}</span>` : '';
  // On a touch screen a tap on the address opens the card, as in Peer Map,
  // and the way over is said out loud inside it.
  const over = TOUCH_ONLY && cell.includes('class="peer-jump"')
    ? `<a class="map-open" href="${escapeHtml(peerMapURL(p.address))}" target="${PEER_MAP_TARGET}" title="Open this peer in Peer Map">Peer Map \u2197</a>` : '';
  return cell.replace(/<\/td>$/, () => `<small class="addr-client">${clientHtml(p)}${raw}</small>${over}</td>`);
}

// Flags as Peer Map draws them: regional-indicator letters from the country
// code, no image files; Tor an onion, I2P a globe.
const HIDDEN_FLAG = { TOR: '\u{1F9C5}', I2P: '\u{1F310}' };
const flagOf = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
let countryNames = null;
function countryName(cc) {
  try {
    countryNames = countryNames || new Intl.DisplayNames(['en'], { type: 'region' });
    return countryNames.of(cc) || cc;
  } catch {
    return cc;
  }
}

// Where a manual peer is, as one more line under its address: flag and
// provider, or Tor / I2P. The rotation spreads the slots by exactly this, so
// it is shown where the slots are. Country and region are in the tooltip.
function placeHtml(w) {
  const flag = HIDDEN_FLAG[w.region] || flagOf(w.country);
  const text = w.country ? (w.operator || countryName(w.country)) : w.regionName;
  return `<span class="flag">${flag}</span>${escapeHtml(text)}`;
}
function withPlaceLine(cell, p) {
  const w = p.where;
  if (!w) return cell;
  const tip = w.country ? `${countryName(w.country)}, ${w.regionName}` : w.regionName;
  return cell.replace(/<\/td>$/, () => `<small class="addr-place" title="${escapeHtml(tip)}">${placeHtml(w)}</small></td>`);
}

// "Europe 3 · North America 1 · Tor 1", most first.
function spreadSummary(peers) {
  const counts = new Map();
  for (const p of peers) if (p.where) counts.set(p.where.regionName, (counts.get(p.where.regionName) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(' · ');
}

function addressCell(p) {
  if (p.sourceObscured) {
    return `<td class="cell-truncate hint" title="Inbound IPv6 passes through Docker, which puts its own address in place of the peer's.">IPv6 peer (address hidden by Docker)</td>`;
  }
  // Not a real external peer at all - another app on this same Umbrel host
  // (electrs, mempool's indexer, etc.) connecting to Core's P2P port
  // directly. The address is genuinely accurate here (unlike sourceObscured
  // above), so it's shown in the tooltip for anyone curious, but the label
  // itself is far more useful than a bare internal Docker IP.
  // Where it comes from, as an address says it: which app is the client line
  // below, and UMBREL APP the pill - said three times before (09.11.2026).
  if (p.localUmbrelPeer) {
    const app = p.localAppName ? ` (${p.localAppName})` : '';
    return `<td class="cell-truncate hint" title="${escapeHtml(p.address)} - another app container${escapeHtml(app)} on this Umbrel connecting to Bitcoin Core's P2P port directly, not an external peer.">this Umbrel</td>`;
  }
  // A Tor / I2P / CJDNS peer that dialled in reaches Core through this
  // Umbrel's own proxy container, so the address Core reports belongs to that
  // container, not to the peer. It used to be shown raw, which named a
  // neighbour of ours and said nothing about the peer - the word Tor appeared
  // only as a note in the actions column, at the far end of the row.
  if (p.proxiedPrivatePeer) {
    return `<td class="cell-truncate hint" title="Core only sees your own ${escapeHtml(p.privateNetwork)} proxy, not the peer. It still ranks, but cannot be made a manual peer.">${escapeHtml(p.privateNetwork)} peer</td>`;
  }
  // With Peer Map installed the address becomes the way over: same peer, the
  // other question. Without it, a plain cell - no dead links.
  if (PEER_MAP_INSTALLED) {
    const safe = escapeHtml(p.address);
    return `<td class="cell-truncate" data-full="${safe}"><a class="peer-jump" href="${escapeHtml(peerMapURL(p.address))}" target="${PEER_MAP_TARGET}" data-tip="Open this peer in Peer Map" title="Open this peer in Peer Map">${safe}</a></td>`;
  }
  return truncatedCell(p.address);
}


/**
 * Re-rendering a table body wholesale destroys whatever the viewer was in the
 * middle of: the keyboard focus (so tabbing restarts at the top), any text
 * selection (so copying an address fails if a poll lands mid-drag) and, worst,
 * a click - if the row is replaced between mousedown and mouseup the browser
 * finds no shared element and fires no click at all, so the button silently
 * does nothing. With "Add as Manual" taking up to six seconds of port probing,
 * a 20-second poll landing inside that window is routine rather than exotic.
 *
 * So: while an action is in flight or the focus is inside one of these tables,
 * hold the newest data instead of rendering it, and render as soon as the
 * interaction is over. Nothing is lost - only the newest snapshot is kept.
 */
let actionsInFlight = 0;
const deferredRenders = new Map();

// A press in progress: a row replaced between mousedown and mouseup gets no
// click. Kept as a time, not a flag, so a press that never ends (released
// outside the window) cannot hold the tables for longer than two seconds.
let pressedAt = 0;
const pressing = () => pressedAt > 0 && Date.now() - pressedAt < 2000;
document.addEventListener('pointerdown', () => { pressedAt = Date.now(); }, true);
const pressOver = () => { pressedAt = 0; setTimeout(flushDeferredRenders, 0); };
// On touch the click comes after pointerup, as a task of its own: flush on
// the click, with pointerup only as the fallback when no click follows.
document.addEventListener('click', pressOver);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => setTimeout(() => { if (pressedAt) pressOver(); }, 400), true);
}
window.addEventListener('blur', pressOver);

// A finger on the glass or a page still gliding: a refresh redrawn under it
// moved the rows the reader was following, and the scroll correction that
// keeps their place cut Safari's glide short with a jolt (iPhone, 28.10.2026).
// The newest data waits until the page has been still for half a second.
let touching = 0;
let scrolledAt = 0;
let settleTimer = null;
const moving = () => (touching > 0 && Date.now() - touching < 15000) || Date.now() - scrolledAt < 500;
const settle = () => {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => (moving() ? settle() : flushDeferredRenders()), 520);
};
window.addEventListener('touchstart', () => { touching = Date.now(); }, { passive: true, capture: true });
for (const type of ['touchend', 'touchcancel']) {
  window.addEventListener(type, () => { touching = 0; settle(); }, { passive: true, capture: true });
}
window.addEventListener('scroll', () => { scrolledAt = Date.now(); settle(); }, { passive: true });

function interactionInProgress(selector) {
  if (actionsInFlight > 0 || folding > 0 || pressing() || moving()) return true;
  // Text being selected - an address to copy - is not redrawn from under the
  // reader, as in Peer Map. The sweep below lets it through in the end.
  if (String(window.getSelection && window.getSelection()).length) return true;
  // Keyboard focus only. A mouse click leaves the focus on the button in
  // Chrome, and the tables then stayed frozen until a click elsewhere.
  const active = document.activeElement;
  return Boolean(active && active.closest && active.closest(selector) && active.matches(':focus-visible'));
}

function deferRender(key, selector, render) {
  if (interactionInProgress(selector)) {
    deferredRenders.set(key, render);
    return true;
  }
  deferredRenders.delete(key);
  return false;
}

function flushDeferredRenders() {
  if (deferredRenders.size === 0) return;
  const pending = [...deferredRenders.values()];
  deferredRenders.clear();
  for (const render of pending) render();
}

document.addEventListener('focusout', () => {
  // After focus actually lands somewhere else, not while it is in transit.
  setTimeout(flushDeferredRenders, 0);
});

/**
 * One row of a peer table - the same eight cells for all three of them.
 *
 * The three tables share the exact same column set, order, and widths (see the
 * shared .col-* classes in the markup / style.css) so Address/Type/.../Actions
 * line up vertically across panels instead of each table sizing its columns
 * independently from its own content. That used to be three copies of the same
 * template, kept in step by hand and by a comment asking the next person to
 * remember; here it is a fact instead.
 *
 * They differ in exactly two things, which is what the two options are:
 *   status   the Outbound panel shows the connection type alone, because
 *            "MANUAL LIVE" in a table of live outbound peers is noise.
 *   actions  what may be done to this peer here - the live table alone offers
 *            Disconnect, and only the manual table carries the lock.
 */
// A peer that cannot deliver a block - software that does not relay, or a
// peer that offers no services at all, whatever it calls itself - reads
// "never first" in its First % cell (firstPctCell), and its pill and row are
// dimmed. Peer Map marks the same peers. The explanation lives in the
// tooltip, not in the table: a dashboard is not the place for a paragraph.
function neverFirstReason(p) {
  const chain = otherChainShown(p) ? `it is on a chain of its own (${otherChainShown(p)}), not yours` : null;
  const own = cannotRelayReason(p.client) || (p.offersNothing ? 'it offers no services' : null);
  // Peer Map's word where it has one: a "wallet" that offers blocks is a
  // disguise that may well pass them on, whatever its name says.
  if (p.mapKind) return p.mapNoRelay ? own || 'its software passes no blocks on' : chain;
  return own || chain;
}
const neverFirstTitle = (reason) => `Connected and counted, but ${reason} - it does not pass blocks on, so it can never deliver one first.`;
// ⚡ in the First % cell: one of the (at most three) peers Core lets send a new
// block straight away. Whoever holds such a place wins First far more easily,
// so it says why a peer is ahead, not only that it is.
const HB_TITLE = "One of Core's three high-bandwidth peers: it may send a new block without being asked first, which gives it a head start of at least one ping.";
// At the end of the First % cell: the Type column is too narrow for it next to
// the longest pill, and the ⚡ is often the reason the number is high.
// 📡 after it: the other way round, this peer has picked this node, so Core
// sends it new blocks without it asking. Says what the node gives, not why a
// peer is ahead, but it belongs next to ⚡: an outbound peer is often both.
const HB_FROM_TITLE = "This peer has picked your node as one of its three high-bandwidth peers: your node sends it new blocks without being asked first.";
function hbMark(p) {
  // The gap is the span's margin, not a space: on a phone card ⚡ and 📡
  // together were cut by two pixels (28.10.2026).
  return (p.hb ? `<span class="hb" title="${escapeHtml(HB_TITLE)}">⚡</span>` : '')
    + (p.hbFrom ? `<span class="hb" title="${escapeHtml(HB_FROM_TITLE)}">📡</span>` : '');
}

// Core's names for the two automatic outbound kinds, said as Peer Map and the
// tiles say them.
// TESTING: the slot fill's candidate, in its slot until Core has connected
// to it (peer-rotation/fill.js).
const STATUS_LABEL = { 'OUTBOUND-FULL-RELAY': 'FULL RELAY', 'BLOCK-RELAY-ONLY': 'BLOCK RELAY' };
const statusLabel = (status) => STATUS_LABEL[status] || status;

function statusPill(p, status) {
  const reason = neverFirstReason(p);
  if (!reason) return `<span class="pill ${statusPillClass(status)}">${statusLabel(status)}</span>`;
  return `<span class="pill ${statusPillClass(status)} norelay" title="${escapeHtml(neverFirstTitle(reason))}">${statusLabel(status)}</span>`;
}

// A row's buttons show when the row is opened - a tap, like a row in Peer
// Map - or, with a mouse, while the pointer is over it. Four hundred rows
// with two buttons each was a wall of red and blue on a phone (28.10.2026).
// One row open at a time; it is known by table and peer, so a refresh that
// rebuilds the rows keeps it open.
let openRow = null;
const rowId = (tr) => `${tr.closest('table').id} ${tr.dataset.key}`;
function markOpenRow() {
  for (const tr of document.querySelectorAll('tr.can-act')) {
    const open = rowId(tr) === openRow;
    tr.classList.toggle('open', open);
    tr.setAttribute('aria-expanded', String(open));
  }
  // An opened card's client line wraps and has room for every reason again.
  fitSeconds();
}
function toggleRow(tr) {
  const id = rowId(tr);
  foldInPlace({ anchor: tr, box: tr, open: openRow !== id, set: (open) => { openRow = open ? id : null; markOpenRow(); } });
}
document.addEventListener('click', (e) => {
  const tr = e.target.closest && e.target.closest('tr.can-act');
  // The address is too small a target for a finger: on a touch screen it
  // opens the card like a tap anywhere else (Peer Map does the same).
  const onAddress = TOUCH_ONLY && e.target.closest('a.peer-jump');
  if (tr && onAddress) e.preventDefault();
  else if (!tr || e.target.closest('button, a, input, label, select')) return;
  // A drag to select an address is not a tap.
  if (String(window.getSelection && window.getSelection()).length) return;
  toggleRow(tr);
});
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.matches || !e.target.matches('tr.can-act')) return;
  e.preventDefault();
  toggleRow(e.target);
});

// An app on this same Umbrel (electrs, Fulcrum, a Lightning node) connects to
// Core like any inbound peer, but it is the owner's own software, not a peer
// out on the network - so it gets a pill of its own instead of "INBOUND".
const UMBREL_APP = 'UMBREL APP';

function peerRow(p, { status = p.status, actions, place = false }) {
  if (p.localUmbrelPeer) status = UMBREL_APP;
  const weak = neverFirstReason(p) ? ' weak' : '';
  const canAct = actions.includes('data-action="add-manual"') || actions.includes('data-action="disconnect"') || actions.includes('data-action="untrust"');
  return `
    <tr data-key="${escapeHtml(p.address)}"${canAct ? ' tabindex="0"' : ''} class="${canAct ? 'can-act ' : ''}${rowClassFor(p.address)}${arrivedAt.has(p.address) ? ' arrived' : ''}${p.first > 0 && p.offlineSinceMs == null ? ' row-delivered' : ''}${weak}">
      ${withClientLine(place ? withPlaceLine(addressCell(p), p) : addressCell(p), p)}
      ${clientCell(p)}
      <td class="col-status" data-full="${escapeHtml(statusLabel(status))}">${statusPill(p, status)}</td>
      ${firstPctCell(p)}
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      ${sessionCell(p)}
      <td>${p.sessionsCount}</td>
      <td class="row-actions">${actions}</td>
    </tr>
  `;
}

// `force` skips the defer gate. That gate exists to stop a background poll
// destroying an interaction in progress - but the show-all toggle IS the
// interaction, and it was being blocked by it: "Add as Manual" holds
// actionsInFlight for up to six seconds of port probing, during which the
// button did nothing. Worse, a second click (the natural response) flipped the
// flag back and overwrote the deferred closure, so the button then did nothing
// at all. A user-initiated, purely local re-render must never be deferred.
// A peer just removed or disconnected stays in the server's data until the
// next connection snapshot (every 15 s) - up to half a minute with the page's
// own refresh. Leave it out of the tables straight away; once the server no
// longer lists it as connected or manual, forget it. If it is still there
// after the wait (the disconnect did not take), it shows again.
const GONE_MS = 40000;
// The page asks again just after Core's next connection snapshot has landed.
const GONE_RECHECK_MS = 17000;
const justGone = new Map(); // address -> time it was removed or disconnected
const recheckGone = () => setTimeout(() => refreshPeers().catch(() => {}), GONE_RECHECK_MS);

function renderPeerTables(peers, options = {}) {
  if (!options.force && deferRender('peers', '.peer-table', () => renderPeerTables(peers))) return;
  const now = Date.now();
  for (const [address, at] of justGone) {
    const row = peers.find((p) => p.address === address);
    if (now - at > GONE_MS || !row || (!row.live && !row.trusted)) justGone.delete(address);
  }
  if (justGone.size) peers = peers.filter((p) => !justGone.has(p.address));
  const livePeers = peers.filter((p) => p.live);
  // Manuals get their own dedicated panel below - keep them out of Outbound
  // entirely rather than showing the same peer in two tables.
  const outboundPeers = livePeers.filter((p) => p.direction === 'outbound' && !p.trusted);
  const manualPeers = peers.filter((p) => p.trusted);

  // The ranking table can get long with a lot of live peers - show only the
  // top LIVE_PEER_LIMIT (already sorted best-first by the API) by default,
  // with a toggle to see the rest on demand rather than always scrolling a
  // huge table.
  // A peer Peer Map pointed at may rank below the top ten - inbound peers
  // appear in no other table, so without this their row never existed and the
  // link landed on an unmarked page. Open the full list once for it.
  if (FOCUS_ADDRESS && !focusDone && !showAllLivePeers
      && livePeers.slice(LIVE_PEER_LIMIT).some((p) => p.address === FOCUS_ADDRESS)) {
    showAllLivePeers = true;
  }
  const visibleLivePeers = showAllLivePeers ? livePeers : livePeers.slice(0, LIVE_PEER_LIMIT);
  const limitToggle = document.getElementById('live-peer-limit-toggle');
  const countLabel = document.getElementById('live-peer-count');
  if (countLabel) {
    // How many peers take new blocks from this node first (📡), whatever the
    // table shows: it is about the node, not the visible rows.
    const fed = livePeers.filter((p) => p.hbFrom).length;
    countLabel.textContent = (livePeers.length <= LIVE_PEER_LIMIT
      ? `${livePeers.length} connected`
      : `showing ${visibleLivePeers.length} of ${livePeers.length} connected`)
      + (fed ? ` · 📡 ${fed} take new blocks from you first` : '');
  }
  const stickCount = document.getElementById('live-stick-count');
  if (stickCount) stickCount.textContent = ` · ${livePeers.length}`;
  liveStickOn();
  if (limitToggle) {
    if (livePeers.length <= LIVE_PEER_LIMIT) {
      limitToggle.hidden = true;
    } else {
      limitToggle.hidden = false;
      limitToggle.textContent = showAllLivePeers
        ? `Show top ${LIVE_PEER_LIMIT} only`
        : `Show all ${livePeers.length}`;
    }
  }

  document.querySelector('#peer-table tbody').innerHTML = visibleLivePeers
    .map((p) => peerRow(p, { actions: actionsCell(p) }))
    .join('') || `<tr><td colspan="8" class="hint">No peers currently connected.</td></tr>`;

  document.querySelector('#outbound-peer-table tbody').innerHTML = outboundPeers
    .map((p) => peerRow(p, { status: p.connectionStatus, actions: actionsCell(p) }))
    .join('') || `<tr><td colspan="8" class="hint">No non-manual outbound peers currently connected.</td></tr>`;

  // A slot is taken by a manual peer whether or not it happens to be
  // connected right now: Core keeps retrying an offline one and it still
  // counts against MAX_ADDNODE_CONNECTIONS. Counting only live peers showed
  // free slots that did not exist - and the rotation loop, which used the
  // same wrong count, kept promoting peers into them.
  const liveManualSlots = manualPeers.filter((p) => p.live).length;
  const freeManualSlots = Math.max(0, MAX_MANUAL_PEERS - manualPeers.length);
  // Free capacity (below the app's manual-connection cap) as actual empty
  // rows, not just the text summary below - "how much room is left" reads
  // the same way the filled rows above it do, at a glance. It says "Free
  // slot", as the phone card does: a lone dash per row looked broken
  // (04.11.2026). No banner, no border treatment.
  // One cell per column, like any row: a single cell spanning eight kept its
  // span when columns were dropped, and pushed the table out of line with the
  // ones above.
  const emptySlotRows = Array.from({ length: freeManualSlots }, () => `
    <tr class="empty-slot">
      <td>Free slot</td>${'<td></td>'.repeat(6)}
      <td class="row-actions"></td>
    </tr>
  `).join('');

  const manualRows = manualPeers
    .map((p) => peerRow(p, { actions: actionsCell(p, { lock: keepStar(p) }), place: true }))
    .join('');
  const noManualPeersHint = manualPeers.length === 0
    ? `<tr><td colspan="8" class="hint">No manual peers yet - use "Add as Manual" on a peer above, or the Add a Peer box to enter an address yourself.</td></tr>`
    : '';
  document.querySelector('#manual-peer-table tbody').innerHTML = manualRows + noManualPeersHint + emptySlotRows;
  markOpenRow();
  // Only now are the rows in the page; looking earlier found nothing on the
  // first render and moved the jump to the next refresh, twenty seconds on.
  scrollToFocusOnce();
  restoreReloadY();

  const slotsEl = document.getElementById('manual-slots');
  if (slotsEl) {
    // With the lock set by default on anything added by hand, every slot
    // being kept is the likely end state rather than an oddity - and it is
    // worth saying, because it means the rotation has nothing left to promote
    // into. Said as one more number, not as a warning: nothing is wrong.
    const keptCount = manualPeers.filter((p) => p.kept).length;
    const keptNote = keptCount > 0
      ? ` · ${keptCount === manualPeers.length ? 'all kept' : `${keptCount} kept`}`
      : '';
    slotsEl.textContent = `${freeManualSlots} of ${MAX_MANUAL_PEERS} slots free · ${liveManualSlots} connected · ${manualPeers.length} total${keptNote}`;
  }
  const spreadEl = document.getElementById('manual-spread');
  if (spreadEl) {
    const summary = spreadSummary(manualPeers);
    spreadEl.textContent = summary;
    spreadEl.hidden = !summary;
  }
}

// A counter, not a flag. A boolean only covered the time the POST was in
// flight, which left the real race wide open: a GET /api/rotation issued
// *before* the click comes back *after* the POST, carrying the pre-click
// value, and puts the checkbox back. The viewer then sees a green "rotation
// turned on" toast next to an unchecked box, while the server has it on - and
// the obvious reaction, clicking again, genuinely turns it off. Comparing the
// counter across the await discards any response that was already in flight
// when the state changed.
let rotationToggleEpoch = 0;

// Only ever the actions this app writes, and only as a class name from a fixed
// list. This was the single place in the file where a value went into
// innerHTML - into a class attribute AND the text - without escaping. Nothing
// a Bitcoin peer controls can reach it today, which is exactly the kind of
// reasoning that stops being true after a refactor.
const ROTATION_ACTIONS = new Set(['promote', 'retire', 'manual', 'disconnect']);
function rotationActionClass(action) {
  return ROTATION_ACTIONS.has(action) ? `rotation-${action}` : 'offline';
}

function rotationActionLabel(action) {
  // From Core's address book into a free slot, and Core connected to it.
  if (action === 'promote') return 'Added';
  // Offline past its grace: the slot is free for the next candidate.
  if (action === 'retire') return 'Removed';
  if (action === 'manual') return 'Added by hand';
  if (action === 'disconnect') return 'Disconnected by hand';
  return action;
}

async function refreshRotation() {
  const epochAtRequest = rotationToggleEpoch;
  const data = await api('/api/rotation');
  const toggle = document.getElementById('rotation-toggle');
  if (toggle && rotationToggleEpoch === epochAtRequest) toggle.checked = Boolean(data.enabled);
  foldSums();

  lastRotationLog = data.log || [];
  renderRotationLog(lastRotationLog);
}

// On a phone each entry is a card, and where and why are one grey line under
// the address; the table's own cells for them are hidden there
// (style.css).
function logCardLine(entry) {
  const parts = [
    entry.where ? placeHtml(entry.where) : '',
    entry.note ? escapeHtml(entry.note) : '',
  ].filter(Boolean);
  return parts.length ? `<small class="log-card-line">${parts.map((x) => `<span>${x}</span>`).join(' · ')}</small>` : '';
}

// Where the peer is goes under its address, as for the manual peers above.
function rotationEntryRow(entry) {
  const address = withPlaceLine(truncatedCell(entry.address), entry).replace(/<\/td>$/, () => `${logCardLine(entry)}</td>`);
  return `
    <tr>
      <td class="hint" title="${escapeHtml(new Date(entry.at).toLocaleString())}">${fmtDuration(Date.now() - entry.at)} ago</td>
      <td><span class="pill ${rotationActionClass(entry.action)}">${escapeHtml(rotationActionLabel(entry.action))}</span></td>
      ${address}
      <td class="hint"${entry.replacedAddress ? ` title="In for ${escapeHtml(entry.replacedAddress)}"` : ''}>${escapeHtml(entry.note || '-')}</td>
    </tr>`;
}

function renderRotationLog(log) {
  const tbody = document.querySelector('#rotation-log-table tbody');
  if (!tbody) return;

  const visible = showAllLog ? log : log.slice(0, ROTATION_LOG_LIMIT);
  tbody.innerHTML = visible.map((e) => rotationEntryRow(e)).join('')
    || `<tr><td colspan="4" class="hint">Nothing yet.</td></tr>`;

  const toggle = document.getElementById('rotation-log-toggle');
  if (toggle) {
    toggle.hidden = log.length <= ROTATION_LOG_LIMIT;
    toggle.textContent = showAllLog ? `Show latest ${ROTATION_LOG_LIMIT} only` : `Show all ${log.length}`;
  }
}

/**
 * Show the Stratum Race card as running or as off.
 *
 * Everything below the switch is hidden rather than greyed out, because
 * switched off there is nothing behind it that is still true: no pool is
 * connected and no race is being timed, so a table of numbers would be a
 * reading from an instrument that is not plugged in.
 *
 * Skipped while the switch has focus, so a poll landing between the click and
 * the server's answer cannot flip it back under the user's finger - the same
 * problem the peer tables solve with deferRender.
 */
function applyStratumEnabled(enabled) {
  const toggle = document.getElementById('stratum-toggle');
  if (!toggle) return;
  if (document.activeElement !== toggle) toggle.checked = enabled;
  foldSums();
  const body = document.getElementById('stratum-body');
  if (body) body.hidden = !enabled;
  const noMiner = document.getElementById('pool-no-miner');
  if (noMiner) noMiner.hidden = enabled;
}

async function refreshPools() {
  // Nothing to ask for while it is off, and nowhere to put the answer.
  if (document.getElementById('stratum-body')?.hidden) return;
  const range = document.querySelector('#stratum-range button.on')?.dataset.range || '10';
  // First, and on its own: the quick-fill buttons need the templates even if
  // the pool list below fails to load.
  refreshLocalPools();
  const pools = await api(`/api/pools?range=${encodeURIComponent(range)}`);
  renderPools(pools);
}

function renderPools(pools) {
  // Same guard as the peer tables: this one owns the enabled checkboxes, and
  // a poll landing on a just-clicked one puts it straight back.
  if (deferRender('pools', '#pool-table', () => renderPools(pools))) return;
  const tbody = document.querySelector('#pool-table tbody');
  if (!pools.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="hint">No pools yet.</td></tr>';
    foldSums();
    return;
  }
  tbody.innerHTML = pools.map((p) => `
    <tr data-key="pool:${p.id}" tabindex="0" class="can-act${p.enabled ? '' : ' pool-off'}">
      <td><b>${escapeHtml(p.label)}</b>${p.wonLastRace ? ' <span class="trophy" title="Won the most recent race">🏆</span>' : ''}${p.enabled ? '' : ' <span class="off-tag">Off</span>'}</td>
      <td class="client">${escapeHtml(`${p.host}:${p.port}`)}</td>
      <td><b>${p.wins}</b></td>
      <td>${fmtPct(p.winPct)}</td>
      <td>${fmtMs(p.lastMs)}</td>
      <td>${fmtMs(p.avgMs)}</td>
      <td>${p.seen}</td>
      <td>${p.misses}</td>
      <td class="pool-enabled">
        <label class="switch-label"><input type="checkbox" data-action="toggle-pool" data-id="${p.id}" ${p.enabled ? 'checked' : ''} /><span class="sr-only">Enabled</span></label>
      </td>
      <td><button class="secondary danger" data-action="delete-pool" data-id="${p.id}">Remove</button></td>
    </tr>
  `).join('');
  markOpenRow();
  foldSums();
}

// The legend and the explanations fold shut again with a tap anywhere on
// them, not only on their title: on a phone the title has scrolled away by
// then, and it comes back into view. Storage is left out - its buttons
// delete data, and a tap beside one must not do anything at all.
for (const box of document.querySelectorAll('details.key, details.how')) {
  box.addEventListener('click', (e) => {
    if (!box.open || e.target.closest('summary, a, button, input')) return;
    if (String(window.getSelection()).length > 0) return;
    // Its title on screen: it rolls up into it, in place. Scrolled away: shut
    // at once, and the title comes back to the top of the screen.
    const summary = box.querySelector(':scope > summary');
    if (summary.getBoundingClientRect().top >= 0) {
      foldInPlace({ anchor: summary, box, open: false, set: (open) => { box.open = open; } });
      return;
    }
    box.open = false;
    const top = box.getBoundingClientRect().top;
    if (top < 0) window.scrollBy(0, top - 8);
  });
}

// ---------------------------------------------------------------------------
// Traffic

// Grid labels are round numbers, so they get no decimals: "15 GB", not "15.00 GB".
function axisBytes(v, unit) {
  if (v === 0) return '0';
  const name = { 1: 'B', 1024: 'KB', [1024 ** 2]: 'MB', [1024 ** 3]: 'GB', [1024 ** 4]: 'TB' }[unit] || 'B';
  const n = v / unit;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ${name}`;
}

// Bars per UTC day, as in the approved design: sent as a rounded orange bar,
// received in blue in front of it, on one scale so the two compare by eye.
// The grid keeps its values, quietly; each day says its numbers on hover.
// Drawn at the size it is shown, in pixels: a fixed 1300-wide picture scaled
// down to a phone made its 11px labels 3px, and scaled-up labels then no
// longer fitted beside the axis.
function trafficChartSvg(days, W) {
  const H = W < 600 ? 170 : 220, top = 14, base = H - 20;
  const max = Math.max(1, ...days.map((d) => Math.max(d.sent || 0, d.recv || 0)));
  // A round step for the grid: 1, 2 or 5 times a power of 1024-based units.
  const unit = 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024)));
  const raw = max / unit / 3;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((m) => m >= raw) * unit;
  const top_ = Math.ceil(max / step) * step;
  const y = (v) => base - (base - top) * (v / top_);
  const left = 10 + 6.5 * Math.max(...[0, step, top_].map((v) => axisBytes(v, unit).length));
  const slot = (W - left) / days.length;
  // A date label every 5 days, or every 10 where 5 would run into each other.
  const every = slot * 5 >= 44 ? 5 : 10;
  const bw = slot * 0.64;
  let g = '<defs><linearGradient id="traffic-sent" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb04a"/><stop offset="1" stop-color="#c26a06"/></linearGradient></defs>';
  for (let v = 0; v <= top_ + 1; v += step) {
    g += `<line class="grid" x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text class="axis" x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${escapeHtml(axisBytes(v, unit))}</text>`;
  }
  days.forEach((d, i) => {
    const x = left + i * slot + (slot - bw) / 2;
    if (d.sent != null) {
      const tip = `<title>${escapeHtml(`${d.day}: ↑ ${fmtBytes(d.sent)} · ↓ ${fmtBytes(d.recv)}`)}</title>`;
      g += `<rect class="sent" x="${x}" y="${y(d.sent)}" width="${bw}" height="${base - y(d.sent)}" rx="3">${tip}</rect>`;
      g += `<rect class="recv" x="${x}" y="${y(d.recv)}" width="${bw}" height="${base - y(d.recv)}" rx="2">${tip}</rect>`;
    }
    const last = i === days.length - 1;
    if ((i % every === 0 && days.length - 1 - i >= every / 2) || last) {
      // The newest date ends at the right edge rather than past it.
      g += `<text class="axis" x="${last ? W : left + i * slot + slot / 2}" y="${H - 4}" text-anchor="${last ? 'end' : 'middle'}">${escapeHtml(d.day.slice(5))}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

async function refreshTraffic() {
  const t = await api('/api/traffic');
  // The arrows carry the colours of the bars, so they are the legend too.
  const arrows = (v) => `<span class="up">↑ ${escapeHtml(fmtBytes(v.sent))}</span><span class="down">↓ ${escapeHtml(fmtBytes(v.recv))}</span>`;
  document.getElementById('traffic-sum').textContent = t.since ? `today ↑ ${fmtBytes(t.today.sent)} ↓ ${fmtBytes(t.today.recv)}` : '';
  document.getElementById('traffic-totals').innerHTML = t.since
    ? [['Today', t.today], ['Last 7 days', t.week], ['Last 30 days', t.month]]
      .map(([l, v]) => `<div class="t"><div class="l">${l}</div><div class="v">${arrows(v)}</div></div>`)
      .join('')
    : '<p class="hint">Nothing recorded yet - the first numbers appear within an hour of the app starting.</p>';
  lastTrafficDays = t.since ? t.days : null;
  drawTrafficChart();
}

let lastTrafficDays = null;
function drawTrafficChart() {
  const el = document.getElementById('traffic-chart');
  if (!el) return;
  el.innerHTML = lastTrafficDays && el.clientWidth ? trafficChartSvg(lastTrafficDays, el.clientWidth) : '';
}
let trafficWidth = 0;
window.addEventListener('resize', () => {
  const el = document.getElementById('traffic-chart');
  if (!el || el.clientWidth === trafficWidth) return;
  trafficWidth = el.clientWidth;
  drawTrafficChart();
});

async function refreshAll() {
  // Block updates are not in here: they arrive on their own via the
  // /api/events stream, not by polling. Rotation is not in here either - it
  // only ever changes on its own ten-minute tick, so it has its own, much
  // slower schedule (see startRefreshLoop).
  const results = await Promise.allSettled([
    refreshStatus(), refreshPeers(), refreshPools(), refreshHealth(),
  ]);
  // A failed refresh used to be completely invisible: allSettled swallowed
  // the rejection, nothing was logged, and the tables simply kept showing
  // whatever they had - hours-old numbers presented exactly like fresh ones.
  const failed = results.filter((r) => r.status === 'rejected');
  beat(failed.length === 0);
  foldSums();
  reportRefreshHealth(failed.map((r) => r.reason));
}

// A dot in front of the status line beats once when fresh numbers arrive and
// goes grey when a round failed: the page says it is alive without a clock
// that ticks. The time is in its title.
const liveDot = document.createElement('span');
liveDot.className = 'live-dot';
liveDot.setAttribute('aria-hidden', 'true');
// Off again once it has beaten: the status line is rewritten on every
// refresh, and putting the dot back with the class on beats it anew.
liveDot.addEventListener('animationend', () => liveDot.classList.remove('beat'));
function beat(ok) {
  liveDot.classList.toggle('stale', !ok);
  if (!ok) return;
  liveDot.title = `Updated ${new Date().toLocaleTimeString()}`;
  liveDot.classList.remove('beat');
  void liveDot.offsetWidth; // restart the animation
  liveDot.classList.add('beat');
}

// Two consecutive failed rounds before saying anything: a single miss during
// a container restart or a brief RPC hiccup is normal and self-corrects on
// the next pass, and a banner that cries wolf gets ignored when it matters.
let consecutiveFailedRefreshes = 0;
function reportRefreshHealth(errors) {
  const banner = document.getElementById('refresh-banner');
  if (!banner) return;
  if (errors.length === 0) {
    consecutiveFailedRefreshes = 0;
    banner.hidden = true;
    return;
  }
  consecutiveFailedRefreshes += 1;
  console.warn('dashboard refresh failed', errors);
  if (consecutiveFailedRefreshes < 2) return;
  banner.hidden = false;
  banner.textContent = `The dashboard has not been able to refresh for ${consecutiveFailedRefreshes} rounds (${errors[0].message}). The numbers below are stale.`;
}

// A client-side slice of the log already in hand, as for the live peers.
document.getElementById('rotation-log-toggle').addEventListener('click', (e) => {
  const opening = !showAllLog;
  const wrap = document.getElementById('rotation-log-table').closest('.table-wrap');
  foldInPlace({ anchor: opening ? wrap : e.currentTarget, box: wrap, open: opening, set: (all) => {
    showAllLog = all;
    if (lastRotationLog) renderRotationLog(lastRotationLog);
  } });
});

// Every card folds to its title on a tap and stays so on this device: open
// unless the reader closed it (28.10.2026). Storage keeps its own <details>.
const FOLD_KEY = 'lab.folded';
const folded = (() => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch { return new Set(); } })();
for (const card of document.querySelectorAll('main > section.card')) {
  const title = card.querySelector(':scope > h2');
  if (!title) continue;
  const id = card.id || title.firstChild.textContent.trim();
  title.classList.add('fold-title');
  title.tabIndex = 0;
  title.setAttribute('role', 'button');
  const show = () => {
    foldSums();
    card.classList.toggle('folded', folded.has(id));
    title.setAttribute('aria-expanded', String(!folded.has(id)));
  };
  const flip = (e) => {
    if (e.target.closest('button, a, input')) return;
    // What is on screen: a card opened for a peer link is open, whatever the
    // stored state says.
    const opening = card.classList.contains('folded');
    foldInPlace({ anchor: title, box: card, open: opening, set: (open) => {
      if (open) folded.delete(id); else folded.add(id);
      show();
    } });
    // Kept as the reader left it, not as it is half way: closing rolls up
    // from open and is folded only at the end.
    if (opening) folded.delete(id); else folded.add(id);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch { /* private window */ }
    if (opening) window.dispatchEvent(new Event('resize')); // the traffic chart measures its width
  };
  title.addEventListener('click', flip);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(e); } });
  show();
}

// A folded card still says the one thing worth knowing about it, beside its
// title: the switches and how many pools race. Traffic writes its own.
function foldSums() {
  const rot = document.getElementById('rotation-toggle');
  document.getElementById('rotation-sum').textContent = rot.checked ? 'on' : 'off';
  const pools = document.querySelectorAll('#pool-table input[data-action="toggle-pool"]:checked').length;
  document.getElementById('stratum-sum').textContent = document.getElementById('stratum-toggle').checked
    ? `on · ${pools} ${pools === 1 ? 'pool' : 'pools'}` : 'off';
}

// The whole ranking open: its name and the way back to the top ten ride along
// at the top of the screen once the title has scrolled away, so nobody has to
// scroll to the end to close it.
function liveStickOn() {
  const stick = document.getElementById('live-stick');
  const card = document.getElementById('live-peer-card');
  stick.hidden = !showAllLivePeers;
  stick.classList.toggle('on', showAllLivePeers
    && card.querySelector(':scope > h2').getBoundingClientRect().bottom < 0
    && card.getBoundingClientRect().bottom > 140);
}
window.addEventListener('scroll', liveStickOn, { passive: true });
// From the bar at the top there is no button under the finger to keep: the
// list closes, and the card's title comes back to the top of the screen.
document.getElementById('live-stick-back').addEventListener('click', () => {
  showAllLivePeers = false;
  if (lastPeerRanking) renderPeerTables(lastPeerRanking, { force: true });
  const card = document.getElementById('live-peer-card');
  if (card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: 'start', behavior: glide() });
});

// Opening, what is above stays and the rest rolls out below it; closing, the
// button stays under the finger and the list rolls up into it.
document.getElementById('live-peer-limit-toggle').addEventListener('click', (e) => {
  const opening = !showAllLivePeers;
  const wrap = document.querySelector('#live-peer-card .table-wrap');
  foldInPlace({ anchor: opening ? wrap : e.currentTarget, box: wrap, open: opening, set: (all) => {
    showAllLivePeers = all;
    // Purely a client-side slice of data already in hand - and forced, because
    // this is the user acting, not a poll arriving.
    if (lastPeerRanking) renderPeerTables(lastPeerRanking, { force: true });
  } });
  if (!lastPeerRanking) refreshPeers();
});

// Add and Test share the same input and the same result line, and both take
// seconds (a version probe against each candidate port, with a 3s timeout
// each), so both disable the form while they run - otherwise a second click
// starts a second probe against the same address and the two results
// overwrite each other in whichever order they happen to finish.
function manualAddBusy(busy, message) {
  const resultEl = document.getElementById('manual-add-result');
  document.getElementById('manual-test-button').disabled = busy;
  document.querySelector('#manual-add-form button[type=submit]').disabled = busy;
  resultEl.className = busy ? 'hint' : resultEl.className;
  if (message != null) resultEl.textContent = message;
}

function manualAddResult(text, kind) {
  const resultEl = document.getElementById('manual-add-result');
  resultEl.textContent = text;
  resultEl.className = kind === 'error' ? 'hint result-error' : 'hint result-ok';
}

document.getElementById('manual-test-button').addEventListener('click', async () => {
  const input = document.getElementById('manual-add-input');
  if (!input.value.trim()) return;
  manualAddBusy(true, 'testing…');
  try {
    const result = await api('/api/peers/probe', { method: 'POST', body: JSON.stringify({ host: input.value }) });
    // Naming the port is the useful half of the answer for an inbound peer:
    // it is the port that peer's node actually listens on, which is never the
    // one its inbound connection to us came from.
    manualAddResult(`reachable - a node answered at ${result.address}. Nothing was added.`, 'ok');
  } catch (err) {
    manualAddResult(`not reachable - ${err.message}`, 'error');
  } finally {
    manualAddBusy(false);
  }
});

document.getElementById('manual-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('manual-add-input');
  manualAddBusy(true, 'connecting…');
  try {
    const result = await api('/api/peers/manual-add', { method: 'POST', body: JSON.stringify({ host: input.value }) });
    justGone.delete(result.address);
    manualAddResult(result.warning ? `added ${result.address} - ${result.warning}` : `added ${result.address}`, 'ok');
    input.value = '';
    refreshPeers();
  } catch (err) {
    manualAddResult(err.message, 'error');
  } finally {
    manualAddBusy(false);
  }
});

document.getElementById('pool-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = document.getElementById('pool-label');
  const host = document.getElementById('pool-host');
  const port = document.getElementById('pool-port');
  const resultEl = document.getElementById('pool-add-result');
  // One request at a time: a double click added the pool, then failed on it.
  const submit = e.target.querySelector('button[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  clearTimeout(poolResultTimer);
  try {
    await api('/api/pools', {
      method: 'POST',
      body: JSON.stringify({ label: label.value, host: host.value, port: Number(port.value) }),
    });
    resultEl.textContent = 'added';
    label.value = ''; host.value = ''; port.value = '';
    refreshPools();
    poolResultTimer = setTimeout(() => { resultEl.textContent = ''; }, 5000);
  } catch (err) {
    resultEl.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});
let poolResultTimer = null;

// Each action only refreshes the table(s) it can actually affect, rather
// than re-fetching /api/status, /api/peers/ranking, /api/pools and
// /api/blocks/latest on every single click - those already refresh on
// their own schedule (REFRESH_MS above) or arrive on the event stream.
const PEER_ACTIONS = new Set(['add-manual', 'untrust', 'disconnect', 'keep']);
const POOL_ACTIONS = new Set(['delete-pool']);

// A successful "Add as Manual" used to give ZERO on-screen feedback: the
// peer just silently moved out of the Outbound table into the Manual Peers
// panel on the next refresh. If you weren't looking at that panel, it
// looked exactly like the button did nothing at all - even though it
// worked. This toast makes every row action (pending -> success/error)
// explicit and visible, wherever on the page you're looking.
let toastTimer = null;
function showToast(message, kind) {
  const el = document.getElementById('action-toast');
  clearTimeout(toastTimer);
  el.textContent = message;
  el.className = `action-toast ${kind}`;
  el.hidden = false;
  if (kind !== 'pending') {
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 9000 : 5000);
  }
}

// Quick-fill for the solo pools available in the Umbrel app store. The list,
// with the container name and internal stratum port of each and why those
// differ from what a miner on the LAN uses, lives in src/lib/local-pools.js;
// /api/pools/local hands it over together with which of them are installed.
// The buttons are always there - a pool declined in the "found" note below
// can still be added any time.
let localPoolTemplates = {};

// Pools found on this Umbrel and not yet added are offered once, until the
// user adds or declines them. Declined ones are remembered in this browser
// only; the quick-fill buttons stay either way.
const POOLS_DISMISSED_KEY = 'lab.localPoolsDismissed';
function dismissedPools() {
  try { return new Set(JSON.parse(localStorage.getItem(POOLS_DISMISSED_KEY) || '[]')); } catch { return new Set(); }
}
let foundPools = [];
// "A", "A and B", "A, B and C"
function listLabels(labels) {
  return labels.length < 3 ? labels.join(' and ') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

async function refreshLocalPools() {
  let list;
  try { list = await api('/api/pools/local'); } catch { return; }
  localPoolTemplates = Object.fromEntries(list.map((p) => [p.key, p]));
  const dismissed = dismissedPools();
  foundPools = list.filter((p) => p.installed && !p.added && !dismissed.has(p.key));
  const box = document.getElementById('pool-found');
  if (!box) return;
  box.hidden = foundPools.length === 0;
  if (foundPools.length) {
    document.getElementById('pool-found-text').textContent =
      `Found on this Umbrel: ${foundPools.map((p) => p.label).join(', ')}.`;
  }
}

document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, address, id, template } = btn.dataset;

  if (action === 'add-found-pools') {
    btn.disabled = true;
    const added = [];
    for (const p of foundPools) {
      try {
        await api('/api/pools', { method: 'POST', body: JSON.stringify({ label: p.label, host: p.host, port: p.port }) });
        added.push(p);
      } catch (err) {
        showToast(`Could not add ${p.label}: ${err.message}`, 'error');
      }
    }
    btn.disabled = false;
    // Offered once: a pool added here and removed later is not offered again.
    // One that could not be added stays on offer.
    const dismissed = dismissedPools();
    added.forEach((p) => dismissed.add(p.key));
    try { localStorage.setItem(POOLS_DISMISSED_KEY, JSON.stringify([...dismissed])); } catch { /* private window */ }
    if (added.length) showToast(`Added ${listLabels(added.map((p) => p.label))} to Stratum Race.`, 'success');
    await refreshLocalPools();
    refreshPools();
    return;
  }
  if (action === 'dismiss-found-pools') {
    const dismissed = dismissedPools();
    foundPools.forEach((p) => dismissed.add(p.key));
    try { localStorage.setItem(POOLS_DISMISSED_KEY, JSON.stringify([...dismissed])); } catch { /* private window: shows again next time */ }
    document.getElementById('pool-found').hidden = true;
    return;
  }
  if (action === 'fill-pool-template') {
    if (!localPoolTemplates[template]) await refreshLocalPools();
    const t = localPoolTemplates[template];
    if (!t) return;
    document.getElementById('pool-label').value = t.label;
    document.getElementById('pool-host').value = t.host;
    document.getElementById('pool-port').value = t.port;
    // DATUM hands out no work until it has a payout address (Umbrel's own
    // setup notes for the app), the other four run as installed (theirs):
    // said here, or DATUM's misses look like a fault.
    document.getElementById('pool-add-result').textContent = template === 'datum'
      ? 'The other pool apps work straight away. DATUM sends work only once a Bitcoin address is set in its Config tab.' : '';
    document.getElementById('pool-add-form').querySelector('button[type="submit"]').focus();
    return;
  }
  const isPeerOrPoolAction = PEER_ACTIONS.has(action) || POOL_ACTIONS.has(action);
  const originalLabel = btn.textContent;
  if (isPeerOrPoolAction) {
    btn.disabled = true;
    // The lock is an icon, not a label - replacing its text with an ellipsis
    // would leave an empty-looking cell for the moment the request takes.
    if (action !== 'keep') btn.textContent = '…';
    // Hold off the periodic re-render for the duration. Without this a poll
    // landing mid-action replaced this very button with a fresh, enabled one
    // - so the action could be fired a second time, and the reset in the
    // finally block below wrote to an element no longer in the document.
    actionsInFlight += 1;
  }

  // Probing a host on 8333 then 9333 can take up to ~6s (3s timeout per
  // port) - show what's actually happening instead of leaving the UI
  // looking frozen/unresponsive during that wait.
  if (action === 'add-manual') showToast(`Adding ${address} as manual peer - probing port 8333, then 9333…`, 'pending');
  if (action === 'untrust') showToast(`Removing ${address}…`, 'pending');
  if (action === 'disconnect') showToast(`Disconnecting ${address}…`, 'pending');
  if (action === 'delete-pool') showToast('Removing pool…', 'pending');

  try {
    if (action === 'add-manual') {
      const result = await api('/api/peers/add-manual', { method: 'POST', body: JSON.stringify({ address }) });
      // Added back within the wait after a removal: it belongs in the tables again.
      justGone.delete(address);
      justGone.delete(result.address);
      showToast(
        result.warning
          ? `Added as manual peer: ${result.address} - ${result.warning}`
          : `Added as manual peer: ${result.address}. It now shows in the Manual Peers panel below.`,
        'success',
      );
    }
    if (action === 'untrust') {
      await api('/api/peers/untrust', { method: 'POST', body: JSON.stringify({ address }) });
      justGone.set(address, Date.now());
      recheckGone();
      showToast(`Removed ${address} as manual peer and disconnected it.`, 'success');
    }
    if (action === 'disconnect') {
      await api('/api/peers/disconnect', { method: 'POST', body: JSON.stringify({ address }) });
      // A manual peer stays manual and Core dials it again, so only a non-manual one leaves the tables.
      const was = (lastPeerRanking || []).find((p) => p.address === address);
      if (!was || !was.trusted) justGone.set(address, Date.now());
      recheckGone();
      showToast(`Disconnected ${address}.`, 'success');
    }
    if (action === 'keep') {
      const kept = btn.dataset.kept !== '1';
      await api('/api/peers/keep', { method: 'POST', body: JSON.stringify({ address, kept }) });
      showToast(
        kept
          ? `${address} is kept - the rotation will leave it alone.`
          : `${address} is back in the rotation and can be replaced by a better peer.`,
        'success',
      );
    }
    if (action === 'delete-pool') {
      await api(`/api/pools/${id}`, { method: 'DELETE' });
      showToast('Pool removed.', 'success');
    }

    if (PEER_ACTIONS.has(action)) refreshPeers();
    if (POOL_ACTIONS.has(action)) refreshPools();
  } catch (err) {
    showToast(
      action === 'add-manual' ? `Could not add ${address} as manual: ${err.message}` : err.message,
      'error',
    );
  } finally {
    if (isPeerOrPoolAction) {
      actionsInFlight -= 1;
      if (btn.isConnected) {
        btn.disabled = false;
        // Only what was replaced: the lock's two spans would come back as plain text.
        if (action !== 'keep') btn.textContent = originalLabel;
      }
      flushDeferredRenders();
    }
  }
});

document.body.addEventListener('change', async (e) => {
  const chk = e.target.closest('input[data-action="toggle-pool"]');
  if (chk) {
    const enabled = chk.checked;
    actionsInFlight += 1;
    try {
      await api(`/api/pools/${chk.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
      showToast(enabled ? 'Pool enabled.' : 'Pool disabled.', 'success');
      refreshPools();
    } catch (err) {
      // Was an alert(), the one blocking dialog in the whole app - it also
      // froze the refresh loop until someone clicked it away.
      if (chk.isConnected) chk.checked = !enabled;
      showToast(`Could not change the pool: ${err.message}`, 'error');
    } finally {
      actionsInFlight -= 1;
      flushDeferredRenders();
    }
    return;
  }

  if (e.target.id === 'stratum-toggle' || e.target.id === 'rotation-toggle' || e.target.dataset.action === 'toggle-pool') foldSums();
  if (e.target.id === 'stratum-toggle') {
    const enabled = e.target.checked;
    try {
      const result = await api('/api/stratum/toggle', { method: 'POST', body: JSON.stringify({ enabled }) });
      const body = document.getElementById('stratum-body');
      foldInPlace({ anchor: e.target, box: body.closest('section') || body, open: Boolean(result.enabled), set: (on) => applyStratumEnabled(on) });
      showToast(
        result.enabled
          ? 'Stratum Race turned on. Pool connections open within half a minute.'
          : 'Stratum Race turned off. Pool connections close within half a minute.',
        'success',
      );
      if (result.enabled) refreshPools();
    } catch (err) {
      if (e.target.isConnected) e.target.checked = !enabled;
      showToast(`Could not change Stratum Race: ${err.message}`, 'error');
    }
    return;
  }

  if (e.target.id === 'rotation-toggle') {
    rotationToggleEpoch += 1;
    const enabled = e.target.checked;
    try {
      // The server answers with the state it actually stored - use that
      // rather than assuming the click won.
      const result = await api('/api/rotation/toggle', { method: 'POST', body: JSON.stringify({ enabled }) });
      rotationToggleEpoch += 1;
      if (e.target.isConnected) e.target.checked = Boolean(result.enabled);
      showToast(result.enabled ? 'Slot fill turned on.' : 'Slot fill turned off.', 'success');
      refreshRotation();
    } catch (err) {
      rotationToggleEpoch += 1;
      if (e.target.isConnected) e.target.checked = !enabled;
      showToast(`Could not change peer rotation: ${err.message}`, 'error');
    }
    return;
  }

});

document.getElementById('stratum-range').addEventListener('click', (e) => {
  const pick = e.target.closest('button[data-range]');
  if (!pick || pick.classList.contains('on')) return;
  for (const b of pick.parentElement.children) {
    b.classList.toggle('on', b === pick);
    b.setAttribute('aria-pressed', String(b === pick));
  }
  refreshPools();
});

// Background services (peer-profiler, relay-profiler, stratum-race) have no
// HTTP port of their own, so a crashed or wedged one used to be invisible
// here - the tables simply stopped changing. Each writes a heartbeat, and
// this surfaces a stale one where it will actually be seen.
async function refreshHealth() {
  const banner = document.getElementById('service-banner');
  if (!banner) return;
  let report;
  try {
    report = await api('/api/health');
  } catch (err) {
    // Can't reach our own API - the refresh banner covers that case, and
    // hiding this one avoids two banners saying the same thing.
    banner.hidden = true;
    throw err;
  }
  const down = Object.entries(report.services || {})
    .filter(([, v]) => !v.ok)
    .map(([name]) => name);
  if (down.length > 0) {
    banner.hidden = false;
    banner.textContent = down.length === 1
      ? `The ${down[0]} service is not reporting in. Check its container logs - data it collects is not being recorded right now.`
      : `${down.length} background services are not reporting in (${down.join(', ')}). Check the app's container logs.`;
    return;
  }

  // Every service alive and still nothing arriving. Reported before
  // attribution, because a stalled subscription means no new blocks at all -
  // the attribution check is then frozen on old data and would say nothing.
  const zmq = report.zmq;
  if (zmq && zmq.ok === false) {
    const hours = Math.floor(zmq.quietMs / 3600000);
    banner.hidden = false;
    banner.textContent = zmq.everReceived
      ? `No block has arrived from Bitcoin Core for ${hours} hours. The connection reports itself as fine, `
        + 'which it always does - check that Bitcoin Node is running and still publishing over ZMQ.'
      : 'No block has ever arrived from Bitcoin Core. Nothing is being measured - check that Bitcoin Node '
        + 'is running and that its ZMQ block notifications are switched on.';
    return;
  }

  // The clocks, read straight off Core's Date header rather than inferred from
  // the damage. Ahead of the attribution warning because it is the cause of it,
  // it is the more accurate of the two, and it can be said before First % has
  // had a chance to stick at zero.
  const clock = report.coreClock;
  if (clock && clock.ok === false) {
    const seconds = (Math.abs(clock.offsetMs) / 1000).toFixed(1);
    banner.hidden = false;
    banner.textContent = `Bitcoin Core's clock is about ${seconds} seconds `
      + `${clock.offsetMs < 0 ? 'behind' : 'ahead of'} this app's. Block attribution needs them within `
      + 'a couple of seconds, so First % will stay at 0 until they agree.';
    return;
  }

  // Every service alive and still nothing being measured. Attribution matches
  // Core's last_block against the instant ZMQ delivered the block, so a few
  // seconds of disagreement between the two clocks credits nobody, ever, while
  // every other part of the page looks perfectly normal.
  const attribution = report.attribution;
  if (attribution && attribution.ok === false) {
    const seconds = attribution.skewMs == null ? null : Math.abs(attribution.skewMs) / 1000;
    banner.hidden = false;
    banner.textContent = attribution.reason === 'clock'
      ? `No peer has been credited with any of the last ${attribution.blocks} blocks. `
        + `Bitcoin Core's clock looks about ${seconds.toFixed(1)} seconds `
        + `${attribution.skewMs < 0 ? 'behind' : 'ahead of'} this app's.`
      : `No peer has been credited with any of the last ${attribution.blocks} blocks, `
        + 'so First % cannot fill up. Check the relay profiler\'s logs.';
    return;
  }

  banner.hidden = true;
}

/**
 * Self-scheduling refresh loop.
 *
 * Two things setInterval got wrong here. It kept firing while a previous
 * pass was still in flight, so a slow response let requests pile up on top
 * of each other; and it kept polling forever in a background tab, so a
 * dashboard left open in some window went on querying the node all day.
 * This waits for each pass to finish before scheduling the next, pauses
 * entirely while the page is hidden, and refreshes once immediately when it
 * becomes visible again so it is never showing stale data on return.
 */
function startRefreshLoop() {
  let timer = null;
  let rotationTimer = null;

  const schedule = () => {
    clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(run, REFRESH_MS);
  };

  const run = async () => {
    if (document.hidden) return;
    try {
      await refreshAll();
    } finally {
      schedule();
    }
  };

  // The rotation panel changes at most once per rotation tick - ten minutes -
  // so it does not belong in the 20-second round with the live tables. It was
  // fetching and re-rendering fifty log rows thirty times per possible change,
  // into a panel that starts collapsed.
  const runRotation = async () => {
    if (document.hidden) return;
    try {
      // Traffic is written once an hour, so it rides on this slow round too.
      await Promise.all([refreshRotation(), refreshTraffic()]);
    } catch (err) {
      console.warn('rotation or traffic refresh failed', err);
    } finally {
      clearTimeout(rotationTimer);
      if (!document.hidden) rotationTimer = setTimeout(runRotation, ROTATION_REFRESH_MS);
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
      clearTimeout(rotationTimer);
    } else {
      run();
      runRotation();
    }
  });

  run();
  runRotation();
}

/**
 * Live block events. EventSource reconnects on its own after a dropped or
 * ended stream (the server ends each one after a few minutes), and the server
 * replays the current block on connect, so no state is lost across a drop.
 *
 * What it does not retry is a refusal: an answer that is not a stream at all -
 * 503 when every slot is taken, or the proxy's error page while the app
 * restarts - closes the source for good. Without this the page went on showing
 * new heights from the status poll but never played the wave again.
 */
const EVENT_STREAM_RETRY_MS = 30 * 1000; // matches the server's Retry-After

function startEventStream() {
  const source = new EventSource('/api/events');
  source.addEventListener('block', (e) => {
    try {
      applyBlockUpdate(JSON.parse(e.data));
    } catch (err) {
      /* malformed frame - the next event supersedes it */
    }
  });
  source.addEventListener('error', () => {
    if (source.readyState !== EventSource.CLOSED) return; // reconnecting by itself
    setTimeout(startEventStream, EVENT_STREAM_RETRY_MS);
  });
}

/**
 * Storage panel. Its numbers come from their own endpoint because getting them
 * exactly means walking every page of the database - too expensive to poll, so
 * it is fetched when the panel is opened and again after a reset.
 */
async function refreshStorage() {
  let s;
  try {
    s = await api('/api/storage');
  } catch (err) {
    return; // the panel simply shows nothing rather than breaking the page
  }
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('storage-total', fmtBytes(s.totalBytes));
  set('reset-peers-size', `${fmtBytes(s.peerData.bytes)} · ${s.peerData.rows.toLocaleString('en-US')} rows`);
  set('reset-pools-size', `${fmtBytes(s.poolHistory.bytes)} · ${s.poolHistory.rows.toLocaleString('en-US')} rows`);
  set('reset-peers-detail', `${s.peerData.rows.toLocaleString('en-US')} rows, ${fmtBytes(s.peerData.bytes)}, will be deleted.`);
  set('reset-pools-detail', `${s.poolHistory.rows.toLocaleString('en-US')} rows, ${fmtBytes(s.poolHistory.bytes)}, will be deleted.`);
}

// Two steps rather than a browser confirm(): the warning can then say what is
// actually about to go, in rows and megabytes, instead of asking whether the
// user is sure about something unspecified.
function wireReset(scope) {
  const ask = document.getElementById(`reset-${scope}`);
  const panel = document.getElementById(`reset-${scope}-confirm`);
  const yes = document.getElementById(`reset-${scope}-yes`);
  const no = document.getElementById(`reset-${scope}-no`);
  if (!ask || !panel || !yes || !no) return;

  // At the page's end the question could open below the screen: brought up
  // only as far as it needs.
  ask.addEventListener('click', () => { panel.hidden = false; ask.hidden = true; panel.scrollIntoView({ block: 'nearest', behavior: glide() }); });
  no.addEventListener('click', () => { panel.hidden = true; ask.hidden = false; });
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      await api('/api/reset', { method: 'POST', body: JSON.stringify({ scope }) });
    } catch (err) {
      // Said out loud: a silent failure here read as data that was deleted.
      // Not "nothing was deleted": a timeout can come after the delete.
      showToast(`Reset failed: ${err.message}`, 'error');
      refreshStorage();
      return;
    } finally {
      yes.disabled = false;
      panel.hidden = true;
      ask.hidden = false;
    }
    await refreshStorage();
    await refreshStatus();
    // What each reset empties: peer data includes the slot fill log, pool
    // history the pool table.
    if (scope === 'pools') await refreshPools();
    else await Promise.all([refreshPeers(), refreshRotation()]);
  });
}

// Every <details> folds in place too: its summary stays, its text rolls out
// below and back up.
document.addEventListener('click', (e) => {
  const summary = e.target.closest && e.target.closest('details > summary');
  if (!summary || e.target.closest('a, button, input')) return;
  e.preventDefault();
  const details = summary.parentElement;
  foldInPlace({ anchor: summary, box: details, open: !details.open, set: (open) => { details.open = open; } });
});
document.getElementById('storage-card').addEventListener('toggle', (e) => {
  if (e.target.open) refreshStorage();
});
wireReset('peers');
wireReset('pools');


// The link to Peer Map used to be decided here, by knocking on port 8791 from
// the browser with a no-cors fetch and showing the link if anything answered.
// That knock is gone: refreshStatus() above already reads peerMapInstalled
// from /api/status, where this app's own process asks the question properly -
// it can see whether the container exists, which a browser never could, and it
// is not guessing from a request whose reply it is not allowed to read.
//
// It also had to go for the dashboard to be servable under a
// Content-Security-Policy with connect-src 'self' (see SECURITY_HEADERS in
// dashboard-server.js): a cross-origin fetch is exactly what that forbids, and
// the policy is worth more than a second way of answering a question already
// answered.
startRefreshLoop();
startEventStream();

// On a phone the page is many screens long. Scrolling back up shows a small
// bar with the sections, and it goes again when the reader scrolls on down or
// is back at the top. Peer Map has the same.
(function jumpBar() {
  const bar = document.createElement('nav');
  bar.className = 'jump-bar';
  bar.setAttribute('aria-label', 'Jump to');
  document.body.appendChild(bar);
  const byHeading = (text) => [...document.querySelectorAll('main .card h2')]
    .find((h) => h.textContent.trim().startsWith(text))?.closest('.card');
  const targets = [['\u2191 Top', null], ['Peers', 'Live Peer Ranking'], ['Slot Fill', 'Manual Slot Fill'],
    ['Stratum', 'Stratum Race'], ['Traffic', 'Traffic']];
  // Traffic rather than Storage (28.10.2026): Storage is rarely needed and
  // sits right under Traffic, at the end of the page.
  for (const [label, heading] of targets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => {
      const card = heading && byHeading(heading);
      const y = card ? card.getBoundingClientRect().top + window.scrollY - 8 : 0;
      window.scrollTo({ top: Math.max(0, y), behavior: glide() });
      bar.classList.remove('shown');
    });
    bar.appendChild(b);
  }
  let lastY = window.scrollY;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    const phone = window.matchMedia('(max-width: 600px)').matches;
    const up = y < lastY - 4;
    const down = y > lastY + 4;
    // With a mouse the bar sits quietly in a corner whenever the reader is
    // far down; on a phone it comes only on the way back up.
    bar.classList.toggle('corner', !phone);
    if (phone ? up && y > window.innerHeight : y > window.innerHeight) bar.classList.add('shown');
    else if (phone ? down || y < window.innerHeight / 2 : y < window.innerHeight) bar.classList.remove('shown');
    if (up || down) lastY = y;
  }, { passive: true });
})();

// Esc closes what a click opened: the reset question, then the storage card,
// as in a desktop app.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || (e.target.closest && e.target.closest('input, textarea, select'))) return;
  if (openRow) {
    openRow = null;
    markOpenRow();
    e.preventDefault();
    return;
  }
  const confirm = [...document.querySelectorAll('.reset-confirm')].find((c) => !c.hidden);
  if (confirm) {
    confirm.querySelector('[id$="-no"]')?.click();
    e.preventDefault();
    return;
  }
  const storage = document.getElementById('storage-card');
  if (storage && storage.open) { storage.open = false; e.preventDefault(); }
});
