// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// tmp_magnet_test.js — tests the "dense liquidity zone attracts price" hypothesis.
// Layer proxy: swing-low/high clusters over 168h (stops/liquidations live at swings).
// For each layer below/above price we measure: will price touch it within H hours.
// Comparing touch-rate by density (n points in cluster) at equal distance —
// that is what isolates "magnetism" from plain zone width.
const fs = require('fs'), path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'klines');
const K = 3, TOL = 0.004, LOOK = 168, H = 168, STEP = 6; // swing±3, 7d window, 168h horizon, 6h step

const files = fs.readdirSync(DIR);
const syms = [...new Set(files.map(f => f.split('_')[0]))];
const recs = [];  // {side, dist, n, touch}

for (const sym of syms) {
  const map = new Map();
  for (const f of files.filter(x => x.startsWith(sym + '_')))
    for (const b of JSON.parse(fs.readFileSync(path.join(DIR, f))).bars) map.set(b.ts, b);
  const B = [...map.values()].sort((a, b) => a.ts - b.ts);
  if (B.length < LOOK + H + 100) continue;
  const tIdx = new Map(B.map((b, i) => [b.ts, i]));

  for (let t = LOOK + K; t < B.length - H - K; t += STEP) {
    const px = B[t].c;
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
    const lo = clust(lows).filter(c => c.max < px && c.max > px * 0.9);   // down to −10%
    const hi = clust(highs).filter(c => c.min > px && c.min < px * 1.1);  // up to +10%
    for (const c of lo) {
      let touch = false;
      for (let j = t + 1; j <= t + H; j++) if (B[j].l <= c.max) { touch = true; break; }
      recs.push({ side: 'dn', dist: (px - c.max) / px, n: c.n, touch });
    }
    for (const c of hi) {
      let touch = false;
      for (let j = t + 1; j <= t + H; j++) if (B[j].h >= c.min) { touch = true; break; }
      recs.push({ side: 'up', dist: (c.min - px) / px, n: c.n, touch });
    }
  }
}

// aggregation: touch-rate by buckets (side × distance × density)
const dB = [[0, .005], [.005, .01], [.01, .02], [.02, .04], [.04, .1]];
const nB = [[1, 1], [2, 2], [3, 99]];
const grid = {};
for (const r of recs) {
  const di = dB.findIndex(x => r.dist >= x[0] && r.dist < x[1]);
  const ni = nB.findIndex(x => r.n >= x[0] && r.n <= x[1]);
  if (di < 0 || ni < 0) continue;
  const k = r.side + '|' + di + '|' + ni;
  (grid[k] = grid[k] || { n: 0, t: 0 }).n++; if (r.touch) grid[k].t++;
}
const dbL = ['<0.5%', '0.5-1%', '1-2%', '2-4%', '>4%'];
console.log(`total levels: ${recs.length} | horizon ${H}h | swing window ${LOOK}h\n`);
for (const side of ['dn', 'up']) {
  console.log(side === 'dn' ? '=== layers BELOW price (long stops/liquidations) ===' : '=== layers ABOVE price (short stops) ===');
  console.log('dist\\n    1 point    2 points   3+ points (dense zone)');
  for (let di = 0; di < 5; di++) {
    let row = dbL[di].padEnd(10);
    for (let ni = 0; ni < 3; ni++) {
      const g = grid[side + '|' + di + '|' + ni];
      row += (g ? (g.t / g.n * 100).toFixed(1) + '% (' + g.n + ')' : '—').padEnd(14);
    }
    console.log(row);
  }
  console.log();
}
