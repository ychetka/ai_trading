// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// tmp_magnet_cond.js — conditional magnetism: P(touching a layer within 48h)
// given price is ALREADY moving toward it (ret24 directed at it).
// Dense zone vs a single level at the same distance.
const fs = require('fs'), path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'klines');
const K = 3, TOL = 0.004, LOOK = 168, H = 48, STEP = 6, MOM = 24;

const files = fs.readdirSync(DIR);
const syms = [...new Set(files.map(f => f.split('_')[0]))];
const recs = [];

for (const sym of syms) {
  const map = new Map();
  for (const f of files.filter(x => x.startsWith(sym + '_')))
    for (const b of JSON.parse(fs.readFileSync(path.join(DIR, f))).bars) map.set(b.ts, b);
  const B = [...map.values()].sort((a, b) => a.ts - b.ts);
  if (B.length < LOOK + H + MOM + 100) continue;

  for (let t = LOOK + K + MOM; t < B.length - H - K; t += STEP) {
    const px = B[t].c;
    const mom = (px - B[t - MOM].c) / B[t - MOM].c;   // 24h momentum
    const lows = [], highs = [];
    for (let i = t - LOOK + K; i < t - K + 1; i++) {
      let isL = true, isH = true;
      for (let j = i - K; j <= i + K; j++) {
        if (j === i) continue;
        if (B[j].l < B[i].l) isL = false;
        if (B[j].h > B[i].h) isH = false;
      }
      if (isL) lows.push(B[i].l);
      if (isH) highs.push(B[i].h);
    }
    const clust = (arr) => {
      arr.sort((a, b) => a - b);
      const out = [];
      for (const v of arr) {
        const l = out[out.length - 1];
        if (l && v - l.max < l.max * TOL) { l.n++; l.max = v; }
        else out.push({ min: v, max: v, n: 1 });
      }
      return out;
    };
    const lo = clust(lows).filter(c => c.max < px && c.max > px * 0.9);
    const hi = clust(highs).filter(c => c.min > px && c.min < px * 1.1);
    for (const c of lo) {
      let touch = false;
      for (let j = t + 1; j <= t + H; j++) if (B[j].l <= c.max) { touch = true; break; }
      recs.push({ side: 'dn', dist: (px - c.max) / px, n: c.n, touch, toward: mom < 0 });
    }
    for (const c of hi) {
      let touch = false;
      for (let j = t + 1; j <= t + H; j++) if (B[j].h >= c.min) { touch = true; break; }
      recs.push({ side: 'up', dist: (c.min - px) / px, n: c.n, touch, toward: mom > 0 });
    }
  }
}

const dB = [[0, .005], [.005, .01], [.01, .02], [.02, .04], [.04, .1]];
const nB = [[1, 1], [3, 99]];
const dbL = ['<0.5%', '0.5-1%', '1-2%', '2-4%', '>4%'];
const agg = (side, di, ni, toward) => {
  const g = recs.filter(r => r.side === side && r.toward === toward &&
    r.dist >= dB[di][0] && r.dist < dB[di][1] && r.n >= nB[ni][0] && r.n <= nB[ni][1]);
  return g.length ? { r: g.filter(x => x.touch).length / g.length, n: g.length } : null;
};

console.log(`levels: ${recs.length} | horizon ${H}h | momentum ${MOM}h\n`);
for (const side of ['dn', 'up']) {
  console.log(side === 'dn'
    ? '=== layers BELOW | price falling (moving TO layer) vs rising ==='
    : '=== layers ABOVE | price rising (moving TO layer) vs falling ===');
  for (const [lbl, ni] of [['1 point', 0], ['3+ dense', 1]]) {
    console.log('  ' + lbl);
    console.log('  dist        to layer     away         Δ(magnetism)');
    for (let di = 0; di < 5; di++) {
      const a = agg(side, di, ni, true), b = agg(side, di, ni, false);
      console.log('  ' + dbL[di].padEnd(12) +
        (a ? (a.r * 100).toFixed(1) + '%(' + (a.n / 1e3 | 0) + 'k)' : '—').padEnd(13) +
        (b ? (b.r * 100).toFixed(1) + '%(' + (b.n / 1e3 | 0) + 'k)' : '—').padEnd(13) +
        (a && b ? ((a.r - b.r) * 100).toFixed(1) + ' pp' : '—'));
    }
  }
  console.log();
}
