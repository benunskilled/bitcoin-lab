'use strict';

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
const PEER_MAP_PORT = 8791;
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
  return `${m}m`;
}

function fmtPct(p) {
  return p == null ? '-' : `${p.toFixed(1)}%`;
}

// Disk used by the measurement data. One decimal below a gigabyte and two
// above it, so the number stays readable as the file grows past the point
// where anyone would care about the megabytes.
function fmtBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

// The colour says what kind of connection this is, and nothing else. Manual,
// inbound, outbound - the same three colours Peer Map paints its markers with.
function statusPillClass(status) {
  if (status === 'OFFLINE' || status === 'MANUAL OFFLINE') return 'offline';
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
// in two windows, and a peer that is struck through in one and not the other
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
  // Mining pool software speaking p2p, or a node whose operator says in the
  // bracketed comment that it belongs to a pool. Relays.
  [/ckp2p|ckpool|\([^)]*pool[^)]*\)/i, null],
  [/Bitcoin ABC|BUCash|Bitcoin SV|BCHUnlimited|Bitcoin XT/i, 'a client of another chain'],
  // Scanners run as a service and scanners run by universities - the second
  // kind announces itself with its department's domain.
  [/kit\.edu|dsn\.tm|dsn\.kastel|\.ac\.|uni-/i, 'a research scanner'],
  [/bitnodes|metrika|nodemap|crawler|scanner/i, 'a network crawler'],
  // Address indexers for wallets: they follow the chain and relay nothing.
  [/electrs|electrum|esplora|mempool/i, 'an address indexer'],
  [/bitcoinj|breadwallet|bither|multibit|wasabi|Bitcoin Wallet/i, 'a wallet'],
  [/neutrino/i, 'a light client'],
];

function cannotRelayReason(client) {
  if (!client) return null;
  for (const [re, what] of KIND_RULES) if (re.test(client)) return what;
  return null;
}

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// subver (Client) is fully attacker-controlled - any P2P peer can set an
// arbitrary user-agent string - so it must never go into innerHTML
// unescaped. Applied to address/label too as cheap defense in depth.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

// Address and Client can both be long enough to blow up the whole table's
// width (a long subver string in particular forces every other column wide
// too under auto table layout) - cap them visually with an ellipsis and put
// the full value in a title tooltip instead of just letting them run wide.
function truncatedCell(text) {
  const safe = escapeHtml(text);
  return `<td class="cell-truncate" title="${safe}">${safe}</td>`;
}

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
  PEER_MAP_INSTALLED = Boolean(s.peerMapInstalled);
  const siblingLink = document.getElementById('sibling-link');
  if (siblingLink) {
    siblingLink.hidden = !PEER_MAP_INSTALLED;
    if (PEER_MAP_INSTALLED) siblingLink.href = peerMapURL(null);
  }
  // The peer count comes from SQLite and the block height from a Bitcoin
  // Core RPC call. Tying them together meant a single RPC hiccup (Core
  // restarting, still in IBD, a timeout) replaced a perfectly good peer
  // count with "connecting…" - reporting the app as broken when only the
  // one cosmetic value was missing.
  const el = document.getElementById('status');
  const parts = [s.network, `${s.live.total} peers connected`];
  if (s.databaseBytes) parts.push(fmtBytes(s.databaseBytes));
  el.textContent = parts.join(' · ');
  // How sharp the First measurement actually is on THIS node, in the line
  // that already exists rather than a new one. Core's last_block has
  // one-second resolution, so two peers handing the same block over inside
  // one second both get the credit; how often that happens depends on the
  // node, so it is counted rather than claimed. Its own element because it is
  // the only part of this line that needs explaining.
  if (s.firstTies) {
    const ties = document.createElement('span');
    ties.className = 'status-ties';
    ties.textContent = ` · ${s.firstTies.ties.toLocaleString()} ${s.firstTies.ties === 1 ? 'tie' : 'ties'}`
      + ` in ${s.firstTies.races.toLocaleString()} ${s.firstTies.races === 1 ? 'block' : 'blocks'}`;
    ties.title = 'Two peers credited with the same block. Core reports last_block in whole'
      + ' seconds, so peers that hand a block over within the same second cannot be told'
      + ' apart - both keep the First.';
    el.appendChild(ties);
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

  const stats = [
    ['Total', s.live.total],
    ['Inbound', s.live.inbound],
    ['Outbound', s.live.outbound],
    ['Manual', s.live.manual],
    ['Full Relay', s.live.outboundFullRelay],
    ['Block Relay Only', s.live.blockRelayOnly],
  ];
  document.getElementById('live-stats').innerHTML = stats
    .map(([label, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${label}</div></div>`)
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
  // than showing a 42px dash that reads as a fault in this app. The markup
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
  heightEl.textContent = height.toLocaleString();
  if (lastKnownHeight != null && height > lastKnownHeight) {
    heightEl.classList.remove('bump');
    void heightEl.offsetWidth; // restart the CSS transition
    heightEl.classList.add('bump');
  }
  lastKnownHeight = height;
}

// Who mined the block that just landed. Three states, and the difference
// matters: a pool we recognise gets its short name, an unknown miner gets the
// text he wrote into his own coinbase (in quotes, so it never reads as a name
// we are vouching for), and a block that says neither shows nothing at all.
function setBlockPool(race) {
  const el = document.getElementById('block-pool');
  if (!el) return;
  const known = race && race.pool;
  const raw = race && !known && race.poolTag ? race.poolTag : null;
  el.classList.toggle('raw', Boolean(raw));
  if (known) {
    el.textContent = race.pool;
    el.title = `Mined by ${race.poolName}, from the block's coinbase`;
  } else if (raw) {
    el.textContent = `"${raw}"`;
    el.title = 'No pool we know of. This is the text the miner wrote into the block.';
  } else {
    el.textContent = '';
    el.removeAttribute('title');
  }
  el.hidden = !(known || raw);
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
function scrollToFocusOnce() {
  if (!FOCUS_ADDRESS || focusDone) return;
  const row = document.querySelector('tr.row-focus');
  if (!row) return;
  focusDone = true;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
// it - see peer-sync.js removeTrustedPeer) instead of "Add as Manual": as
// long as a peer is still addnode'd, Core just reconnects it right back, so
// a bare Disconnect on a manual peer normally wouldn't accomplish anything
// lasting - that's still true in the dedicated Manual Peers panel below,
// which is why it only ever gets "Remove" there (options.allowDisconnect
// stays false for that table). The Live Peer Ranking overview is different:
// it's the "what's actually connected right now" view, and someone watching
// it may well want to kick a manual peer's current connection (e.g. to
// force a reconnect) without forgetting it entirely - so that table passes
// allowDisconnect: true to also offer Disconnect there even for a trusted
// peer.
//
// Both actions always render into a fixed two-slot layout (primary action,
// then Disconnect) using an empty placeholder - never an omitted element -
// for whichever slot doesn't apply to a given row. Without this, a row
// missing its first slot (e.g. a source-obscured peer with no "Add as
// Manual") would have Disconnect visually collapse into the first slot's
// position instead of staying put, making the column misalign row to row.
// The star: lit means the rotation leaves this peer alone - it is not swapped
// out for a better-scoring candidate, and not parked when it goes offline.
// Both the state and the control, because they are the same thing to the
// person looking at it. A star on its own explains nothing, so the title says
// in words what it does and what clicking will do next.
function keepStar(p) {
  const on = Boolean(p.kept);
  const title = on ? 'Kept - click to release' : 'Click to keep';
  return `<button class="keep-star${on ? ' on' : ''}" data-action="keep" data-address="${escapeHtml(p.address)}" data-kept="${on ? '1' : '0'}" title="${title}" aria-pressed="${on}"><span aria-hidden="true">★</span><span class="sr-only">Keep this peer</span></button>`;
}

function actionsCell(p, options = {}) {
  const { allowDisconnect = false } = options;
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
  const primary = p.trusted
    ? `<button class="secondary action-slot" data-action="untrust" data-address="${escapeHtml(p.address)}">Remove</button>`
    : ((p.sourceObscured || p.localUmbrelPeer || p.privateNetwork)
      ? placeholder
      : `<button class="secondary action-slot" data-action="add-manual" data-address="${escapeHtml(p.address)}">Add as Manual</button>`);

  // Disconnect still works fine for a source-obscured peer: it's exactly
  // the (masked) address Core itself uses internally for the connection.
  // A local Umbrel peer (another app on this same host, e.g. electrs) is
  // different - deliberately disconnecting it could interrupt whatever that
  // app is doing, and Core would likely just let it right back in anyway,
  // so there's no real action to offer there either.
  const canDisconnect = p.live && !p.localUmbrelPeer && (allowDisconnect || !p.trusted);
  const disconnect = canDisconnect
    ? `<button class="secondary danger action-slot" data-action="disconnect" data-address="${escapeHtml(p.address)}">Disconnect</button>`
    : placeholder;

  return `${primary}${disconnect}`;
}

function clientCell(p) {
  return truncatedCell(p.client || '-');
}

// Session column: current connected duration when live, otherwise how long
// a trusted peer has been offline. Core keeps trying to reconnect a manual
// peer on its own, but that can silently stall (peer went dark, network
// hiccup, slot contention) - a flat "MANUAL OFFLINE" pill doesn't say
// whether that happened 30 seconds or 3 days ago, so show the duration
// instead of just '-'.
function sessionCell(p) {
  if (p.live) return `<td>${fmtDuration(p.currentSessionMs)}</td>`;
  if (p.offlineSinceMs != null) {
    return `<td class="hint" title="Last seen connected ${fmtDuration(p.offlineSinceMs)} ago">offline ${fmtDuration(p.offlineSinceMs)}</td>`;
  }
  return `<td>-</td>`;
}

// Single combined "how good is this peer" column: percentage first, with
// the raw first/eligible counts as a tooltip - replaces the previous
// separate First/Elig + First % columns (redundant, and wasted width).
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
 * The lifetime pair is not dropped, it moves into the tooltip. It is still the
 * right number for what a peer has been worth over its life, and it is still
 * what the offline grace, the parking retention and the re-probe interval are
 * scaled by - so the parked table and the rotation log keep showing it.
 */
function firstPctCell(p) {
  const windowed = p.recentEligible > 0;
  const pct = windowed ? (100 * p.recentFirst) / p.recentEligible : p.firstPct;
  const counts = windowed ? `${p.recentFirst}/${p.recentEligible}` : `${p.first}/${p.eligible}`;
  const lifetime = p.eligible > 0
    ? `Over its whole record: ${fmtPct(p.firstPct)} (${p.first}/${p.eligible}).`
    : 'No lifetime record yet.';
  const title = windowed
    ? `${p.recentFirst} of the ${p.recentEligible} blocks this peer was connected for inside the ranking window. ${lifetime}`
    : `${p.first} of ${p.eligible} eligible blocks`;
  return `<td title="${escapeHtml(title)}">${fmtPct(pct)}<span class="hint"> (${counts})</span></td>`;
}

// The clearnet note under Outbound Peers used to get a live count of Tor/I2P
// peers appended to it. Removed: the note is advice about a setting, and the
// peers it talks about are already named as Tor or I2P in their own address
// cell, with the reason in that cell's tooltip. A sentence repeating that
// above the table said the same thing twice.

const LIVE_PEER_LIMIT = 10;
let showAllLivePeers = false; // toggled by #live-peer-limit-toggle

// The rotation log is a diary, and a diary is mostly interesting at the end.
// Fifty rows is half a screenful nobody asked for, so only the most recent few
// are shown until someone wants the rest.
const ROTATION_LOG_LIMIT = 5;
let showAllRotationLog = false; // toggled by #rotation-log-limit-toggle
let lastRotationLog = null; // kept so the toggle can re-render without refetching

// The most recent ranking payload, kept so purely visual changes (the "show
// all" toggle) can re-render from it instead of re-fetching the single most
// expensive endpoint this app has just to slice the same array differently.
let lastPeerRanking = null;

async function refreshPeers() {
  const peers = await api('/api/peers/ranking');
  lastPeerRanking = peers;
  renderPeerTables(peers);
}

// A peer that connected in over IPv6 through Docker's docker-proxy relay
// (rather than a direct/NAT-preserved connection) has its real address
// replaced by Core with Docker's own internal gateway - showing that raw
// address would just be confusing/misleading, since it looks like a real
// peer IP but isn't and can't be acted on (see actionsCell). Label it
// honestly instead.
function addressCell(p) {
  if (p.sourceObscured) {
    return `<td class="cell-truncate hint" title="Core reports this connection's address as ${escapeHtml(p.address)} - Docker's inbound IPv6 relay (docker-proxy) re-originates the connection from its own internal gateway, so the peer's real address is never visible to Core itself, let alone to us. This is a Docker networking limitation, not an error.">IPv6 peer (address hidden by Docker)</td>`;
  }
  // Not a real external peer at all - another app on this same Umbrel host
  // (electrs, mempool's indexer, etc.) connecting to Core's P2P port
  // directly. The address is genuinely accurate here (unlike sourceObscured
  // above), so it's shown in the tooltip for anyone curious, but the label
  // itself is far more useful than a bare internal Docker IP.
  if (p.localUmbrelPeer) {
    const label = p.localAppName ? `Local Umbrel app: ${p.localAppName}` : 'Local Umbrel app';
    return `<td class="cell-truncate hint" title="${escapeHtml(p.address)} - another app container on this Umbrel connecting to Bitcoin Core's P2P port directly, not an external peer.">${escapeHtml(label)}</td>`;
  }
  // A Tor / I2P / CJDNS peer that dialled in reaches Core through this
  // Umbrel's own proxy container, so the address Core reports belongs to that
  // container, not to the peer. It used to be shown raw, which named a
  // neighbour of ours and said nothing about the peer - the word Tor appeared
  // only as a note in the actions column, at the far end of the row.
  if (p.proxiedPrivatePeer) {
    return `<td class="cell-truncate hint" title="${escapeHtml(p.address)} - this peer reached your node over ${escapeHtml(p.privateNetwork)}, so the address Bitcoin Core sees is your own ${escapeHtml(p.privateNetwork)} proxy's, not the peer's. Its real address is never visible to Core, and this app dials out over plain TCP only - so it can never be made a manual peer. It still ranks normally and can still deliver a block first.">${escapeHtml(p.privateNetwork)} peer</td>`;
  }
  // With Peer Map installed the address becomes the way over: same peer, the
  // other question. Without it, a plain cell - no dead links.
  if (PEER_MAP_INSTALLED) {
    const safe = escapeHtml(p.address);
    return `<td class="cell-truncate" title="${safe}"><a class="peer-jump" href="${escapeHtml(peerMapURL(p.address))}" target="_blank" rel="noopener" title="Show this peer in Peer Map">${safe}</a></td>`;
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

function interactionInProgress(selector) {
  if (actionsInFlight > 0) return true;
  const active = document.activeElement;
  return Boolean(active && active.closest && active.closest(selector));
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
 * One row of a peer table - the same nine cells for all three of them.
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
 *            Disconnect, and only the manual table carries the star.
 */
// The pill is struck through when the peer runs software that does not relay
// blocks. The explanation lives in the tooltip, not in the table: a dashboard is
// not the place for a paragraph.
function statusPill(p, status) {
  const reason = cannotRelayReason(p.client);
  if (!reason) return `<span class="pill ${statusPillClass(status)}">${status}</span>`;
  const title = escapeHtml(`Connected and counted, but ${reason} - it does not pass blocks on, so it can never deliver one first.`);
  // The type colour stays; the strike is what says "never in the running".
  return `<span class="pill ${statusPillClass(status)} norelay" title="${title}">${status}</span>`;
}

function peerRow(p, { status = p.status, actions }) {
  return `
    <tr class="${rowClassFor(p.address)}">
      ${addressCell(p)}
      ${clientCell(p)}
      <td class="col-status">${statusPill(p, status)}</td>
      ${firstPctCell(p)}
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      ${sessionCell(p)}
      <td>${fmtDuration(p.totalConnectionMs)}</td>
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
function renderPeerTables(peers, options = {}) {
  if (!options.force && deferRender('peers', '.peer-table', () => renderPeerTables(peers))) return;
  const livePeers = peers.filter((p) => p.live);
  // Manuals get their own dedicated panel below - keep them out of Outbound
  // entirely rather than showing the same peer in two tables.
  const outboundPeers = livePeers.filter((p) => p.direction === 'outbound' && !p.trusted);
  const manualPeers = peers.filter((p) => p.trusted);

  // The ranking table can get long with a lot of live peers - show only the
  // top LIVE_PEER_LIMIT (already sorted best-first by the API) by default,
  // with a toggle to see the rest on demand rather than always scrolling a
  // huge table.
  scrollToFocusOnce();
  const visibleLivePeers = showAllLivePeers ? livePeers : livePeers.slice(0, LIVE_PEER_LIMIT);
  const limitToggle = document.getElementById('live-peer-limit-toggle');
  const countLabel = document.getElementById('live-peer-count');
  if (countLabel) {
    countLabel.textContent = livePeers.length <= LIVE_PEER_LIMIT
      ? `${livePeers.length} connected`
      : `showing ${visibleLivePeers.length} of ${livePeers.length} connected`;
  }
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
    .map((p) => peerRow(p, { actions: actionsCell(p, { allowDisconnect: true }) }))
    .join('') || `<tr><td colspan="9" class="hint">No peers currently connected.</td></tr>`;

  document.querySelector('#outbound-peer-table tbody').innerHTML = outboundPeers
    .map((p) => peerRow(p, { status: p.connectionStatus, actions: actionsCell(p) }))
    .join('') || `<tr><td colspan="9" class="hint">No non-manual outbound peers currently connected.</td></tr>`;

  // A slot is taken by a manual peer whether or not it happens to be
  // connected right now: Core keeps retrying an offline one and it still
  // counts against MAX_ADDNODE_CONNECTIONS. Counting only live peers showed
  // free slots that did not exist - and the rotation loop, which used the
  // same wrong count, kept promoting peers into them.
  const liveManualSlots = manualPeers.filter((p) => p.live).length;
  const freeManualSlots = Math.max(0, MAX_MANUAL_PEERS - manualPeers.length);
  // Free capacity (below the app's manual-connection cap) as actual empty
  // rows, not just the text summary below - "how much room is left" reads
  // the same way the filled rows above it do, at a glance. Plain dashes,
  // same as any other empty cell in this app - no banner, no border
  // treatment, just an empty-looking row.
  const emptySlotRows = Array.from({ length: freeManualSlots }, () => `
    <tr class="empty-slot">
      <td colspan="8">-</td>
      <td class="row-actions"></td>
    </tr>
  `).join('');

  const manualRows = manualPeers
    .map((p) => peerRow(p, { actions: keepStar(p) + actionsCell(p) }))
    .join('');
  const noManualPeersHint = manualPeers.length === 0
    ? `<tr><td colspan="9" class="hint">No manual peers yet - use "Add as Manual" on a peer above, or the Add a Peer box to enter an address yourself.</td></tr>`
    : '';
  document.querySelector('#manual-peer-table tbody').innerHTML = manualRows + noManualPeersHint + emptySlotRows;

  const slotsEl = document.getElementById('manual-slots');
  if (slotsEl) {
    // With the star set by default on anything added by hand, every slot
    // being kept is the likely end state rather than an oddity - and it is
    // worth saying, because it means the rotation has nothing left to promote
    // into. Said as one more number, not as a warning: nothing is wrong.
    const keptCount = manualPeers.filter((p) => p.kept).length;
    const keptNote = keptCount > 0
      ? ` · ${keptCount === manualPeers.length ? 'all kept' : `${keptCount} kept`}`
      : '';
    slotsEl.textContent = `(${freeManualSlots} of ${MAX_MANUAL_PEERS} slots free · ${liveManualSlots} connected · ${manualPeers.length} total${keptNote})`;
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
const ROTATION_ACTIONS = new Set(['kick', 'promote', 'swap', 'park', 'revive']);
function rotationActionClass(action) {
  return ROTATION_ACTIONS.has(action) ? `rotation-${action}` : 'offline';
}

function rotationActionLabel(action) {
  if (action === 'kick') return 'Kicked';
  if (action === 'promote') return 'Promoted';
  if (action === 'swap') return 'Swapped in';
  if (action === 'park') return 'Parked';
  if (action === 'revive') return 'Back';
  return action;
}

// The peers that lost a manual slot to a long absence, and are being knocked
// on periodically. Shown next to the rotation log rather than hidden in it,
// because "my manual peer is gone" and "my manual peer is gone AND being
// watched for a comeback" are very different pieces of news, and only the
// second one is true.
function renderParkedPeers(parked) {
  const panel = document.getElementById('parked-peers');
  const tbody = document.querySelector('#parked-peer-table tbody');
  if (!panel || !tbody) return;
  if (!parked || parked.length === 0) {
    panel.hidden = true;
    tbody.innerHTML = '';
    return;
  }
  panel.hidden = false;
  const now = Date.now();
  tbody.innerHTML = parked.map((p) => `
    <tr>
      ${truncatedCell(p.address)}
      <td title="${p.eligible == null ? 'no record' : `over ${p.eligible} eligible blocks`}">${fmtPct(p.firstPct)}</td>
      <td class="hint">${fmtDuration(now - p.parkedAt)} ago</td>
      <td class="hint">${p.lastProbeAt == null ? 'not yet' : `${fmtDuration(now - p.lastProbeAt)} ago`}</td>
      <td class="hint">${p.probeFailures}</td>
      <td class="hint" title="How long this peer's own record has earned - a good peer is remembered for months, a weak one for days">${fmtDuration(Math.max(0, p.forgottenAt - now))} left</td>
    </tr>
  `).join('');
}

async function refreshRotation() {
  const epochAtRequest = rotationToggleEpoch;
  const data = await api('/api/rotation');
  const toggle = document.getElementById('rotation-toggle');
  if (toggle && rotationToggleEpoch === epochAtRequest) toggle.checked = Boolean(data.enabled);

  renderParkedPeers(data.parked);

  lastRotationLog = data.log || [];
  renderRotationLog(lastRotationLog);
}

function renderRotationLog(log) {
  const tbody = document.querySelector('#rotation-log-table tbody');
  if (!tbody) return;

  const visible = showAllRotationLog ? log : log.slice(0, ROTATION_LOG_LIMIT);

  const countLabel = document.getElementById('rotation-log-count');
  if (countLabel) {
    countLabel.textContent = log.length <= ROTATION_LOG_LIMIT
      ? ''
      : `showing ${visible.length} of ${log.length}`;
  }

  const toggle = document.getElementById('rotation-log-limit-toggle');
  if (toggle) {
    toggle.hidden = log.length <= ROTATION_LOG_LIMIT;
    toggle.textContent = showAllRotationLog
      ? `Show latest ${ROTATION_LOG_LIMIT} only`
      : `Show all ${log.length}`;
  }

  tbody.innerHTML = visible.map((entry) => `
    <tr>
      <td class="hint" title="${escapeHtml(new Date(entry.at).toLocaleString())}">${fmtDuration(Date.now() - entry.at)} ago</td>
      <td><span class="pill ${rotationActionClass(entry.action)}">${escapeHtml(rotationActionLabel(entry.action))}</span></td>
      ${truncatedCell(entry.address)}
      <td>${fmtPct(entry.firstPct)}</td>
      <td class="hint">${escapeHtml(entry.note || '-')}${entry.replacedAddress ? ` <span title="${escapeHtml(entry.replacedAddress)}">(replaced ${fmtPct(entry.replacedFirstPct)} peer)</span>` : ''}</td>
    </tr>
  `).join('') || `<tr><td colspan="5" class="hint">No rotation activity yet.</td></tr>`;
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
  const body = document.getElementById('stratum-body');
  const offHint = document.getElementById('stratum-off-hint');
  if (body) body.hidden = !enabled;
  if (offHint) offHint.hidden = enabled;
}

async function refreshPools() {
  // Nothing to ask for while it is off, and nowhere to put the answer.
  if (document.getElementById('stratum-body')?.hidden) return;
  const range = document.getElementById('stratum-range').value;
  const pools = await api(`/api/pools?range=${encodeURIComponent(range)}`);
  renderPools(pools);
}

function renderPools(pools) {
  // Same guard as the peer tables: this one owns the enabled checkboxes, and
  // a poll landing on a just-clicked one puts it straight back.
  if (deferRender('pools', '#pool-table', () => renderPools(pools))) return;
  const tbody = document.querySelector('#pool-table tbody');
  tbody.innerHTML = pools.map((p) => `
    <tr>
      <td>${escapeHtml(p.label)}${p.wonLastRace ? ' <span class="trophy" title="Won the most recent race">🏆</span>' : ''}</td>
      <td>${escapeHtml(`${p.host}:${p.port}`)}</td>
      <td>${p.wins}</td>
      <td>${fmtPct(p.winPct)}</td>
      <td>${fmtMs(p.avgMs)}</td>
      <td>${fmtMs(p.medianMs)}</td>
      <td>${fmtMs(p.p90Ms)}</td>
      <td>${p.seen}</td>
      <td>${p.misses}</td>
      <td>
        <input type="checkbox" data-action="toggle-pool" data-id="${p.id}" ${p.enabled ? 'checked' : ''} />
      </td>
      <td><button class="secondary danger" data-action="delete-pool" data-id="${p.id}">Remove</button></td>
    </tr>
  `).join('');
}

// ---------------------------------------------------------------------------
// Traffic

function trafficConnCell(p) {
  if (!p.live) return '<td><span class="pill offline">not connected</span></td>';
  const kind = p.trusted ? 'manual' : p.connectionType === 'inbound' ? 'inbound' : 'outbound';
  return `<td><span class="pill ${kind}">${kind}</span></td>`;
}

// Grid labels are round numbers, so they get no decimals: "15 GB", not "15.00 GB".
function axisBytes(v, unit) {
  if (v === 0) return '0';
  const name = { 1: 'B', 1024: 'KB', [1024 ** 2]: 'MB', [1024 ** 3]: 'GB', [1024 ** 4]: 'TB' }[unit] || 'B';
  const n = v / unit;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ${name}`;
}

// Bars per UTC day: sent in the accent, received beside it in grey. One scale
// for both, so the two can be compared by eye.
function trafficChartSvg(days) {
  const W = 720, H = 180, top = 10, bottom = 22, left = 54, right = 8;
  const max = Math.max(1, ...days.map((d) => Math.max(d.sent || 0, d.recv || 0)));
  // A round step for the grid: 1, 2 or 5 times a power of 1024-based units.
  const unit = 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024)));
  const raw = max / unit / 3;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((m) => m >= raw) * unit;
  const top_ = Math.ceil(max / step) * step;
  const y = (v) => top + (H - top - bottom) * (1 - v / top_);
  const slot = (W - left - right) / days.length;
  const bw = Math.max(2, slot * 0.36);
  let g = '';
  for (let v = 0; v <= top_ + 1; v += step) {
    g += `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text class="axis" x="${left - 6}" y="${y(v) + 3}" text-anchor="end">${escapeHtml(axisBytes(v, unit))}</text>`;
  }
  days.forEach((d, i) => {
    const x = left + i * slot + slot / 2;
    if (d.sent != null) {
      g += `<rect class="sent" x="${x - bw}" y="${y(d.sent)}" width="${bw}" height="${y(0) - y(d.sent)}"><title>${escapeHtml(`${d.day}: sent ${fmtBytes(d.sent)}`)}</title></rect>`;
      g += `<rect class="recv" x="${x}" y="${y(d.recv)}" width="${bw}" height="${y(0) - y(d.recv)}"><title>${escapeHtml(`${d.day}: received ${fmtBytes(d.recv)}`)}</title></rect>`;
    }
    if (i % 5 === 0 || i === days.length - 1) {
      g += `<text class="axis" x="${x}" y="${H - 6}" text-anchor="middle">${escapeHtml(d.day.slice(5))}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

// The same way over to Peer Map as addressCell gives the other tables. The row
// is a host, but Peer Map finds a peer by its full address, so the link uses
// the one the ranking knows; a host the ranking has never seen stays plain.
function trafficHostCell(p) {
  if (!PEER_MAP_INSTALLED || !p.address) return truncatedCell(p.host);
  const safe = escapeHtml(p.host);
  return `<td class="cell-truncate" title="${escapeHtml(p.address)}"><a class="peer-jump" href="${escapeHtml(peerMapURL(p.address))}" target="_blank" rel="noopener" title="Show this peer in Peer Map">${safe}</a></td>`;
}

async function refreshTraffic() {
  const t = await api('/api/traffic');
  const both = (v) => `↑ ${fmtBytes(v.sent)} · ↓ ${fmtBytes(v.recv)}`;
  document.getElementById('traffic-today').textContent = t.since ? `today ${both(t.today)}` : '';
  document.getElementById('traffic-totals').innerHTML = t.since
    ? [['Today', t.today], ['Last 7 days', t.week], ['Last 30 days', t.month]]
      .map(([l, v]) => `<div class="t"><span class="l">${l}</span><span class="v">${escapeHtml(both(v))}</span></div>`)
      .join('') + '<span class="traffic-legend"><span><i class="sent"></i>sent</span><span><i class="recv"></i>received</span></span>'
    : '<p class="hint">Nothing recorded yet - the first numbers appear within an hour of the app starting.</p>';
  document.getElementById('traffic-chart').innerHTML = t.since ? trafficChartSvg(t.days) : '';
  document.querySelector('#traffic-peer-table tbody').innerHTML = t.peers.map((p) => `
    <tr>
      ${trafficHostCell(p)}
      ${trafficConnCell(p)}
      <td class="num">${fmtBytes(p.sent)}</td>
      <td class="num">${fmtBytes(p.recv)}</td>
      <td class="num" title="${escapeHtml(p.first == null ? 'no record' : `${p.first} blocks first`)}">${fmtPct(p.firstPct)}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="hint">No traffic recorded yet.</td></tr>';
}

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
  reportRefreshHealth(failed.map((r) => r.reason));
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

document.getElementById('rotation-log-limit-toggle').addEventListener('click', () => {
  showAllRotationLog = !showAllRotationLog;
  // Purely a client-side slice of data already in hand. No scroll correction
  // here: the log sits at the bottom of its panel and the button moves with
  // it, so collapsing cannot strand the reader the way the peer table can.
  if (lastRotationLog) renderRotationLog(lastRotationLog);
});

document.getElementById('live-peer-limit-toggle').addEventListener('click', () => {
  const collapsing = showAllLivePeers;
  showAllLivePeers = !showAllLivePeers;
  // Purely a client-side slice of data already in hand - and forced, because
  // this is the user acting, not a poll arriving.
  if (lastPeerRanking) renderPeerTables(lastPeerRanking, { force: true });
  else refreshPeers();

  // Collapsing removes however many rows were on screen - potentially
  // thousands of pixels of them - and the browser keeps the scroll offset it
  // had, clamping it to the now much shorter page. The reader clicked "show
  // top 10" and landed somewhere near the bottom of the document with the
  // peer table nowhere in sight: the table looked like it had disappeared
  // rather than shrunk. Put the card back where it was before expanding.
  //
  // Only when the card has actually scrolled off the top - if it is already
  // in view, moving the page underneath someone is its own kind of rude.
  if (!collapsing) return;
  const card = document.getElementById('live-peer-card');
  if (card && card.getBoundingClientRect().top < 0) {
    card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
});

// Add and Test share the same input and the same result line, and both take
// seconds (a TCP handshake against each candidate port, with a 3s timeout
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
  try {
    await api('/api/pools', {
      method: 'POST',
      body: JSON.stringify({ label: label.value, host: host.value, port: Number(port.value) }),
    });
    resultEl.textContent = 'added';
    label.value = ''; host.value = ''; port.value = '';
    refreshPools();
  } catch (err) {
    resultEl.textContent = err.message;
  }
});

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

// Quick-fill for the solo pools available in the Umbrel app store - all three
// of them, as of now.
//
// A local pool app is not reachable at umbrel.local, and the port a miner on
// the LAN connects to is the app's externally-published port, not its internal
// one. Bitcoin Lab is already a container on the same network as the pool, so
// it needs the pool's container name (<app-id>_<service>_1) and the port the
// stratum server actually listens on inside its container.
//
// Those two numbers are not always the same. GoBrrr and Bassin both run
// ckpool on container-internal 3333 and publish it externally under a
// different number (21420 and 3456), so only 3333 works from in here. Public
// Pool is the exception that makes the point worth stating: it listens on
// 2018 (STRATUM_PORT=2018 in its app manifest) and publishes it unchanged, so
// 2018 is right on both sides.
const LOCAL_POOL_TEMPLATES = {
  gobrrr: { label: 'GoBrrr', host: 'gobrrr-pool_ckpool_1', port: 3333 },
  bassin: { label: 'Bassin', host: 'bassin_ckpool_1', port: 3333 },
  'public-pool': { label: 'Public Pool', host: 'public-pool_server_1', port: 2018 },
};

document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, address, id, template } = btn.dataset;

  if (action === 'fill-pool-template') {
    const t = LOCAL_POOL_TEMPLATES[template];
    if (!t) return;
    document.getElementById('pool-label').value = t.label;
    document.getElementById('pool-host').value = t.host;
    document.getElementById('pool-port').value = t.port;
    document.getElementById('pool-add-form').querySelector('button[type="submit"]').focus();
    return;
  }
  const isPeerOrPoolAction = PEER_ACTIONS.has(action) || POOL_ACTIONS.has(action);
  const originalLabel = btn.textContent;
  if (isPeerOrPoolAction) {
    btn.disabled = true;
    // The star is an icon, not a label - replacing its text with an ellipsis
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
      showToast(
        result.warning
          ? `Added as manual peer: ${result.address} - ${result.warning}`
          : `Added as manual peer: ${result.address}. It now shows in the Manual Peers panel below.`,
        'success',
      );
    }
    if (action === 'untrust') {
      await api('/api/peers/untrust', { method: 'POST', body: JSON.stringify({ address }) });
      showToast(`Removed ${address} as manual peer and disconnected it.`, 'success');
    }
    if (action === 'disconnect') {
      await api('/api/peers/disconnect', { method: 'POST', body: JSON.stringify({ address }) });
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
        btn.textContent = originalLabel;
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

  if (e.target.id === 'stratum-toggle') {
    const enabled = e.target.checked;
    try {
      const result = await api('/api/stratum/toggle', { method: 'POST', body: JSON.stringify({ enabled }) });
      applyStratumEnabled(Boolean(result.enabled));
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
      showToast(result.enabled ? 'Peer rotation turned on.' : 'Peer rotation turned off.', 'success');
      refreshRotation();
    } catch (err) {
      rotationToggleEpoch += 1;
      if (e.target.isConnected) e.target.checked = !enabled;
      showToast(`Could not change peer rotation: ${err.message}`, 'error');
    }
    return;
  }

  if (e.target.id === 'stratum-range') refreshPools();
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
 * Live block events. EventSource reconnects on its own (including after the
 * node or this app restarts), and the server replays the current block on
 * connect, so no state is lost across a drop.
 */
function startEventStream() {
  const source = new EventSource('/api/events');
  source.addEventListener('block', (e) => {
    try {
      applyBlockUpdate(JSON.parse(e.data));
    } catch (err) {
      /* malformed frame - the next event supersedes it */
    }
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
  set('reset-peers-size', `${fmtBytes(s.peerData.bytes)} · ${s.peerData.rows.toLocaleString()} rows`);
  set('reset-pools-size', `${fmtBytes(s.poolHistory.bytes)} · ${s.poolHistory.rows.toLocaleString()} rows`);
  set('reset-peers-detail', `${s.peerData.rows.toLocaleString()} rows, ${fmtBytes(s.peerData.bytes)}, will be deleted.`);
  set('reset-pools-detail', `${s.poolHistory.rows.toLocaleString()} rows, ${fmtBytes(s.poolHistory.bytes)}, will be deleted.`);
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

  ask.addEventListener('click', () => { panel.hidden = false; ask.hidden = true; });
  no.addEventListener('click', () => { panel.hidden = true; ask.hidden = false; });
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      await api('/api/reset', { method: 'POST', body: JSON.stringify({ scope }) });
    } finally {
      yes.disabled = false;
      panel.hidden = true;
      ask.hidden = false;
    }
    await refreshStorage();
    await refreshStatus();
    await refreshPeers();
  });
}

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
