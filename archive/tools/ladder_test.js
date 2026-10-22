// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// tmp_ladder_test.js — one-off run of the "ladder across liquidity layers" idea
// on BTC 1H, October 2026. Layers = swing-low/high clusters (liquidation-map proxy).
const fs = require('fs'), path = require('path');
const bars = [];
for (const f of fs.readdirSync(path.join(__dirname, '..', 'data', 'klines'))
  .filter(x => x.startsWith('BTCUSDT'))) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'klines', f)));
  for (const b of d.bars) bars.push(b);
}
bars.sort((a, b) => a.ts - b.ts);
const dedup = new Map(); for (const b of bars) dedup.set(b.ts, b);
const B = [...dedup.values()];
console.log('bars:', B.length, new Date(B[0].ts).toISOString(), '->', new Date(B.at(-1).ts).toISOString());

const K = 3, TOL = 0.004;              // swing ±3 bars, cluster within 0.4%
const t0 = Date.parse('2026-10-05T00:00:00Z');
const i0 = B.findIndex(b => b.ts >= t0);
const LOOK = 24 * 14;                  // layers from the last 14 days

// swing lows/highs in window [i0-LOOK, i0)
const lows = [], highs = [];
for (let i = Math.max(K, i0 - LOOK); i < i0 - K; i++) {
  let isL = true, isH = true;
  for (let j = i - K; j <= i + K; j++) {
    if (j === i) continue;
    if (B[j].l < B[i].l) isL = false;
    if (B[j].h > B[i].h) isH = false;
  }
  if (isL) lows.push(B[i].l);
  if (isH) highs.push(B[i].h);
}
// clustering by TOL
const clust = (arr) => {
  arr.sort((a, b) => a - b);
  const out = [];
  for (const v of arr) {
    const last = out[out.length - 1];
    if (last && v - last.max < last.max * TOL) { last.n++; last.max = v; }
    else out.push({ min: v, max: v, n: 1 });
  }
  return out;
};
const px = B[i0].c;
const layers = clust(lows).filter(c => c.max < px).sort((a, b) => b.max - a.max);
const upper = clust(highs).filter(c => c.min > px).sort((a, b) => a.min - b.min)[0];

console.log('price @', new Date(B[i0].ts).toISOString(), '=', px);
console.log('lower layers:', layers.map(c => `${c.min.toFixed(0)}-${c.max.toFixed(0)} (x${c.n})`).join(' | '));
console.log('upper layer:', upper ? `${upper.min.toFixed(0)}-${upper.max.toFixed(0)} (x${upper.n})` : 'none');

// ATR for stop offsets
let atr = 0; for (let i = i0 - 14; i < i0; i++) atr += B[i].h - B[i].l; atr /= 14;
console.log('ATR14 ~', atr.toFixed(0));

const tp = upper ? upper.min : px * 1.05;   // take = lower bound of the upper layer
console.log('TP:', tp.toFixed(0));

// ===== Variant A: single order, stop below the layer, on breach move to the next layer =====
function simA(dep = 100) {
  let cash = dep, pos = 0, entry = 0, li = 0, log = [];
  let order = null, stop = null;
  const arm = (idx) => {
    const L = layers[idx];
    order = L.max;                       // limit at the layer's upper bound
    stop = L.min - 0.3 * atr;            // stop below the layer
  };
  arm(0);
  for (let i = i0; i < B.length && i < i0 + 24 * 14; i++) {
    const b = B[i];
    if (pos === 0 && order && b.l <= order) {       // order filled
      pos = cash / order; entry = order; cash = 0;
      log.push(`${new Date(b.ts).toISOString().slice(5, 16)} BUY ${pos.toFixed(6)} @ ${order.toFixed(0)}`);
      order = null;
    }
    if (pos > 0) {
      if (b.h >= tp) {                       // take
        cash = pos * tp; log.push(`${new Date(b.ts).toISOString().slice(5, 16)} TP @ ${tp.toFixed(0)}`);
        return { cash, log, fills: li + 1 };
      }
      if (b.l <= stop) {                     // stop, move to the next layer
        cash = pos * stop; pos = 0;
        log.push(`${new Date(b.ts).toISOString().slice(5, 16)} STOP @ ${stop.toFixed(0)} → -${(100 - cash).toFixed(1)}%`);
        li++;
        if (li < layers.length) arm(li); else { order = null; }
      }
    }
  }
  if (pos > 0) { cash = pos * B[Math.min(i0 + 24 * 14 - 1, B.length - 1)].c; log.push('OPEN → mark-to-close'); }
  return { cash, log, fills: li + (pos > 0 ? 1 : 0) };
}

// ===== Variant B: ladder — a deposit slice per layer, stop below the deepest =====
function simB(dep = 100, nLayers = 4) {
  const use = layers.slice(0, nLayers);
  const per = dep / use.length;
  let cash = dep, pos = 0, cost = 0, log = [];
  const deepStop = use[use.length - 1].min - 0.3 * atr;
  for (let i = i0; i < B.length && i < i0 + 24 * 14; i++) {
    const b = B[i];
    for (const L of use) {
      if (!L._f && b.l <= L.max) {           // layer order filled
        L._f = true;
        const q = per / L.max; pos += q; cost += per; cash -= per;
        log.push(`${new Date(b.ts).toISOString().slice(5, 16)} BUY ${q.toFixed(6)} @ ${L.max.toFixed(0)} (layer ${L.min.toFixed(0)}-${L.max.toFixed(0)})`);
      }
    }
    if (pos > 0) {
      if (b.h >= tp) {
        cash += pos * tp; log.push(`${new Date(b.ts).toISOString().slice(5, 16)} TP @ ${tp.toFixed(0)} (avg ${(cost / pos).toFixed(0)})`);
        return { cash, log };
      }
      if (b.l <= deepStop) {
        cash += pos * deepStop; pos = 0;
        log.push(`${new Date(b.ts).toISOString().slice(5, 16)} STOP-ALL @ ${deepStop.toFixed(0)}`);
        break;
      }
    }
  }
  if (pos > 0) { const last = B[Math.min(i0 + 24 * 14 - 1, B.length - 1)]; cash += pos * last.c; log.push(`OPEN → mark-to-close ${last.c.toFixed(0)}`); }
  return { cash, log };
}

console.log('\n===== Variant A: stop below layer, move to next =====');
const A = simA(100); A.log.forEach(l => console.log(' ', l)); console.log(' result:', A.cash.toFixed(2), 'USD');
console.log('\n===== Variant B: ladder over 4 layers, stop below the deepest =====');
const Bs = simB(100, 4); Bs.log.forEach(l => console.log(' ', l)); console.log(' result:', Bs.cash.toFixed(2), 'USD');
