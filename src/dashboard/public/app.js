'use strict';

const REFRESH_MS = 8000;

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
    ? `Block ${s.blockHeight} · ${s.network} · ${s.live.total} peers connected`
    : `${s.network} · connecting…`;

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

async function refreshPeers() {
  const peers = await api('/api/peers/ranking');
  const tbody = document.querySelector('#peer-table tbody');
  tbody.innerHTML = peers.map((p) => `
    <tr>
      <td>${p.address}${p.trustedLabel ? ` <span class="hint">(${p.trustedLabel})</span>` : ''}</td>
      <td><span class="pill ${statusPillClass(p.status)}">${p.status}</span></td>
      <td>${p.first}</td>
      <td>${p.eligible}</td>
      <td>${fmtPct(p.firstPct)}</td>
      <td>${p.minPingMs != null ? fmtMs(p.minPingMs) : '-'}</td>
      <td>${fmtDuration(p.currentSessionMs)}</td>
      <td>${fmtDuration(p.totalConnectionMs)}</td>
      <td>${p.sessionsCount}</td>
      <td class="row-actions">
        ${p.trusted
          ? `<button class="secondary" data-action="untrust" data-address="${p.address}">Untrust</button>`
          : `<button class="secondary" data-action="trust" data-address="${p.address}">Trust</button>`}
        ${p.live ? `<button class="secondary danger" data-action="disconnect" data-address="${p.address}">Disconnect</button>` : ''}
      </td>
    </tr>
  `).join('');
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
  await Promise.allSettled([refreshStatus(), refreshPeers(), refreshPools()]);
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
