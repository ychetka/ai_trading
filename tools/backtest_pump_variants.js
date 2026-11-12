#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// backtest_pump_variants.js — pump detector, RIDE vs FADE variants (issue #5).
// Price/volume-only version: OI and spot/perp ratio are not in the
// 1H cache, so this tests the raw anomaly trigger.
//
// Trigger bar: vol > 5*SMA(vol,24) AND range > 3*ATR14 AND close > open.
//   RIDE: long next bar open, SL entry-1.5*ATR, trail by prev-bar low, 48h time stop
//   FADE: wait 1 confirm bar with upper wick >= 50% of its range and
//         close < pump close; short next bar open, SL above confirm
//         high + 0.2*ATR, TP trail by prev-bar high, 72h time stop
//
//   node tools/backtest_pump_variants.js [--minage]

const fs = require('fs'), path = require('path');
const CACHE = path.join(__dirname, '..', 'data', 'klines');
const FEE = 0.00055, SLIP = 0.001;
const NON_CRYPTO = new Set('XAUUSDT XAGUSDT XPTUSDT XPDUSDT PAXGUSDT'.split(' '));

const atr = (bars, i, n = 14) => {
  if (i < n + 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++)
    s += Math.max(bars[k].h - bars[k].l,
      Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  return s / n;
};

const res = { ride: [], fade: [], triggers: 0 };
const BULL = process.argv.includes('--bull');   // RIDE only when BTC > SMA200h

// BTC 1h close series for the altseason-context filter
let btcIdx = null;
if (BULL) {
  const bf = fs.readdirSync(CACHE).find(x => x.startsWith('BTCUSDT_60_'));
  const bb = JSON.parse(fs.readFileSync(path.join(CACHE, bf))).bars;
  btcIdx = new Map(bb.map((b, i) => [b.ts, i]));
  res.btc = bb;
}

for (const f of fs.readdirSync(CACHE)) {
  const sym = f.split('_')[0];
  if (NON_CRYPTO.has(sym)) continue;
  const bars = JSON.parse(fs.readFileSync(path.join(CACHE, f))).bars;
  if (!bars || bars.length < 500) continue;

  for (let i = 30; i < bars.length - 3; i++) {
    const b = bars[i], a = atr(bars, i); if (!a) continue;
    const vsma = bars.slice(i - 24, i).reduce((s, x) => s + x.v, 0) / 24;
    if (!(b.v > 5 * vsma && (b.h - b.l) > 3 * a && b.c > b.o)) continue;
    res.triggers++;
    if (BULL) {
      const bi = btcIdx.get(b.ts);
      if (bi === undefined || bi < 200) continue;
      const sma = res.btc.slice(bi - 200, bi).reduce((s, x) => s + x.c, 0) / 200;
      if (res.btc[bi].c < sma) continue;          // skip ride in BTC downtrend
    }

    // ---- RIDE: long next open, tight trail ----
    {
      const entry = bars[i + 1].o * (1 + SLIP) * (1 + FEE);
      let sl = entry - 1.5 * a, R = null;
      for (let j = i + 1; j < Math.min(i + 49, bars.length); j++) {
        const x = bars[j];
        if (x.l <= sl) { R = (sl * (1 - SLIP) * (1 - FEE) - entry) / (entry - sl) / 1 * -1; R = (sl * (1 - SLIP) * (1 - FEE) - entry) / (1.5 * a); break; }
        if (j > i + 1) sl = Math.max(sl, x.l);       // trail on prev low
        if (j === Math.min(i + 48, bars.length - 1)) R = (x.c * (1 - SLIP) * (1 - FEE) - entry) / (1.5 * a);
      }
      if (R !== null) res.ride.push({ sym, ts: b.ts, R: +R.toFixed(3) });
    }

    // ---- FADE: need exhaustion confirm bar ----
    const c = bars[i + 1];
    const wickUp = c.h - Math.max(c.o, c.c);
    if (!(wickUp >= 0.5 * (c.h - c.l) && c.c < b.c)) continue;
    {
      const entry = bars[i + 2].o * (1 - SLIP) * (1 - FEE);   // short
      let sl = c.h + 0.2 * a, R = null;
      const risk = sl - entry;
      for (let j = i + 2; j < Math.min(i + 74, bars.length); j++) {
        const x = bars[j];
        if (x.h >= sl) { R = (entry - sl * (1 + SLIP) * (1 + FEE)) / risk; break; }
        if (j > i + 2) sl = Math.min(sl, x.h);                 // trail down on prev high
        if (j === Math.min(i + 73, bars.length - 1)) R = (entry - x.c * (1 + SLIP) * (1 + FEE)) / risk;
      }
      if (R !== null) res.fade.push({ sym, ts: b.ts, R: +R.toFixed(3) });
    }
  }
}

const rep = (name, arr) => {
  const n = arr.length, w = arr.filter(t => t.R > 0).length;
  const s = arr.reduce((x, t) => x + t.R, 0);
  const by = {};
  for (const t of arr) { const y = new Date(t.ts).getUTCFullYear(); (by[y] = by[y] || []).push(t.R); }
  console.log(`${name}: n=${n} win=${(100 * w / (n || 1)).toFixed(0)}% sumR=${s.toFixed(1)} avgR=${(s / (n || 1)).toFixed(3)}`);
  for (const [y, rs] of Object.entries(by).sort())
    console.log(`   ${y}: n=${rs.length} avgR=${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3)}`);
};

console.log(`triggers: ${res.triggers}`);
rep('RIDE', res.ride);
rep('FADE', res.fade);
