#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// sqz_rank.js — deterministic ranker of the squeeze nature of Bybit tickers.
// Filter #5 that a chatbot can't do: Equal Lows + wick sweeps
// on real 1H candles.
//
// Usage:
//   node sqz_rank.js BTCUSDT SOLUSDT ONDOUSDT ...
//   node sqz_rank.js            (no args: top-30 by turnover24h)
//
// Per-ticker metrics (~200 1H bars ≈ 8.3 days):
//   eql    — Equal Lows events: >=2 swing lows within tolerance%
//   sqz    — wick sweeps: low pierced the minimum of the previous
//            LOOKBACK bars but closed back above (classic stop hunt)
//   atr%   — ATR(14) as % of price (0.5–2% window check)
//   turn   — turnover24h, $M
//   score  — sqz*2 + eql (sweep weighs double — it IS the hunt pattern)

const TOL_PCT   = 0.3;    // Equal Lows tolerance, %
const SWING_K   = 3;      // swing low: low below K neighbours on each side
const LOOKBACK  = 20;     // stop-pool depth for a sweep
const BARS      = 200;
const CONC      = 5;

const api = async (path) => {
  const r = await fetch('https://api.bybit.com' + path,
    { headers: { 'User-Agent': 'curl/8.0' } });
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(path + ' -> ' + j.retMsg);
  return j.result;
};

const klines = async (sym) => {
  const res = await api(`/v5/market/kline?category=linear&symbol=${sym}&interval=60&limit=${BARS}`);
  return res.list
    .map(r => ({ ts: +r[0], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
    .sort((a, b) => a.ts - b.ts);
};

const analyze = (bars) => {
  const n = bars.length;
  // swing lows
  const swings = [];
  for (let i = SWING_K; i < n - SWING_K; i++) {
    let is = true;
    for (let k = 1; k <= SWING_K && is; k++)
      if (bars[i - k].l <= bars[i].l || bars[i + k].l <= bars[i].l) is = false;
    if (is) swings.push({ i, l: bars[i].l });
  }
  // Equal Lows: swing pairs within tolerance, non-adjacent
  let eql = 0;
  for (let a = 0; a < swings.length; a++)
    for (let b = a + 1; b < swings.length; b++) {
      if (swings[b].i - swings[a].i <= SWING_K) continue;
      const avg = (swings[a].l + swings[b].l) / 2;
      if (Math.abs(swings[a].l - swings[b].l) / avg * 100 <= TOL_PCT) eql++;
    }
  // wick sweeps: pierce of the LOOKBACK-bar minimum + close back above
  let sqz = 0;
  for (let i = LOOKBACK; i < n; i++) {
    let pool = Infinity;
    for (let k = i - LOOKBACK; k < i; k++) pool = Math.min(pool, bars[k].l);
    if (bars[i].l < pool && bars[i].c > pool) sqz++;
  }
  // ATR(14) as % of last close
  let tr = 0, cnt = 0;
  for (let i = n - 14; i < n; i++) {
    tr += Math.max(bars[i].h - bars[i].l,
                   Math.abs(bars[i].h - bars[i - 1].c),
                   Math.abs(bars[i].l - bars[i - 1].c));
    cnt++;
  }
  const atrPct = tr / cnt / bars[n - 1].c * 100;
  return { eql, sqz, atrPct, swings: swings.length };
};

const main = async () => {
  let syms = process.argv.slice(2).map(s => s.toUpperCase().replace(/\.P$/, ''));
  const tick = (await api('/v5/market/tickers?category=linear')).list;
  const turn = {};
  for (const t of tick) {
    if (!/^[A-Z0-9]+USDT$/.test(t.symbol)) continue;
    turn[t.symbol] = +t.turnover24h;
  }
  if (!syms.length)
    syms = Object.keys(turn).sort((a, b) => turn[b] - turn[a]).slice(0, 30);

  const rows = [];
  for (let i = 0; i < syms.length; i += CONC) {
    await Promise.all(syms.slice(i, i + CONC).map(async (s) => {
      try {
        const bars = await klines(s);
        if (bars.length < 60) return rows.push({ s, err: 'little history' });
        const a = analyze(bars);
        rows.push({ s, ...a, turn: (turn[s] || 0) / 1e6,
                    score: a.sqz * 2 + a.eql });
      } catch (e) { rows.push({ s, err: e.message }); }
    }));
  }

  rows.sort((a, b) => (b.score || 0) - (a.score || 0));
  console.log('symbol        turn$M    sqz   eql  swings   atr%   score');
  for (const r of rows) {
    if (r.err) { console.log(r.s.padEnd(12) + ' ERR ' + r.err); continue; }
    console.log(
      r.s.padEnd(12) +
      String(r.turn.toFixed(0)).padStart(7) +
      String(r.sqz).padStart(6) +
      String(r.eql).padStart(6) +
      String(r.swings).padStart(7) +
      r.atrPct.toFixed(2).padStart(7) +
      String(r.score).padStart(7));
  }
};

main().catch(e => { console.error(e.message); process.exit(1); });
