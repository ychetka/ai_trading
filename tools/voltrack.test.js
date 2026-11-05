#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// voltrack.test.js - unit tests for the issue-#47 event model,
// liquidation map and scenario classifier.

const test = require('node:test');
const assert = require('node:assert');
const { deriveEvents, liqMap, classify } = require('./voltrack.js');

const snap = (ts, mid, wallsB, wallsA, imb = 1) => ({
  ts, sym: 'BTCUSDT',
  agg: { mid, imb, wallsB: wallsB || [], wallsA: wallsA || [] },
});
const M = 1e6, MIN = 60000;

test('deriveEvents: pull/hold/break/appear/reload/drop/flip', () => {
  const t0 = 1e9;
  const recs = [
    // bid wall -1% ($5M), ask wall +1% ($5M)
    snap(t0, 100000, [[-1, 5 * M]], [[1, 5 * M]]),
    // same walls survive
    snap(t0 + MIN, 100000, [[-1, 5 * M]], [[1, 5 * M]]),
    // ask wall pulled untouched (mid flat) -> WALL_PULL
    snap(t0 + 2 * MIN, 100000, [[-1, 5 * M]], []),
    // fresh bid wall appears -> WALL_APPEAR
    snap(t0 + 3 * MIN, 100000, [[-1, 5 * M], [-0.5, 3 * M]], []),
    // mid drops through the -1% wall ($99k) -> WALL_BREAK; also VOLUME_DROP B-side
    snap(t0 + 4 * MIN, 98500, [[-0.5, 3 * M]], []),
    // mid returns near old -0.5% wall (~99k) and it vanishes -> WALL_HOLD zone
    snap(t0 + 5 * MIN, 99200, [], [], 0.5),
    // bid wall re-appears near dead level -> WALL_RELOAD; imb flip -> STACK_FLIP
    snap(t0 + 6 * MIN, 99200, [[-0.5, 4 * M]], [], 2.0),
  ];
  const ev = deriveEvents(recs, { minUsd: 1e6, dropPct: 35 });
  const types = ev.map(e => e.type);
  assert.ok(types.includes('WALL_PULL'), 'pull missing: ' + JSON.stringify(types));
  assert.ok(types.includes('WALL_BREAK'), 'break missing');
  assert.ok(types.includes('WALL_APPEAR'), 'appear missing');
  assert.ok(types.includes('WALL_RELOAD'), 'reload missing');
  assert.ok(types.includes('VOLUME_DROP'), 'volume drop missing');
  assert.ok(types.includes('STACK_FLIP'), 'stack flip missing');
  const brk = ev.find(e => e.type === 'WALL_BREAK');
  assert.strictEqual(brk.side, 'B');
  assert.ok(Math.abs(brk.px - 99000) < 500, 'break px off: ' + brk.px);
});

test('deriveEvents: surviving wall emits nothing', () => {
  const t0 = 1e9;
  const recs = [
    snap(t0, 100000, [[-1, 5 * M]], []),
    snap(t0 + MIN, 100100, [[-1, 5 * M]], []),
    snap(t0 + 2 * MIN, 99900, [[-1, 5 * M]], []),
  ];
  const ev = deriveEvents(recs, { minUsd: 1e6 }).filter(e => e.type !== 'WALL_APPEAR');
  assert.strictEqual(ev.length, 0, JSON.stringify(ev));
});

test('liqMap: long entry produces pool below, short above', () => {
  const mids = [{ ts: 1e9, mid: 80000 }];
  const whales = [
    { coin: 'BTC', type: 'open', ts: 1e9, usd: 1e6, sz: 1 },   // long at 80k
    { coin: 'BTC', type: 'open', ts: 1e9, usd: 1e6, sz: -1 },  // short at 80k
    { coin: 'ETH', type: 'open', ts: 1e9, usd: 1e6, sz: 1 },   // other coin ignored
    { coin: 'BTC', type: 'close', ts: 1e9, usd: 1e6, sz: -1 }, // close ignored
  ];
  const { below, above } = liqMap(whales, mids, 80000, { coin: 'BTC', bucket: 0.5 });
  assert.ok(below.length > 0 && below.every(p => p.px < 80000), 'long-liq pools below missing');
  assert.ok(above.length > 0 && above.every(p => p.px > 80000), 'short-liq pools above missing');
  // 10x long liq ~72k dominates -> nearest strong bucket < 74k
  const top = below.reduce((a, b) => (b.usd > a.usd ? b : a));
  assert.ok(top.px > 70000 && top.px < 76000, 'top long-liq bucket off: ' + top.px);
});

test('classify: base_down toward long-liq magnet', () => {
  const pools = { below: [{ px: 73000, usd: 200e6 }], above: [{ px: 83000, usd: 500e6 }] };
  const evs = [
    { type: 'WALL_BREAK', side: 'B' }, { type: 'WALL_BREAK', side: 'B' },
    { type: 'WALL_PULL', side: 'B' }, { type: 'WALL_BREAK', side: 'B' },
    { type: 'WALL_PULL', side: 'A' },
  ];
  const walls = { wallsA: [[0.5, 10e6]], wallsB: [[-0.5, 10e6]] };
  const r = classify(76000, pools, evs, walls);
  assert.strictEqual(r.state, 'base_down');
  assert.strictEqual(r.dir, -1);
  assert.strictEqual(r.target, 73000);
});

test('classify: squeeze on bid hold + reload, long signal at magnet', () => {
  const pools = { below: [{ px: 75500, usd: 100e6 }], above: [{ px: 80000, usd: 900e6 }] };
  const evs = [
    { type: 'WALL_HOLD', side: 'B' }, { type: 'WALL_RELOAD', side: 'B' },
    { type: 'WALL_PULL', side: 'A' }, { type: 'WALL_PULL', side: 'A' },
  ];
  const walls = { wallsA: [[0.8, 8e6]], wallsB: [[-0.3, 60e6]] };
  const r = classify(75800, pools, evs, walls);
  assert.strictEqual(r.state, 'squeeze');
  assert.strictEqual(r.dir, 1);
  assert.strictEqual(r.target, 80000);
  assert.ok(r.signals.some(s => s.side === 'long'), 'long signal missing');
});

test('classify: base_up on lifted ask ceiling, short signal under lid', () => {
  const pools = { below: [{ px: 73000, usd: 200e6 }], above: [{ px: 80000, usd: 500e6 }] };
  // ceiling lifts: ask walls pulled/broken, bid side intact
  const evs = [
    { type: 'WALL_PULL', side: 'A' }, { type: 'WALL_PULL', side: 'A' },
    { type: 'WALL_BREAK', side: 'A' }, { type: 'WALL_PULL', side: 'A' },
  ];
  const walls = { wallsA: [[0.8, 5e6]], wallsB: [[-0.5, 40e6]] };
  const r = classify(76000, pools, evs, walls);
  assert.strictEqual(r.state, 'base_up');
  assert.strictEqual(r.dir, 1);
  assert.strictEqual(r.target, 80000);
  // short signal: persistent ask lid + B break series, no holds
  const evs2 = [
    { type: 'WALL_BREAK', side: 'B' }, { type: 'WALL_BREAK', side: 'B' },
  ];
  const walls2 = { wallsA: [[0.5, 60e6]], wallsB: [[-0.5, 8e6]] };
  const r2 = classify(76000, pools, evs2, walls2);
  const sig = r2.signals.find(s => s.side === 'short');
  assert.ok(sig, 'short signal missing under ask lid');
  assert.ok(sig.invalid > 76000, 'invalid must sit above price: ' + sig.invalid);
});

test('deriveEvents: wall touched then removed = WALL_HOLD', () => {
  const t0 = 1e9;
  const recs = [
    snap(t0, 100000, [[-1, 5 * M]], []),          // bid wall at ~99k
    snap(t0 + MIN, 99300, [[-1, 5 * M]], []),     // mid approaches (0.3%)
    snap(t0 + 2 * MIN, 99300, [], []),            // wall gone after touch -> HOLD
  ];
  const ev = deriveEvents(recs, { minUsd: 1e6 });
  const hold = ev.find(e => e.type === 'WALL_HOLD');
  assert.ok(hold, 'hold missing: ' + JSON.stringify(ev.map(e => e.type)));
  assert.strictEqual(hold.side, 'B');
});

test('classify: cascade when inside magnet zone and breaks dominate', () => {
  const pools = {
    below: [{ px: 73000, usd: 200e6 }, { px: 69000, usd: 80e6 }],
    above: [{ px: 83000, usd: 500e6 }],
  };
  const evs = [
    { type: 'WALL_BREAK', side: 'B' }, { type: 'WALL_BREAK', side: 'B' },
    { type: 'WALL_BREAK', side: 'B' }, { type: 'WALL_PULL', side: 'B' },
  ];
  const walls = { wallsA: [[0.5, 10e6]], wallsB: [[-0.2, 5e6]] };
  const r = classify(73200, pools, evs, walls);
  assert.strictEqual(r.state, 'cascade');
  assert.strictEqual(r.target, 69000);
});
