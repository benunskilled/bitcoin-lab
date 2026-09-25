'use strict';

const db = require('../db');
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


module.exports = { trafficDays };
