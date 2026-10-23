#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// backtest_pump_mpef.js — pump fade phase 2, MPEF filters (issue #5).
// Same trigger + FADE mechanics as backtest_pump_variants.js, but each
// trigger is enriched with:
//   - OI spike:   Bybit perp openInterest(t)/openInterest(t-1h)-1  (data/oi)
//   - spot/perp:  Binance SPOT quote vol / Bybit perp quote vol at bar t
// Filter grid re-runs FADE on subsets; baseline = unfiltered FADE.
//   node tools/backtest_pump_mpef.js

const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'data', 'klines');
const OI_DIR = path.join(ROOT, 'data', 'oi');
const SPOT_DIR = path.join(ROOT, 'data', 'spot');
const FEE = 0.00055, SLIP = 0.001;
const NON = new Set('XAUUSDT XAGUSDT XPTUSDT XPDUSDT PAXGUSDT'.split(' '));

const atr = (b, i, n = 14) => {
  if (i < n + 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++)
    s += Math.max(b[k].h - b[k].l, Math.abs(b[k].h - b[k - 1].c), Math.abs(b[k].l - b[k - 1].c));
  return s / n;
};

const oiAt = (map, ts) => map[ts] !== undefined ? map[ts] : null;
const fades = [], rides = [];
const enrich = [];                                 // per-trigger context

for (const f of fs.readdirSync(CACHE)) {
  const sym = f.split('_')[0];
  if (NON.has(sym)) continue;
  const bars = JSON.parse(fs.readFileSync(path.join(CACHE, f))).bars;
  if (!bars || bars.length < 500) continue;
  const oiF = path.join(OI_DIR, sym + '.json');
  const spF = path.join(SPOT_DIR, sym + '.json');
  const oi = fs.existsSync(oiF) ? JSON.parse(fs.readFileSync(oiF)).oi : null;
  const sp = fs.existsSync(spF) ? JSON.parse(fs.readFileSync(spF)).bars : null;

  for (let i = 30; i < bars.length - 3; i++) {
    const b = bars[i], a = atr(bars, i); if (!a) continue;
    const vs = bars.slice(i - 24, i).reduce((s, x) => s + x.v, 0) / 24;
    if (!(b.v > 5 * vs && (b.h - b.l) > 3 * a && b.c > b.o)) continue;

    // ---- context enrichment ----
    let oiChg = null;
    if (oi) {
      const now = oiAt(oi, b.ts), prev = oiAt(oi, b.ts - 3600e3);
      if (now && prev) oiChg = now / prev - 1;
    }
    let ratio = null;
    if (sp && sp[b.ts]) {
      const perpQv = b.v * b.c;                    // approx quote turnover
      ratio = perpQv > 0 ? sp[b.ts].qv / perpQv : null;
    }
    enrich.push({ sym, ts: b.ts, oiChg, ratio });

    // ---- RIDE: long next open, SL entry-1.5*ATR, trail prev low, 48h ----
    {
      const entry = bars[i + 1].o * (1 + SLIP) * (1 + FEE);
      let sl = entry - 1.5 * a, R = null;
      for (let j = i + 1; j < Math.min(i + 49, bars.length); j++) {
        const x = bars[j];
        if (x.l <= sl) { R = (sl * (1 - SLIP) * (1 - FEE) - entry) / (1.5 * a); break; }
        if (j > i + 1) sl = Math.max(sl, x.l);
        if (j === Math.min(i + 48, bars.length - 1)) R = (x.c * (1 - SLIP) * (1 - FEE) - entry) / (1.5 * a);
      }
      if (R !== null) rides.push({ sym, ts: b.ts, R: +R.toFixed(3), oiChg, ratio });
    }

    // ---- FADE entry (identical mechanics to phase 1) ----
    const c = bars[i + 1];
    const wickUp = c.h - Math.max(c.o, c.c);
    if (!(wickUp >= 0.5 * (c.h - c.l) && c.c < b.c)) continue;
    const entry = bars[i + 2].o * (1 - SLIP) * (1 - FEE);
    let sl = c.h + 0.2 * a, R = null;
    const risk = sl - entry;
    for (let j = i + 2; j < Math.min(i + 74, bars.length); j++) {
      const x = bars[j];
      if (x.h >= sl) { R = (entry - sl * (1 + SLIP) * (1 + FEE)) / risk; break; }
      if (j > i + 2) sl = Math.min(sl, x.h);
      if (j === Math.min(i + 73, bars.length - 1)) R = (entry - x.c * (1 + SLIP) * (1 + FEE)) / risk;
    }
    if (R !== null) fades.push({ sym, ts: b.ts, R: +R.toFixed(3), oiChg, ratio });
  }
}

const rep = (name, arr) => {
  const n = arr.length, w = arr.filter(t => t.R > 0).length;
  const s = arr.reduce((x, t) => x + t.R, 0);
  console.log(`${name.padEnd(46)} n=${String(n).padStart(5)} win=${(100 * w / (n || 1)).toFixed(0).padStart(3)}% sumR=${s.toFixed(1).padStart(8)} avgR=${(s / (n || 1)).toFixed(3)}`);
};

console.log(`triggers enriched: ${enrich.length}  fades taken: ${fades.length}  rides taken: ${rides.length}`);
const cov = { oi: enrich.filter(t => t.oiChg !== null).length, sp: enrich.filter(t => t.ratio !== null).length };
console.log(`coverage: OI ${(100 * cov.oi / enrich.length).toFixed(0)}%  spot ${(100 * cov.sp / enrich.length).toFixed(0)}%`);
const OIvals = enrich.filter(t => t.oiChg !== null).map(t => t.oiChg).sort((a, b) => a - b);
console.log(`OI-1h dist: p50=${(OIvals[OIvals.length >> 1] * 100).toFixed(1)}% p90=${(OIvals[(OIvals.length * 0.9) | 0] * 100).toFixed(1)}% p99=${(OIvals[(OIvals.length * 0.99) | 0] * 100).toFixed(1)}%`);

for (const [label, arr] of [['FADE', fades], ['RIDE', rides]]) {
  rep(`${label} baseline (no filters)`, arr);
  for (const oiMin of [0, 0.05, 0.10, 0.20])
    for (const rMax of [1, 0.5, 0.25]) {
      const sub = arr.filter(t =>
        (t.oiChg === null || t.oiChg >= oiMin) &&
        (t.ratio === null || t.ratio <= rMax));
      rep(`${label}  OI>=${(oiMin * 100).toFixed(0)}% & spot/perp<=${rMax}`, sub);
    }
  // strictest spec: BOTH filters required present (drop missing data)
  const strict = arr.filter(t => t.oiChg !== null && t.ratio !== null && t.oiChg >= 0.20 && t.ratio <= 0.25);
  rep(`${label}  OI>=20% & ratio<=0.25 (data-required)`, strict);
  const inv = arr.filter(t => t.oiChg !== null && t.ratio !== null && !(t.oiChg >= 0.20 && t.ratio <= 0.25));
  rep(`${label}  all other triggers (control)`, inv);
}
