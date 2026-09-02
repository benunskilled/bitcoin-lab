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

function statusPillClass(status) {
  if (status === 'OFFLINE' || status === 'MANUAL OFFLINE') return 'offline';
  if (status.includes('MANUAL')) return 'manual';
  return 'live';
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
  // The peer count comes from SQLite and the block height from a Bitcoin
  // Core RPC call. Tying them together meant a single RPC hiccup (Core
  // restarting, still in IBD, a timeout) replaced a perfectly good peer
  // count with "connecting…" - reporting the app as broken when only the
  // one cosmetic value was missing.
  const el = document.getElementById('status');
  el.textContent = `${s.network} · ${s.live.total} peers connected`;

  setBlockHeight(s.blockHeight);

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
  if (height == null) {
    if (lastKnownHeight == null) heightEl.textContent = '–';
    return;
  }
  if (lastKnownHeight != null && height < lastKnownHeight) return;

  heightEl.textContent = height.toLocaleString();
  if (lastKnownHeight != null && height > lastKnownHeight) {
    heightEl.classList.remove('bump');
    // eslint-disable-next-line no-void
    void heightEl.offsetWidth; // restart the CSS transition
    heightEl.classList.add('bump');
  }
  lastKnownHeight = height;
}

function triggerBlockWave() {
  const wave = document.getElementById('block-wave');
  wave.classList.remove('roll');
  // eslint-disable-next-line no-void
  void wave.offsetWidth; // restart the CSS animation
  wave.classList.add('roll');
}

// Called with the payload of a `block` event from /api/events (and once on
// connect with the current state), so this no longer fetches anything.
function applyBlockUpdate(race) {
  if (!race) return;

  const hashEl = document.getElementById('block-hash-short');
  hashEl.textContent = `${race.blockHash.slice(0, 16)}…`;

  // The height rides along on this event. Reading it here is what keeps the
  // big number in step with the wave and the highlighted rows - it used to
  // wait for the next 20-second status poll, so it jumped at a moment
  // unrelated to anything the viewer had just seen. Nullable in the schema
  // (it is backfilled by a separate RPC after the race is recorded), so only
  // set it when it is actually there.
  if (race.blockHeight != null) setBlockHeight(race.blockHeight);

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
function actionsCell(p, options = {}) {
  const { allowDisconnect = false } = options;
  const placeholder = `<span class="action-slot" aria-hidden="true"></span>`;

  // A source-obscured peer's "address" is Docker's own relay gateway, not
  // the peer's real one (see queries.js) - there's nothing real to probe or
  // addnode, so "Add as Manual" would just try to add Docker's internal
  // gateway as a manual peer.
  // A Tor, I2P or CJDNS peer gets a reason rather than a button. The button
  // used to be offered and always failed, with "no node answering on 8333 or
  // 9333" - which reads as though the peer had the wrong port open, when in
  // fact this container has no way to reach that network at all and never
  // will. Saying so is more useful than letting someone try.
  // Deliberately NOT class="action-slot": that selector carries
  // `visibility: hidden` for the empty placeholders, which swallowed this
  // label whole - present in the DOM, invisible on screen. .action-note keeps
  // the same slot geometry and actually shows.
  const undialable = p.privateNetwork
    ? `<span class="action-note" title="A ${escapeHtml(p.privateNetwork)} peer reaches you over its own network, and this app dials out over plain TCP only - there is no address it can call back on, so it can never be made a manual peer. It still ranks normally and can still deliver a block first.">${escapeHtml(p.privateNetwork)} only</span>`
    : null;

  const primary = p.trusted
    ? `<button class="secondary action-slot" data-action="untrust" data-address="${escapeHtml(p.address)}">Remove</button>`
    : (undialable || ((p.sourceObscured || p.localUmbrelPeer)
      ? placeholder
      : `<button class="secondary action-slot" data-action="add-manual" data-address="${escapeHtml(p.address)}">Add as Manual</button>`));

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
function firstPctCell(p) {
  const pctText = fmtPct(p.firstPct);
  return `<td title="${p.first} of ${p.eligible} eligible blocks">${pctText}<span class="hint"> (${p.first}/${p.eligible})</span></td>`;
}

// The clearnet note under Outbound Peers is static advice; this makes it
// specific when it actually applies. A .onion peer can never be promoted - the
// port probe has no address to dial - so a node running its outgoing
// connections over Tor is collecting a ranking it cannot act on, and that is
// worth saying with a number rather than leaving as general guidance.
function reportTorPeers(livePeers) {
  const note = document.getElementById('outbound-note');
  if (!note) return;
  const existing = document.getElementById('tor-count');

  // Counted by network rather than lumped together: an operator who sees "3 on
  // I2P" knows which setting to look at, and "9 unreachable" tells them
  // nothing. Inbound I2P in particular is normal even with outgoing
  // connections set to clearnet only - those peers dialled you.
  const byNetwork = new Map();
  for (const p of livePeers) {
    if (!p.privateNetwork) continue;
    byNetwork.set(p.privateNetwork, (byNetwork.get(p.privateNetwork) || 0) + 1);
  }
  if (byNetwork.size === 0) {
    if (existing) existing.remove();
    return;
  }
  const parts = [...byNetwork.entries()].sort().map(([net, n]) => `${n} on ${net}`);
  const total = [...byNetwork.values()].reduce((a, b) => a + b, 0);
  const text = ` Right now ${parts.join(', ')} - ${total === 1 ? 'that peer ranks' : 'those peers rank'} normally but cannot be kept as manual connections.`;
  if (existing) { existing.textContent = text; return; }
  const span = document.createElement('span');
  span.id = 'tor-count';
  span.textContent = text;
  note.appendChild(span);
}

const LIVE_PEER_LIMIT = 10;
let showAllLivePeers = false; // toggled by #live-peer-limit-toggle

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
  reportTorPeers(livePeers);
  const manualPeers = peers.filter((p) => p.trusted);

  // The ranking table can get long with a lot of live peers - show only the
  // top LIVE_PEER_LIMIT (already sorted best-first by the API) by default,
  // with a toggle to see the rest on demand rather than always scrolling a
  // huge table.
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

  // All three tables below share the exact same column set, order, and
  // widths (see the shared .col-* classes in the markup / style.css) so
  // Address/Type/.../Actions line up vertically across panels instead of
  // each table sizing its columns independently from its own content.
  document.querySelector('#peer-table tbody').innerHTML = visibleLivePeers.map((p) => `
    <tr class="${highlightClassFor(p.address)}">
      ${addressCell(p)}
      ${clientCell(p)}
      <td class="col-status"><span class="pill ${statusPillClass(p.status)}">${p.status}</span></td>
      ${firstPctCell(p)}
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      ${sessionCell(p)}
      <td>${fmtDuration(p.totalConnectionMs)}</td>
      <td>${p.sessionsCount}</td>
      <td class="row-actions">${actionsCell(p, { allowDisconnect: true })}</td>
    </tr>
  `).join('') || `<tr><td colspan="9" class="hint">No peers currently connected.</td></tr>`;

  document.querySelector('#outbound-peer-table tbody').innerHTML = outboundPeers.map((p) => `
    <tr class="${highlightClassFor(p.address)}">
      ${addressCell(p)}
      ${clientCell(p)}
      <td class="col-status"><span class="pill ${statusPillClass(p.connectionStatus)}">${p.connectionStatus}</span></td>
      ${firstPctCell(p)}
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      ${sessionCell(p)}
      <td>${fmtDuration(p.totalConnectionMs)}</td>
      <td>${p.sessionsCount}</td>
      <td class="row-actions">${actionsCell(p)}</td>
    </tr>
  `).join('') || `<tr><td colspan="9" class="hint">No non-manual outbound peers currently connected.</td></tr>`;

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

  const manualRows = manualPeers.map((p) => `
    <tr class="${highlightClassFor(p.address)}">
      ${addressCell(p)}
      ${clientCell(p)}
      <td class="col-status"><span class="pill ${statusPillClass(p.status)}">${p.status}</span></td>
      ${firstPctCell(p)}
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      ${sessionCell(p)}
      <td>${fmtDuration(p.totalConnectionMs)}</td>
      <td>${p.sessionsCount}</td>
      <td class="row-actions">${actionsCell(p)}</td>
    </tr>
  `).join('');
  const noManualPeersHint = manualPeers.length === 0
    ? `<tr><td colspan="9" class="hint">No manual peers yet - use "Add as Manual" on a peer above, or the Add a Peer box to enter an address yourself.</td></tr>`
    : '';
  document.querySelector('#manual-peer-table tbody').innerHTML = manualRows + noManualPeersHint + emptySlotRows;

  const slotsEl = document.getElementById('manual-slots');
  if (slotsEl) {
    slotsEl.textContent = `(${freeManualSlots} of ${MAX_MANUAL_PEERS} slots free · ${liveManualSlots} connected · ${manualPeers.length} total)`;
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

  const tbody = document.querySelector('#rotation-log-table tbody');
  if (!tbody) return;
  tbody.innerHTML = (data.log || []).map((entry) => `
    <tr>
      <td class="hint" title="${escapeHtml(new Date(entry.at).toLocaleString())}">${fmtDuration(Date.now() - entry.at)} ago</td>
      <td><span class="pill ${rotationActionClass(entry.action)}">${escapeHtml(rotationActionLabel(entry.action))}</span></td>
      ${truncatedCell(entry.address)}
      <td>${fmtPct(entry.firstPct)}</td>
      <td class="hint">${escapeHtml(entry.note || '-')}${entry.replacedAddress ? ` <span title="${escapeHtml(entry.replacedAddress)}">(replaced ${fmtPct(entry.replacedFirstPct)} peer)</span>` : ''}</td>
    </tr>
  `).join('') || `<tr><td colspan="5" class="hint">No rotation activity yet.</td></tr>`;
}

async function refreshPools() {
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
const PEER_ACTIONS = new Set(['add-manual', 'untrust', 'disconnect']);
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
    btn.textContent = '…';
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
  if (down.length === 0) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.textContent = down.length === 1
    ? `The ${down[0]} service is not reporting in. Check its container logs - data it collects is not being recorded right now.`
    : `${down.length} background services are not reporting in (${down.join(', ')}). Check the app's container logs.`;
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
      await refreshRotation();
    } catch (err) {
      console.warn('rotation refresh failed', err);
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

startRefreshLoop();
startEventStream();
