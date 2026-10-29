#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// backtest_reentry.js — "structured loss-skipping" mechanism test (issue #3).
//
// The user's refined idea: after a breakout entry, if the local
// liquidity cluster breaks and price heads to the next cluster below,
// exit near breakeven/small loss and re-enter via limit order at the
// lower structure (book wall / swing low), stop below that structure.
// Skip part of the drop instead of eating the full -1R.
//
// Variant A (baseline): Donchian entry, SL = entry - 2.5*ATR, trail by
//   min(low,84), expiry 960 bars — the live rule set.
// Variant B (re-entry): same entries; when drawdown hits -0.3R exit.
//   Re-entry limit = next lower structure: min(low,48) at the exit bar.
//   Fill if touched within 120 bars; new SL = structure - 0.2*ATR,
//   same trailing. If no fill -> trade closed at -0.3R.
//
//   node tools/backtest_reentry.js

const fs = require('fs'), path = require('path');
const CACHE = path.join(__dirname, '..', 'data', 'klines');
const FEE = 0.00055, SLIP = 0.001;
const N = 168, VOLK = 1.5, ATRK = 2.5, EXPIRY = 960;
const NON_CRYPTO = new Set('XAUUSDT XAGUSDT XPTUSDT XPDUSDT PAXGUSDT'.split(' '));

const atr = (bars, i, n = 14) => {
  if (i < n + 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++)
    s += Math.max(bars[k].h - bars[k].l,
      Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  return s / n;
};

// simulate one long position from bar j with given entry/sl; trail by
// min(low,84); returns R vs (entry-sl0)
function simLong(bars, j, entry, sl0) {
  let sl = sl0;
  for (let k = j; k < Math.min(j + EXPIRY, bars.length); k++) {
    const b = bars[k];
    if (b.l <= sl) return { R: (sl * (1 - SLIP) * (1 - FEE) - entry) / (entry - sl0), exit: 'SL', bars: k - j };
    const lo84 = Math.min(...bars.slice(Math.max(0, k - 84), k).map(x => x.l));
    sl = Math.max(sl, lo84);
    if (k === Math.min(j + EXPIRY - 1, bars.length - 1))
      return { R: (b.c * (1 - SLIP) * (1 - FEE) - entry) / (entry - sl0), exit: 'TIME', bars: k - j };
  }
  return { R: 0, exit: 'EOD', bars: 0 };
}

const A = [], B = [];

for (const f of fs.readdirSync(CACHE)) {
  const sym = f.split('_')[0];
  if (NON_CRYPTO.has(sym)) continue;
  const bars = JSON.parse(fs.readFileSync(path.join(CACHE, f))).bars;
  if (!bars || bars.length < 1500) continue;

  // rolling bwP proxy skipped: keep vol+Donchian signal only (faster, same spirit)
  for (let i = N + 10; i < bars.length - 2; i++) {
    const b = bars[i];
    if (b.c <= Math.max(...bars.slice(i - N, i).map(x => x.h))) continue;
    const vsma = bars.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
    if (b.v <= VOLK * vsma) continue;
    const a = atr(bars, i); if (!a) continue;

    const entry = bars[i + 1].o * (1 + SLIP) * (1 + FEE);
    const sl0 = entry - ATRK * a;
    const R0 = simLong(bars, i + 1, entry, sl0);
    A.push({ sym, R: R0.R });

    // --- Variant B: cut at -0.3R, re-enter at next lower structure ---
    const cutP = entry - 0.3 * (entry - sl0);
    let cutI = null;
    for (let k = i + 1; k < Math.min(i + 1 + EXPIRY, bars.length); k++) {
      if (bars[k].l <= cutP) { cutI = k; break; }
      // if it never dropped to -0.3R, trade equals baseline
      if (bars[k].l <= sl0) break;
    }
    if (cutI === null) { B.push({ sym, R: R0.R }); continue; }

    let tot = -0.3;                                     // realized cut
    const struct = Math.min(...bars.slice(Math.max(0, cutI - 48), cutI).map(x => x.l));
    const reP = struct * (1 + SLIP) * (1 + FEE);         // limit at structure
    let filled = null;
    for (let k = cutI; k < Math.min(cutI + 120, bars.length); k++) {
      if (bars[k].l <= reP) { filled = k; break; }
      if (bars[k].h >= entry) break;                     // ran away without us
    }
    if (filled !== null) {
      const a2 = atr(bars, filled);
      const r2 = simLong(bars, filled, reP, struct - 0.2 * (a2 || a));
      tot += Math.max(-1, r2.R);                         // re-entry risk unit
    }
    B.push({ sym, R: +tot.toFixed(3) });
    i = cutI;                                            // skip overlapping signals
  }
}

const rep = (name, arr) => {
  const n = arr.length, w = arr.filter(t => t.R > 0).length;
  const s = arr.reduce((x, t) => x + t.R, 0);
  const m = arr.map(t => t.R).sort((x, y) => x - y);
  console.log(`${name}: n=${n} win=${(100 * w / n).toFixed(0)}% sumR=${s.toFixed(1)} avgR=${(s / n).toFixed(3)} p5=${m[Math.floor(n * .05)]} median=${m[Math.floor(n * .5)]}`);
};
rep('A hard-stop  ', A);
rep('B re-entry   ', B);
