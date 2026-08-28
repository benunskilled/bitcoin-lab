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
  if (status.includes('MANUAL')) return 'manual';
  if (status === 'OFFLINE' || status.includes('TRUSTED')) return 'offline';
  return 'live';
}

async function refreshStatus() {
  const s = await api('/api/status');
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

function actionsCell(p) {
  return `
    ${p.trusted
      ? `<button class="secondary" data-action="untrust" data-address="${p.address}">Untrust</button>`
      : `<button class="secondary" data-action="trust" data-address="${p.address}">Trust</button>`}
    ${p.live ? `<button class="secondary danger" data-action="disconnect" data-address="${p.address}">Disconnect</button>` : ''}
  `;
}

async function refreshPeers() {
  const peers = await api('/api/peers/ranking');
  renderPeerTables(peers);
}

function renderPeerTables(peers) {
  const livePeers = peers.filter((p) => p.live);
  const outboundPeers = livePeers.filter((p) => p.direction === 'outbound');
  const manualPeers = peers.filter((p) => p.trusted);

  document.querySelector('#peer-table tbody').innerHTML = livePeers.map((p) => `
    <tr class="${highlightClassFor(p.address)}">
      <td>${p.address}${p.trustedLabel ? ` <span class="hint">(${p.trustedLabel})</span>` : ''}</td>
      <td><span class="pill ${statusPillClass(p.status)}">${p.status}</span></td>
      <td>${p.first}</td>
      <td>${p.eligible}</td>
      <td>${fmtPct(p.firstPct)}</td>
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      <td>${fmtDuration(p.currentSessionMs)}</td>
      <td>${fmtDuration(p.totalConnectionMs)}</td>
      <td>${p.sessionsCount}</td>
      <td class="row-actions">${actionsCell(p)}</td>
    </tr>
  `).join('') || `<tr><td colspan="10" class="hint">No peers currently connected.</td></tr>`;

  document.querySelector('#outbound-peer-table tbody').innerHTML = outboundPeers.map((p) => `
    <tr class="${highlightClassFor(p.address)}">
      <td>${p.address}${p.trustedLabel ? ` <span class="hint">(${p.trustedLabel})</span>` : ''}</td>
      <td><span class="pill ${statusPillClass(p.status)}">${p.status}</span></td>
      <td>${fmtPct(p.firstPct)}</td>
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      <td>${fmtDuration(p.currentSessionMs)}</td>
      <td class="row-actions">${actionsCell(p)}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" class="hint">No outbound peers currently connected.</td></tr>`;

  document.querySelector('#manual-peer-table tbody').innerHTML = manualPeers.map((p) => `
    <tr class="${highlightClassFor(p.address)}">
      <td>${p.address}</td>
      <td>${p.trustedLabel || '-'}</td>
      <td><span class="pill ${statusPillClass(p.status)}">${p.status}</span></td>
      <td>${fmtPct(p.firstPct)}</td>
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      <td>${fmtDuration(p.currentSessionMs)}</td>
      <td class="row-actions">${actionsCell(p)}</td>
    </tr>
  `).join('') || `<tr><td colspan="7" class="hint">No manually trusted peers yet - use Trust above or the manual-add field.</td></tr>`;
}

async function refreshPools() {
  const pools = await api('/api/pools');
  const tbody = document.querySelector('#pool-table tbody');
  tbody.innerHTML = pools.map((p) => `
    <tr>
      <td>${p.label}</td>
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
    resultEl.textContent = `added ${result.address}`;
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

document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, address, id } = btn.dataset;
  try {
    if (action === 'trust') await api('/api/peers/trust', { method: 'POST', body: JSON.stringify({ address }) });
    if (action === 'untrust') await api('/api/peers/untrust', { method: 'POST', body: JSON.stringify({ address }) });
    if (action === 'disconnect') await api('/api/peers/disconnect', { method: 'POST', body: JSON.stringify({ address }) });
    if (action === 'delete-pool') await api(`/api/pools/${id}`, { method: 'DELETE' });
    refreshAll();
  } catch (err) {
    // eslint-disable-next-line no-alert
    alert(err.message);
  }
});

document.body.addEventListener('change', async (e) => {
  const chk = e.target.closest('input[data-action="toggle-pool"]');
  if (!chk) return;
  try {
    await api(`/api/pools/${chk.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: chk.checked }) });
  } catch (err) {
    alert(err.message);
    chk.checked = !chk.checked;
  }
});

refreshAll();
setInterval(refreshAll, REFRESH_MS);
// Separate, faster loop just for "did a new block land" - keeps the wave
// and row highlight responsive without re-querying the full peer/pool
// tables every couple of seconds.
setInterval(pollLatestBlock, BLOCK_POLL_MS);
