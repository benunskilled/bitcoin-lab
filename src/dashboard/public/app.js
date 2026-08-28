'use strict';

const REFRESH_MS = 8000;
const BLOCK_POLL_MS = 2000;
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
// it - see peer-sync.js removeTrustedPeer) instead of "Disconnect": as long
// as a peer is still addnode'd, Core just reconnects it right back, so a
// bare Disconnect on a manual peer would do nothing useful. Untrusted peers
// get "Add as Manual" instead, which always re-probes the peer's host itself
// (see /api/peers/add-manual) rather than trusting whatever port it
// happened to be observed on.
function actionsCell(p) {
  const addOrRemove = p.trusted
    ? `<button class="secondary" data-action="untrust" data-address="${p.address}">Remove</button>`
    : `<button class="secondary" data-action="add-manual" data-address="${p.address}">Add as Manual</button>`;
  const disconnect = (p.live && !p.trusted)
    ? `<button class="secondary danger" data-action="disconnect" data-address="${p.address}">Disconnect</button>`
    : '';
  return `${addOrRemove}${disconnect}`;
}

function clientCell(p) {
  return truncatedCell(p.client || '-');
}

// Single combined "how good is this peer" column: percentage first, with
// the raw first/eligible counts as a tooltip - replaces the previous
// separate First/Elig + First % columns (redundant, and wasted width).
function firstPctCell(p) {
  const pctText = fmtPct(p.firstPct);
  return `<td title="${p.first} of ${p.eligible} eligible blocks">${pctText}<span class="hint"> (${p.first}/${p.eligible})</span></td>`;
}

async function refreshPeers() {
  const peers = await api('/api/peers/ranking');
  renderPeerTables(peers);
}

function addressCell(p, includeLabel) {
  const label = includeLabel && p.trustedLabel ? ` (${p.trustedLabel})` : '';
  return truncatedCell(`${p.address}${label}`);
}

function renderPeerTables(peers) {
  const livePeers = peers.filter((p) => p.live);
  // Manuals get their own dedicated panel below - keep them out of Outbound
  // entirely rather than showing the same peer in two tables.
  const outboundPeers = livePeers.filter((p) => p.direction === 'outbound' && !p.trusted);
  const manualPeers = peers.filter((p) => p.trusted);

  document.querySelector('#peer-table tbody').innerHTML = livePeers.map((p) => `
    <tr class="${highlightClassFor(p.address)}">
      ${addressCell(p, true)}
      ${clientCell(p)}
      <td><span class="pill ${statusPillClass(p.status)}">${p.status}</span></td>
      ${firstPctCell(p)}
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      <td>${fmtDuration(p.currentSessionMs)}</td>
      <td>${fmtDuration(p.totalConnectionMs)}</td>
      <td>${p.sessionsCount}</td>
      <td class="row-actions">${actionsCell(p)}</td>
    </tr>
  `).join('') || `<tr><td colspan="9" class="hint">No peers currently connected.</td></tr>`;

  document.querySelector('#outbound-peer-table tbody').innerHTML = outboundPeers.map((p) => `
    <tr class="${highlightClassFor(p.address)}">
      ${addressCell(p, false)}
      ${clientCell(p)}
      <td><span class="pill ${statusPillClass(p.connectionStatus)}">${p.connectionStatus}</span></td>
      ${firstPctCell(p)}
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      <td>${fmtDuration(p.currentSessionMs)}</td>
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
      <td>${fmtDuration(p.currentSessionMs)}</td>
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
  await Promise.allSettled([refreshStatus(), refreshPeers(), refreshPools(), pollLatestBlock()]);
}

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
