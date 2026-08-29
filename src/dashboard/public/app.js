'use strict';

// Peer/pool ranking is a slow-moving, historical stat, not a live combat
// feed - it doesn't need sub-10s freshness, and peerRanking() in particular
// runs several joined aggregate queries. Manual actions (add/remove/
// disconnect a peer, delete a pool) already trigger their own immediate
// refreshPeers()/refreshPools() call, so this interval only governs how
// stale the tables are allowed to get from someone else's activity (Core
// itself connecting/dropping peers) between clicks.
const REFRESH_MS = 20000;
// Kept separate and faster than REFRESH_MS purely for the "new block
// landed" wave/highlight - but doesn't need to be as tight as it once was;
// a few seconds of extra latency on a once-per-~10-minutes event is
// unnoticeable, and it cuts this endpoint's call volume by more than half.
const BLOCK_POLL_MS = 5000;
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
  const el = document.getElementById('status');
  el.textContent = s.blockHeight != null
    ? `${s.network} · ${s.live.total} peers connected`
    : `${s.network} · connecting…`;

  const heightEl = document.getElementById('block-height-number');
  if (s.blockHeight != null) {
    heightEl.textContent = s.blockHeight.toLocaleString();
    if (lastKnownHeight != null && s.blockHeight > lastKnownHeight) {
      heightEl.classList.remove('bump');
      // eslint-disable-next-line no-void
      void heightEl.offsetWidth; // restart the CSS transition
      heightEl.classList.add('bump');
    }
    lastKnownHeight = s.blockHeight;
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

function triggerBlockWave() {
  const wave = document.getElementById('block-wave');
  wave.classList.remove('roll');
  // eslint-disable-next-line no-void
  void wave.offsetWidth; // restart the CSS animation
  wave.classList.add('roll');
}

async function pollLatestBlock() {
  let race;
  try {
    race = await api('/api/blocks/latest');
  } catch (err) {
    return; // transient - next poll will retry
  }
  if (!race) return;

  const hashEl = document.getElementById('block-hash-short');
  hashEl.textContent = `${race.blockHash.slice(0, 16)}…`;

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
  const primary = p.trusted
    ? `<button class="secondary action-slot" data-action="untrust" data-address="${p.address}">Remove</button>`
    : ((p.sourceObscured || p.localUmbrelPeer)
      ? placeholder
      : `<button class="secondary action-slot" data-action="add-manual" data-address="${p.address}">Add as Manual</button>`);

  // Disconnect still works fine for a source-obscured peer: it's exactly
  // the (masked) address Core itself uses internally for the connection.
  // A local Umbrel peer (another app on this same host, e.g. electrs) is
  // different - deliberately disconnecting it could interrupt whatever that
  // app is doing, and Core would likely just let it right back in anyway,
  // so there's no real action to offer there either.
  const canDisconnect = p.live && !p.localUmbrelPeer && (allowDisconnect || !p.trusted);
  const disconnect = canDisconnect
    ? `<button class="secondary danger action-slot" data-action="disconnect" data-address="${p.address}">Disconnect</button>`
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

const LIVE_PEER_LIMIT = 10;
let showAllLivePeers = false; // toggled by #live-peer-limit-toggle

async function refreshPeers() {
  const peers = await api('/api/peers/ranking');
  renderPeerTables(peers);
}

// A peer that connected in over IPv6 through Docker's docker-proxy relay
// (rather than a direct/NAT-preserved connection) has its real address
// replaced by Core with Docker's own internal gateway - showing that raw
// address would just be confusing/misleading, since it looks like a real
// peer IP but isn't and can't be acted on (see actionsCell). Label it
// honestly instead.
function addressCell(p, includeLabel) {
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
  const label = includeLabel && p.trustedLabel ? ` (${p.trustedLabel})` : '';
  return truncatedCell(`${p.address}${label}`);
}

function renderPeerTables(peers) {
  const livePeers = peers.filter((p) => p.live);
  // Manuals get their own dedicated panel below - keep them out of Outbound
  // entirely rather than showing the same peer in two tables.
  const outboundPeers = livePeers.filter((p) => p.direction === 'outbound' && !p.trusted);
  const manualPeers = peers.filter((p) => p.trusted);

  // The ranking table can get long with a lot of live peers - show only the
  // top LIVE_PEER_LIMIT (already sorted best-first by the API) by default,
  // with a toggle to see the rest on demand rather than always scrolling a
  // huge table.
  const visibleLivePeers = showAllLivePeers ? livePeers : livePeers.slice(0, LIVE_PEER_LIMIT);
  const limitToggle = document.getElementById('live-peer-limit-toggle');
  if (limitToggle) {
    if (livePeers.length <= LIVE_PEER_LIMIT) {
      limitToggle.hidden = true;
    } else {
      limitToggle.hidden = false;
      limitToggle.textContent = showAllLivePeers
        ? `Show top ${LIVE_PEER_LIMIT} only`
        : `Show all ${livePeers.length} (currently showing top ${LIVE_PEER_LIMIT})`;
    }
  }

  document.querySelector('#peer-table tbody').innerHTML = visibleLivePeers.map((p) => `
    <tr class="${highlightClassFor(p.address)}">
      ${addressCell(p, true)}
      ${clientCell(p)}
      <td><span class="pill ${statusPillClass(p.status)}">${p.status}</span></td>
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
      ${addressCell(p, false)}
      ${clientCell(p)}
      <td><span class="pill ${statusPillClass(p.connectionStatus)}">${p.connectionStatus}</span></td>
      ${firstPctCell(p)}
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      ${sessionCell(p)}
      <td class="row-actions">${actionsCell(p)}</td>
    </tr>
  `).join('') || `<tr><td colspan="7" class="hint">No non-manual outbound peers currently connected.</td></tr>`;

  document.querySelector('#manual-peer-table tbody').innerHTML = manualPeers.map((p) => `
    <tr class="${highlightClassFor(p.address)}">
      ${addressCell(p, false)}
      <td>${p.trustedLabel ? escapeHtml(p.trustedLabel) : '<span class="hint">-</span>'}</td>
      ${clientCell(p)}
      <td><span class="pill ${statusPillClass(p.status)}">${p.status}</span></td>
      ${firstPctCell(p)}
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      ${sessionCell(p)}
      <td class="row-actions">${actionsCell(p)}</td>
    </tr>
  `).join('') || `<tr><td colspan="8" class="hint">No manually trusted peers yet - use "Add as Manual" above or the manual-add field.</td></tr>`;

  const slotsEl = document.getElementById('manual-slots');
  if (slotsEl) {
    const used = manualPeers.filter((p) => p.live).length;
    const free = Math.max(0, MAX_MANUAL_PEERS - used);
    slotsEl.textContent = `(${free} of ${MAX_MANUAL_PEERS} slots free · ${used} active · ${manualPeers.length} total)`;
  }
}

async function refreshPools() {
  const range = document.getElementById('stratum-range').value;
  const pools = await api(`/api/pools?range=${encodeURIComponent(range)}`);
  const tbody = document.querySelector('#pool-table tbody');
  tbody.innerHTML = pools.map((p) => `
    <tr>
      <td>${p.label}${p.wonLastRace ? ' <span class="trophy" title="Won the most recent race">🏆</span>' : ''}</td>
      <td>${p.host}:${p.port}</td>
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
  // pollLatestBlock() is NOT included here - it already runs on its own,
  // faster BLOCK_POLL_MS interval below, so calling it again on every
  // REFRESH_MS tick as well was a pure duplicate fetch of the exact same
  // endpoint, not extra freshness.
  await Promise.allSettled([refreshStatus(), refreshPeers(), refreshPools()]);
}

document.getElementById('live-peer-limit-toggle').addEventListener('click', () => {
  showAllLivePeers = !showAllLivePeers;
  refreshPeers(); // re-fetch+render immediately rather than waiting for the next poll
});

document.getElementById('manual-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('manual-add-input');
  const resultEl = document.getElementById('manual-add-result');
  resultEl.textContent = 'connecting…';
  try {
    const result = await api('/api/peers/manual-add', { method: 'POST', body: JSON.stringify({ host: input.value }) });
    resultEl.textContent = result.warning ? `added ${result.address} - ${result.warning}` : `added ${result.address}`;
    input.value = '';
    refreshPeers();
  } catch (err) {
    resultEl.textContent = err.message;
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
// their own schedules (REFRESH_MS / BLOCK_POLL_MS above).
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

document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, address, id } = btn.dataset;
  const isPeerOrPoolAction = PEER_ACTIONS.has(action) || POOL_ACTIONS.has(action);
  const originalLabel = btn.textContent;
  if (isPeerOrPoolAction) {
    btn.disabled = true;
    btn.textContent = '…';
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
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
});

document.body.addEventListener('change', async (e) => {
  const chk = e.target.closest('input[data-action="toggle-pool"]');
  if (chk) {
    try {
      await api(`/api/pools/${chk.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: chk.checked }) });
      refreshPools();
    } catch (err) {
      alert(err.message);
      chk.checked = !chk.checked;
    }
    return;
  }

  if (e.target.id === 'stratum-range') refreshPools();
});

refreshAll();
setInterval(refreshAll, REFRESH_MS);
// Separate, faster loop just for "did a new block land" - keeps the wave
// and row highlight responsive without re-querying the full peer/pool
// tables every couple of seconds.
setInterval(pollLatestBlock, BLOCK_POLL_MS);
