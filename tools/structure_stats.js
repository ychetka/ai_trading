#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// structure_stats.js — range-boundary touch statistics (issue #6, research).
// For each symbol: rolling range high/low; when a bar touches a boundary
// (within TOL*ATR of the edge), classify the next H bars:
//   BOUNCE - price returned to range mid without closing beyond the edge
//   BREAK  - a close printed beyond the boundary
// Reported for 1H (48-bar range) and 4H (aggregated, 12-bar range = 48h).
//
//   node tools/structure_stats.js

const fs = require('fs'), path = require('path');
const CACHE = path.join(__dirname, '..', 'data', 'klines');
const TOL = 0.5, H = 24;
const NON_CRYPTO = new Set('XAUUSDT XAGUSDT XPTUSDT XPDUSDT PAXGUSDT'.split(' '));

const atr = (bars, i, n = 14) => {
  if (i < n + 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++)
    s += Math.max(bars[k].h - bars[k].l,
      Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  return s / n;
};

// aggregate 1h -> Nh
const agg = (bars, n) => {
  const out = [];
  for (let i = 0; i + n <= bars.length; i += n) {
    const g = bars.slice(i, i + n);
    out.push({ ts: g[0].ts, o: g[0].o, h: Math.max(...g.map(x => x.h)),
      l: Math.min(...g.map(x => x.l)), c: g[g.length - 1].c, v: g.reduce((s, x) => s + x.v, 0) });
  }
  return out;
};

const stats = { '1H_lo': [0, 0], '1H_hi': [0, 0], '4H_lo': [0, 0], '4H_hi': [0, 0] };
const touches = { '1H': 0, '4H': 0 };

function scan(bars, tag, RB) {
  for (let i = RB + 15; i < bars.length - H - 1; i++) {
    const a = atr(bars, i); if (!a) continue;
    const hi = Math.max(...bars.slice(i - RB, i).map(x => x.h));
    const lo = Math.min(...bars.slice(i - RB, i).map(x => x.l));
    const mid = (hi + lo) / 2;
    const b = bars[i];
    for (const [side, edge, dir] of [['lo', lo, 1], ['hi', hi, -1]]) {
      const near = dir === 1 ? (b.l <= edge + TOL * a && b.c > edge - a)
                             : (b.h >= edge - TOL * a && b.c < edge + a);
      if (!near) continue;
      touches[tag]++;
      let broke = false, bounced = false;
      for (let k = i + 1; k <= Math.min(i + H, bars.length - 1); k++) {
        const x = bars[k];
        if (dir === 1 ? x.c < edge : x.c > edge) { broke = true; break; }
        if (dir === 1 ? x.c > mid : x.c < mid) { bounced = true; break; }
      }
      const s = stats[tag + '_' + side];
      if (broke) s[0]++; else if (bounced) s[1]++;
    }
  }
}

for (const f of fs.readdirSync(CACHE)) {
  const sym = f.split('_')[0];
  if (NON_CRYPTO.has(sym)) continue;
  const bars = JSON.parse(fs.readFileSync(path.join(CACHE, f))).bars;
  if (!bars || bars.length < 2000) continue;
  scan(bars, '1H', 48);
  scan(agg(bars, 4), '4H', 12);
}

for (const [k, [br, bo]] of Object.entries(stats)) {
  const tot = br + bo;
  console.log(`${k}: touches=${tot} break=${br} (${(100 * br / (tot || 1)).toFixed(0)}%) bounce=${bo} (${(100 * bo / (tot || 1)).toFixed(0)}%)`);
}
console.log('raw touches:', JSON.stringify(touches));
