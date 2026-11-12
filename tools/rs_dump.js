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
//   node tools/rs_dump.js [--days=180] [--dump=2] [--win=4]
//                         [--syms=ETHUSDT,SOLUSDT,...]

const DEFAULT_SYMS = 'ETHUSDT SOLUSDT XRPUSDT DOGEUSDT LINKUSDT NEARUSDT SUIUSDT AAVEUSDT ENAUSDT HYPEUSDT ADAUSDT UNIUSDT APTUSDT LTCUSDT BNBUSDT'.split(' ');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const DAYS = +(arg('days') || 180);
const DUMP = +(arg('dump') || 2);        // % BTC drop to qualify as dump
const WIN = +(arg('win') || 4);          // window length in hours
const SYMS = (arg('syms') || DEFAULT_SYMS.join(',')).split(',');
const H = 3600e3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function page(sym, end) {
  const u = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=60&limit=1000&end=${end}`;
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch(u).then(x => x.json());
      if (r.retCode === 0) return (r.result.list || []).map(k => [+k[0], +k[4]]);
    } catch (e) { /* retry */ }
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
    for (const [t, c] of b) { map.set(t, c); if (t < oldest) oldest = t; }
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

(async () => {
  const btc = await klines('BTCUSDT');
  console.log(`BTCUSDT bars=${btc.length} ` +
    `${new Date(btc[0][0]).toISOString().slice(0, 10)} -> ${new Date(btc[btc.length - 1][0]).toISOString().slice(0, 10)}`);

  // dump windows: BTC <= -DUMP% over WIN consecutive 1h bars, non-overlapping
  const dumps = [];
  let lastEnd = 0;
  for (let i = 0; i + WIN < btc.length; i++) {
    if (btc[i][0] <= lastEnd) continue;
    const ch = (btc[i + WIN][1] / btc[i][1] - 1) * 100;
    if (ch <= -DUMP) { dumps.push({ t0: btc[i][0], t1: btc[i + WIN][0], ch }); lastEnd = btc[i + WIN][0]; }
  }
  console.log(`dumps BTC<=-${DUMP}%/${WIN}h: n=${dumps.length}`);

  const rows = [];
  for (const s of SYMS) {
    const bars = await klines(s);
    await sleep(150);
    if (!bars.length) { console.log(`${s}: no klines`); continue; }
    const rs = [];
    for (const d of dumps) {
      const a = at(bars, d.t0), b = at(bars, d.t1);
      if (a < 0 || b < 0 || a === b) continue;
      const alt = (bars[b][1] / bars[a][1] - 1) * 100;
      rs.push({ ts: d.t0, alt, btc: d.ch, rs: alt - d.ch });
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
  const fs = require('fs'), path = require('path');
  const out = path.join(__dirname, '..', 'data', 'rs_dump_out.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ params: { DAYS, DUMP, WIN }, dumps, rows }, null, 1));
  console.log('detail ->', out);
})();
