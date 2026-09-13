'use strict';

/**
 * Does the peer score actually predict anything?
 *
 * Walk-forward backtest against a recorded history: replay every block in
 * order and, at each one, ask each scoring rule to rank the peers that were
 * connected at that moment using only what was known before it. Then look up
 * where the peer that really delivered the block came out.
 *
 * Read-only. Point it at a copy rather than a live database if you like, but
 * it opens read-only either way and writes nothing.
 *
 *   SQLITE_PATH=/path/to/bitcoinlab.db node scripts/backtest-score.js
 *
 * On Umbrel, against the running install:
 *
 *   sudo docker exec -i bitcoinlab-node_dashboard_1 \
 *     node /app/scripts/backtest-score.js
 *
 * It needs a few thousand blocks to say anything; below about a thousand the
 * differences are smaller than the noise. The result as of 2,206 blocks on the
 * node this was built on is written up in src/lib/score.js, next to the rule
 * it is about.
 */

const path = require('path');
const Database = require('better-sqlite3');
const { wilsonLowerBound } = require('../src/lib/score');
const config = require('../src/lib/config');

const DB_PATH = process.env.SQLITE_PATH || config.sqlitePath;
const WINDOW = config.recentScoreWindowBlocks;
// No evaluation until the window has had a chance to fill, so the early blocks
// - where every rule is guessing from nothing - cannot flatter any of them.
const WARMUP = Math.round(WINDOW * 1.2);

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`Cannot read ${DB_PATH}: ${err.message}`);
  console.error('Set SQLITE_PATH to a Bitcoin Lab database with some history in it.');
  process.exit(1);
}

// --- the variants under test -------------------------------------------
//
// Each gets the same four counters and returns a number; higher ranks higher.
// `current` is the shipped rule, copied rather than imported so the others can
// sit beside it and be read as a set.
const VARIANTS = {
  current: ({ f, e, rf, re }) => {
    const filled = Math.min(1, re / WINDOW);
    return filled * wilsonLowerBound(rf, re) + (1 - filled) * wilsonLowerBound(f, e);
  },
  'recent-from-50': ({ f, e, rf, re }) => {
    if (re >= 50) return wilsonLowerBound(rf, re);
    const filled = Math.min(1, re / WINDOW);
    return filled * wilsonLowerBound(rf, re) + (1 - filled) * wilsonLowerBound(f, e);
  },
  'recent-from-100': ({ f, e, rf, re }) => {
    if (re >= 100) return wilsonLowerBound(rf, re);
    const filled = Math.min(1, re / WINDOW);
    return filled * wilsonLowerBound(rf, re) + (1 - filled) * wilsonLowerBound(f, e);
  },
  'recent-from-200': ({ f, e, rf, re }) => {
    if (re >= 200) return wilsonLowerBound(rf, re);
    const filled = Math.min(1, re / WINDOW);
    return filled * wilsonLowerBound(rf, re) + (1 - filled) * wilsonLowerBound(f, e);
  },
  // Baselines, to say whether any of the above is better than something dumb.
  'lifetime-only': ({ f, e }) => wilsonLowerBound(f, e),
  'recent-raw': ({ rf, re }) => (re > 0 ? rf / re : 0),
  'lifetime-raw': ({ f, e }) => (e > 0 ? f / e : 0),
};

// --- replay -------------------------------------------------------------

const races = db.prepare(`SELECT id FROM relay_race ORDER BY id`).all().map((r) => r.id);
const obsFor = db.prepare(`SELECT peer_id AS p, first AS f FROM relay_observation WHERE race_id = ?`);

// peer -> cumulative lifetime counters, and the sliding 500-race window
const life = new Map();     // p -> { f, e }
const win = new Map();      // p -> { f, e }
const ring = [];            // the last WINDOW races' observation arrays

const stats = {};
for (const name of Object.keys(VARIANTS)) {
  stats[name] = { top1: 0, top3: 0, top8: 0, rankSum: 0, reciprocal: 0, evaluated: 0 };
}
const perBlockRank = {};
let skippedNoFirst = 0;
let skippedNoScore = 0;

function bump(map, p, f, sign) {
  let c = map.get(p);
  if (!c) { c = { f: 0, e: 0 }; map.set(p, c); }
  c.f += sign * f;
  c.e += sign;
  if (c.e === 0 && c.f === 0) map.delete(p);
}

for (let i = 0; i < races.length; i += 1) {
  const rows = obsFor.all(races[i]);

  // Evaluate BEFORE folding this race in, so the counters know only the past.
  if (i >= WARMUP) {
    const actual = rows.filter((r) => r.f === 1).map((r) => r.p);
    if (actual.length !== 1) {
      skippedNoFirst += 1;
    } else {
      const winner = actual[0];
      const candidates = [];
      for (const row of rows) {
        const l = life.get(row.p);
        if (!l || l.e <= 0) continue;   // peerScore returns null here
        const w = win.get(row.p) || { f: 0, e: 0 };
        candidates.push({ p: row.p, f: l.f, e: l.e, rf: w.f, re: w.e });
      }
      if (candidates.length < 2 || !candidates.some((c) => c.p === winner)) {
        skippedNoScore += 1;
      } else {
        for (const [name, fn] of Object.entries(VARIANTS)) {
          const scored = candidates
            .map((c) => ({ p: c.p, s: fn(c) }))
            .sort((a, b) => b.s - a.s || a.p - b.p);
          const rank = scored.findIndex((x) => x.p === winner) + 1;
          (perBlockRank[name] ||= []).push(rank);
          const st = stats[name];
          st.evaluated += 1;
          st.rankSum += rank;
          st.reciprocal += 1 / rank;
          if (rank <= 1) st.top1 += 1;
          if (rank <= 3) st.top3 += 1;
          if (rank <= 8) st.top8 += 1;
        }
      }
    }
  }

  // Fold it in: lifetime grows, the window slides.
  for (const row of rows) {
    bump(life, row.p, row.f, +1);
    bump(win, row.p, row.f, +1);
  }
  ring.push(rows);
  if (ring.length > WINDOW) {
    for (const row of ring.shift()) bump(win, row.p, row.f, -1);
  }
}

// --- report -------------------------------------------------------------

const any = Object.values(stats)[0];
console.log('');
console.log('Backtest over ' + races.length + ' recorded blocks from ' + path.basename(DB_PATH));
console.log('  evaluated:        ' + any.evaluated + ' blocks (from block ' + WARMUP + ' on)');
console.log('  skipped:      ' + skippedNoFirst + ' without exactly one first, '
  + skippedNoScore + ' with nothing to rank');
if (any.evaluated === 0) {
  // A table of NaN would look like a result. This is not enough history to say
  // anything, and saying so is the answer.
  console.log('');
  console.log('Not enough history to compare anything. The first ' + WARMUP + ' blocks are');
  console.log('warm-up, so this needs more than that before any rule can be judged -');
  console.log('a few thousand before the differences beat the noise.');
  db.close();
  process.exit(0);
}
console.log('');
console.log('  rule                top-1     top-3     top-8   mean rank    MRR');
const rows = Object.entries(stats).map(([name, s]) => ({
  name,
  top1: (100 * s.top1) / s.evaluated,
  top3: (100 * s.top3) / s.evaluated,
  top8: (100 * s.top8) / s.evaluated,
  rank: s.rankSum / s.evaluated,
  mrr: s.reciprocal / s.evaluated,
}));
for (const r of rows) {
  console.log('  ' + r.name.padEnd(18)
    + (r.top1.toFixed(1) + ' %').padStart(8)
    + (r.top3.toFixed(1) + ' %').padStart(10)
    + (r.top8.toFixed(1) + ' %').padStart(10)
    + r.rank.toFixed(2).padStart(12)
    + r.mrr.toFixed(4).padStart(8));
}

// Is any difference bigger than chance? A paired sign test: on the blocks
// where two rules disagree about the winner's rank, how often is each ahead?
// Paired, because the two are judged on the very same blocks - which removes
// the block-to-block variance that dwarfs the difference being measured.
function logFactorial(n) {
  let s = 0;
  for (let i = 2; i <= n; i += 1) s += Math.log(i);
  return s;
}

// Two-sided exact binomial against p = 0.5.
function signTestP(better, worse) {
  const n = better + worse;
  if (n === 0) return 1;
  const k = Math.min(better, worse);
  const lnC = (a, b) => logFactorial(a) - logFactorial(b) - logFactorial(a - b);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += Math.exp(lnC(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

console.log('');
console.log('Paired against "current", counting only blocks where the two disagree:');
console.log('  rule                better       worse       n   p (sign test)');
const base = perBlockRank.current;
for (const name of Object.keys(VARIANTS)) {
  if (name === 'current') continue;
  const other = perBlockRank[name];
  let better = 0;
  let worse = 0;
  for (let i = 0; i < base.length; i += 1) {
    if (other[i] < base[i]) better += 1;
    else if (other[i] > base[i]) worse += 1;
  }
  const p = signTestP(better, worse);
  console.log('  ' + name.padEnd(18)
    + String(better).padStart(7)
    + String(worse).padStart(12)
    + String(better + worse).padStart(8)
    + ('   ' + (p < 0.0001 ? '<0.0001' : p.toFixed(4))).padStart(21)
    + (p < 0.05 ? '  *' : ''));
}
console.log('');
console.log('  "better" means this rule gave the peer that really delivered a lower');
console.log('  (= better) rank than the shipped rule. * = p < 0.05.');

db.close();
