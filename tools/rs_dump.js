#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// rs_dump.js — BTC-dump relative-strength probe (issue #8).
// Hypothesis: during sharp BTC sell-offs some alts show persistent relative
// strength (dump return > BTC return). If a stable RS ranking exists it can
// feed a defensive long screener (buy the strongest alts on dumps).
//
// Method: fetch Bybit linear 1h klines (paginated backwards via end=),
// find dump windows where BTC drops >= --dump pct over --win hours,
// dedupe overlapping windows, then per symbol compute RS = alt% - btc%
// inside each window. Report per-symbol and pooled stats.
//
// Extension (issue #8 hypothesis test): for EVERY dump window emit entry
// candidates - symbols that were strong AND held a bid into the dump tail:
//   1. RS >= --rs (default +1.5%) inside the window
//   2. upper-half close: the last window bar closes above the midpoint
//      of its own high/low range
//   3. false-break of the --lb-hour low (default 24): the last bar's low
//      undercuts the lowest low of the previous --lb bars and closes
//      back above it
// Top --top (default 3) candidates per dump are printed and pooled.
//
//   node tools/rs_dump.js [--days=180] [--dump=2] [--win=4]
//                         [--rs=1.5] [--lb=24] [--top=3]
//                         [--syms=ETHUSDT,SOLUSDT,...]

const DEFAULT_SYMS = 'ETHUSDT SOLUSDT XRPUSDT DOGEUSDT LINKUSDT NEARUSDT SUIUSDT AAVEUSDT ENAUSDT HYPEUSDT ADAUSDT UNIUSDT APTUSDT LTCUSDT BNBUSDT'.split(' ');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const DAYS = +(arg('days') || 180);
const DUMP = +(arg('dump') || 2);        // % BTC drop to qualify as dump
const WIN = +(arg('win') || 4);          // window length in hours
const RS_MIN = +(arg('rs') || 1.5);      // candidate min RS, %
const LBK = +(arg('lb') || 24);          // false-break lookback, bars
const TOPN = +(arg('top') || 3);         // candidates emitted per dump
const SYMS = (arg('syms') || DEFAULT_SYMS.join(',')).split(',');
const H = 3600e3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function page(sym, end) {
  const u = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=60&limit=1000&end=${end}`;
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch(u).then(x => x.json());
      // bars kept as [ts, close, high, low] - candidates need the range
      if (r.retCode === 0) return (r.result.list || []).map(k => [+k[0], +k[4], +k[2], +k[3]]);
    } catch { /* retry */ }
    await sleep(800 * (t + 1));
  }
  return [];
}

// fetch up to DAYS of history paging backwards; Bybit returns newest-first
async function klines(sym) {
  const map = new Map();
  let end = Date.now();
  const floor = end - DAYS * 24 * H;
  for (let p = 0; p < 30; p++) {
    const b = await page(sym, end);
    if (!b.length) break;
    let oldest = Infinity;
    for (const k of b) { map.set(k[0], k); if (k[0] < oldest) oldest = k[0]; }
    if (oldest <= floor || oldest >= end) break;
    end = oldest - 1;
    await sleep(200);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

const at = (bars, ts) => {          // last bar closed at/before ts
  let lo = 0, hi = bars.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m][0] <= ts) { best = m; lo = m + 1; } else hi = m - 1; }
  return best;
};

// dump windows: BTC <= -dump% over `win` consecutive 1h bars,
// non-overlapping (a window's tail dedupes all later starts inside it)
function detectDumps(btc, dump = DUMP, win = WIN) {
  const dumps = [];
  let lastEnd = 0;
  for (let i = 0; i + win < btc.length; i++) {
    if (btc[i][0] <= lastEnd) continue;
    const ch = (btc[i + win][1] / btc[i][1] - 1) * 100;
    if (ch <= -dump) { dumps.push({ t0: btc[i][0], t1: btc[i + win][0], ch }); lastEnd = btc[i + win][0]; }
  }
  return dumps;
}

// RS of one symbol inside one dump window {t0,t1,ch}; null when the
// window resolves to fewer than two distinct closed bars in `bars`.
function rsFor(bars, d) {
  const a = at(bars, d.t0), b = at(bars, d.t1);
  if (a < 0 || b < 0 || a === b) return null;
  const alt = (bars[b][1] / bars[a][1] - 1) * 100;
  return { ts: d.t0, alt, btc: d.ch, rs: alt - d.ch };
}

// Entry-candidate filters evaluated on the last bar of the dump window
// (bar index found via t1):
//   1. rs >= rsMin        - real relative strength vs BTC in the window
//   2. upper-half close   - close above the midpoint of the bar's own
//      high/low range
//   3. false-break of the `lb`-bar low: the bar's low undercuts the
//      lowest low of the previous `lb` bars and closes back above it
function passesFilters(bars, t1, rs, rsMin = RS_MIN, lb = LBK) {
  if (!(rs >= rsMin)) return false;
  const b = at(bars, t1);
  if (b < lb) return false;                      // need `lb` prior bars
  const last = bars[b];
  if (!(last[1] > (last[2] + last[3]) / 2)) return false;
  let prevLow = Infinity;
  for (let i = b - lb; i < b; i++) if (bars[i][3] < prevLow) prevLow = bars[i][3];
  return last[3] < prevLow && last[1] > prevLow;
}

// top-n candidates of one dump by RS (desc); input is not mutated
const topCandidates = (list, n = TOPN) => [...list].sort((a, b) => b.rs - a.rs).slice(0, n);

async function main() {
  const btc = await klines('BTCUSDT');
  console.log(`BTCUSDT bars=${btc.length} ` +
    `${new Date(btc[0][0]).toISOString().slice(0, 10)} -> ${new Date(btc[btc.length - 1][0]).toISOString().slice(0, 10)}`);

  const dumps = detectDumps(btc, DUMP, WIN);
  console.log(`dumps BTC<=-${DUMP}%/${WIN}h: n=${dumps.length}`);
  const candByDump = new Map(dumps.map(d => [d.t0, []]));

  const rows = [];
  for (const s of SYMS) {
    const bars = await klines(s);
    await sleep(150);
    if (!bars.length) { console.log(`${s}: no klines`); continue; }
    const rs = [];
    for (const d of dumps) {
      const rec = rsFor(bars, d);
      if (!rec) continue;
      rs.push(rec);
      if (passesFilters(bars, d.t1, rec.rs, RS_MIN, LBK)) {
        candByDump.get(d.t0).push({ sym: s, rs: rec.rs, alt: rec.alt });
      }
    }
    if (!rs.length) { console.log(`${s}: 0 matched windows`); continue; }
    const vals = rs.map(r => r.rs);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const med = [...vals].sort((a, b) => a - b)[vals.length >> 1];
    const win = 100 * vals.filter(v => v > 0).length / vals.length;
    console.log(`${s.padEnd(10)} n=${String(vals.length).padStart(3)} avgRS=${mean.toFixed(2).padStart(6)}% med=${med.toFixed(2).padStart(6)}% win=${win.toFixed(0)}%`);
    rows.push({ sym: s, n: vals.length, avgRS: +mean.toFixed(3), medRS: +med.toFixed(3), win: +win.toFixed(1), detail: rs });
  }
  const all = rows.flatMap(r => r.detail.map(d => d.rs));
  if (all.length) {
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    const med = [...all].sort((a, b) => a - b)[all.length >> 1];
    const win = 100 * all.filter(v => v > 0).length / all.length;
    console.log(`\nPOOLED n=${all.length} avg=${mean.toFixed(2)}% med=${med.toFixed(2)}% win=${win.toFixed(0)}%`);
  }

  // candidates per dump: top TOPN by RS
  const candDumps = [];
  for (const d of dumps) {
    const cands = topCandidates(candByDump.get(d.t0), TOPN)
      .map(c => ({ sym: c.sym, rs: +c.rs.toFixed(3), alt: +c.alt.toFixed(3) }));
    candDumps.push({ t0: d.t0, t1: d.t1, btc: +d.ch.toFixed(3), candidates: cands });
    const when = new Date(d.t0).toISOString().slice(0, 16).replace('T', ' ');
    const list = cands.map(c => `${c.sym} rs=${c.rs.toFixed(2)}%`).join(' ') || '-';
    console.log(`dump ${when} btc=${d.ch.toFixed(2)}% cands: ${list}`);
  }
  const flat = candDumps.flatMap(x => x.candidates);
  let candPool = null;
  if (flat.length) {
    const rsVals = flat.map(c => c.rs);
    const mean = rsVals.reduce((a, b) => a + b, 0) / rsVals.length;
    const med = [...rsVals].sort((a, b) => a - b)[rsVals.length >> 1];
    const covered = candDumps.filter(x => x.candidates.length).length;
    candPool = { n: flat.length, avgRS: +mean.toFixed(3), medRS: +med.toFixed(3), dumpsWithCands: covered, dumps: dumps.length };
    console.log(`\nCANDIDATES n=${flat.length} avgRS=${mean.toFixed(2)}% med=${med.toFixed(2)}% on ${covered}/${dumps.length} dumps`);
  } else {
    console.log('\nCANDIDATES: none passed filters');
  }

  const fs = require('fs'), path = require('path');
  const out = path.join(__dirname, '..', 'data', 'rs_dump_out.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ params: { DAYS, DUMP, WIN, RS_MIN, LBK, TOPN }, dumps, rows, candidates: candDumps, candPool }, null, 1));
  console.log('detail ->', out);
}

if (require.main === module) main();
module.exports = { detectDumps, rsFor, passesFilters, topCandidates, at };
