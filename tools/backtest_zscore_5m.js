#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// backtest_zscore_5m.js — isolated 5m mean-reversion z-score test (issue #9).
// Never overlaid on Donchian; standalone strategy evaluation.
//
// Signal (long only, per partner spec):
//   Z = (close5m - mean(N=12, =1h)) / sigma  <= -2.576
//   exhaustion:   vol5m > 2.0 * SMA(vol5m, 24)
//   trend gate:   aggregated 1h close > EMA200(1h)
// Entry: next 5m bar open (+slip+fee)
// Exit:  Z >= 0 (price back to mean) -> sell; hard SL 1.5*ATR5m(14);
//        time stop TIMESTOP bars.
//
//   node tools/backtest_zscore_5m.js [--months=6] [--syms=BTC,ETH,...]

const fs = require('fs'), path = require('path');
const CACHE = path.join(__dirname, '..', 'data', 'klines5m');
fs.mkdirSync(CACHE, { recursive: true });
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const MONTHS = +(arg('months') || 6);
const SYMS = (arg('syms') || 'BTC,ETH,SOL,XRP,DOGE,ADA,AVAX,LINK').split(',').map(s => s + 'USDT');
const FEE = 0.00055, SLIP = 0.001;
const ZIN = -2.576, VOLK = 2.0, TIMESTOP = 288;   // 24h of 5m bars
const FROM = Date.now() - MONTHS * 30 * 86400e3;

const api = async p => {
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch('https://api.bybit.com' + p, { headers: { 'User-Agent': 'bt-zscore/1' } });
      const j = await r.json();
      if (j.retCode === 0) return j.result;
    } catch (e) { }
    await new Promise(r => setTimeout(r, 1200 * (t + 1)));
  }
  throw new Error('api fail ' + p);
};

async function fetch5m(sym) {
  const file = path.join(CACHE, `${sym}_5_${MONTHS}m.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file)).bars;
  let end = Date.now(), bars = [];
  for (;;) {
    const res = await api(`/v5/market/kline?category=linear&symbol=${sym}&interval=5&start=${FROM}&end=${end}&limit=1000`);
    const list = (res.list || []).map(r => ({ ts: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
    if (!list.length) break;
    bars = bars.concat(list);
    const earliest = Math.min(...list.map(x => x.ts));
    if (earliest <= FROM || list.length < 1000) break;
    end = earliest - 1;
    await new Promise(r => setTimeout(r, 150));
  }
  bars.sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(file, JSON.stringify({ bars }));
  return bars;
}

const stats = { n: 0, wins: 0, sumR: 0, bySym: {}, byReason: {} };

function run(sym, bars) {
  // precompute aggregated 1h closes for the EMA200 trend gate
  const ema = [];   // ema200 on 5m closes resampled: use EMA over 2400 5m bars (=200h)
  const K = 2 / (2400 + 1);
  let e = bars[0].c;
  for (let i = 0; i < bars.length; i++) { e = bars[i].c * K + e * (1 - K); ema[i] = e; }

  let pos = null;
  const rec = (exitP, reason, i) => {
    const R = (exitP - pos.entry) / (pos.entry - pos.sl);
    stats.n++; if (R > 0) stats.wins++; stats.sumR += R;
    (stats.bySym[sym] = stats.bySym[sym] || []).push(R);
    stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
    pos = null;
  };

  for (let i = 26; i < bars.length - 1; i++) {
    if (pos) {
      const b = bars[i];
      // mean at entry-time basis: trailing 12-bar mean recomputed each bar
      const m = bars.slice(i - 12, i).reduce((s, x) => s + x.c, 0) / 12;
      const sd = Math.sqrt(bars.slice(i - 12, i).reduce((s, x) => s + (x.c - m) ** 2, 0) / 12) || 1e-9;
      const z = (b.c - m) / sd;
      if (b.l <= pos.sl) { rec(pos.sl * (1 - SLIP) * (1 - FEE), 'SL', i); continue; }
      if (z >= 0) { rec(b.c * (1 - SLIP) * (1 - FEE), 'Z0', i); continue; }
      if (i - pos.i0 >= TIMESTOP) { rec(b.c * (1 - SLIP) * (1 - FEE), 'TIME', i); }
      continue;
    }
    // entry signal on closed bar i
    const m = bars.slice(i - 12, i).reduce((s, x) => s + x.c, 0) / 12;
    const sd = Math.sqrt(bars.slice(i - 12, i).reduce((s, x) => s + (x.c - m) ** 2, 0) / 12) || 1e-9;
    const z = (bars[i].c - m) / sd;
    if (z > ZIN) continue;
    const vsma = bars.slice(i - 24, i).reduce((s, x) => s + x.v, 0) / 24;
    if (bars[i].v <= VOLK * vsma) continue;                    // exhaustion volume
    if (bars[i].c <= ema[i]) continue;                          // 1h-trend gate (EMA200h on 5m)
    // ATR14 on 5m
    let s = 0;
    for (let k = i - 13; k <= i; k++)
      s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
    const a = s / 14;
    const entry = bars[i + 1].o * (1 + SLIP) * (1 + FEE);
    const sl = bars[i].l - 0.2 * a;                             // below signal low - buffer
    const risk = entry - sl;
    if (risk <= 0 || risk > 1.5 * a * 3) continue;
    pos = { entry, sl, i0: i + 1 };
  }
}

(async () => {
  for (const s of SYMS) {
    process.stderr.write(`fetch ${s}... `);
    const bars = await fetch5m(s);
    process.stderr.write(`${bars.length} bars\n`);
    run(s, bars);
  }
  console.log(`trades ${stats.n} | wins ${stats.wins} (${(100 * stats.wins / (stats.n || 1)).toFixed(0)}%) | sumR ${stats.sumR.toFixed(2)} | avgR ${(stats.sumR / (stats.n || 1)).toFixed(3)}`);
  for (const [s, rs] of Object.entries(stats.bySym))
    console.log(`  ${s}: n=${rs.length} avgR=${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3)} sumR=${rs.reduce((a, b) => a + b, 0).toFixed(2)}`);
  console.log('  exits:', JSON.stringify(stats.byReason));
})();
