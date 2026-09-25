'use strict';

const db = require('../db');
const { peerRanking } = require('./peer-ranking');
const { hostFromAddress } = require('../address');
const { dayOf } = require('../traffic');

const DAY_MS = 24 * 60 * 60 * 1000;

function sum(rows) {
  return rows.reduce((a, r) => ({ recv: a.recv + r.recv, sent: a.sent + r.sent }), { recv: 0, sent: 0 });
}

/**
 * The node's traffic: one row per UTC day for the chart, and the totals for
 * today, the last 7 and the last 30 days (today included). Days without a
 * row - the app was not running - are filled with nulls, not zeros: nothing
 * was measured, which is not the same as nothing sent.
 */
function trafficDays(days = 30, nowMs = Date.now()) {
  const from = dayOf(nowMs - (days - 1) * DAY_MS);
  const rows = db.instance
    .prepare(`SELECT day, recv, sent FROM traffic_day WHERE day >= ? ORDER BY day`)
    .all(from);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = dayOf(nowMs - i * DAY_MS);
    const r = byDay.get(day);
    out.push({ day, recv: r ? r.recv : null, sent: r ? r.sent : null });
  }
  const measured = (n) => sum(out.slice(-n).filter((r) => r.recv != null));
  return {
    days: out,
    today: measured(1),
    week: measured(7),
    month: measured(30),
    since: (db.instance.prepare(`SELECT MIN(day) AS day FROM traffic_day`).get() || {}).day || null,
  };
}

/**
 * The hosts that cost the most over the last `days` days, with what the
 * ranking knows about them: whether they are connected, how, and how often
 * they have delivered a block first. A host can hold more than one address
 * over time (an inbound peer on a new port); the best record among them is
 * shown, because that is the one the host has earned.
 */
function trafficPeers(days = 7, limit = 15, nowMs = Date.now()) {
  const from = dayOf(nowMs - (days - 1) * DAY_MS);
  const rows = db.instance
    .prepare(
      `SELECT host, SUM(recv) AS recv, SUM(sent) AS sent FROM peer_traffic_day
        WHERE day >= ? GROUP BY host ORDER BY SUM(recv) + SUM(sent) DESC LIMIT ?`,
    )
    .all(from, limit);
  const known = new Map();
  for (const p of peerRanking()) {
    const host = hostFromAddress(p.address) || p.address;
    const cur = known.get(host);
    if (!cur || (p.live && !cur.live) || (p.firstPct ?? -1) > (cur.firstPct ?? -1)) known.set(host, p);
  }
  return rows.map((r) => {
    const p = known.get(r.host);
    return {
      host: r.host,
      recv: r.recv,
      sent: r.sent,
      live: p ? p.live : false,
      connectionType: p ? p.connectionType || null : null,
      trusted: p ? Boolean(p.trusted ?? p.trustedSince != null) : false,
      client: p ? p.client : null,
      firstPct: p ? p.firstPct : null,
      first: p ? p.first : null,
    };
  });
}

module.exports = { trafficDays, trafficPeers };
