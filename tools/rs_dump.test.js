#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// rs_dump.test.js - unit tests for the issue-#8 RS dump probe:
// dump-window detection + dedupe, RS math, entry-candidate filters.

const test = require('node:test');
const assert = require('node:assert');
const { detectDumps, rsFor, passesFilters, topCandidates, at, mergePages } = require('./rs_dump.js');

const H = 3600e3;
const T0 = 1_700_000_000_000;                       // fixed epoch, UTC-explicit
// bar layout matches klines(): [ts, close, high, low]
const bar = (i, c, h = c * 1.01, l = c * 0.99) => [T0 + i * H, c, h, l];
const series = closes => closes.map((c, i) => bar(i, c));

test('detectDumps: finds BTC<=-dump%/win window and dedupes overlaps', () => {
  // i=0: 96/100-1 = -4% qualifies; i=1 would qualify too (-3.5%) but
  // overlaps -> deduped; second non-overlapping leg starts at i=6.
  const closes = [100, 99, 98, 97, 96, 95.5, 95.5, 95.5, 95.5, 94.5, 93.5, 92.5, 91.5, 91, 91];
  const btc = series(closes);
  const dumps = detectDumps(btc, 2, 4);
  assert.strictEqual(dumps.length, 2, JSON.stringify(dumps));
  assert.strictEqual(dumps[0].t0, btc[0][0]);
  assert.strictEqual(dumps[0].t1, btc[4][0]);
  assert.ok(Math.abs(dumps[0].ch - -4) < 1e-9, 'ch off: ' + dumps[0].ch);
  assert.strictEqual(dumps[1].t0, btc[6][0]);
  assert.strictEqual(dumps[1].t1, btc[10][0]);
});

test('detectDumps: no dump when the drop never reaches the threshold', () => {
  const btc = series([100, 99.8, 99.7, 99.6, 99.5, 99.4, 99.3, 99.2, 99.1]);
  assert.strictEqual(detectDumps(btc, 2, 4).length, 0);
});

test('rsFor: RS = alt% - btc% inside the window, null on sparse bars', () => {
  const d = { t0: T0, t1: T0 + 4 * H, ch: -4 };
  const bars = series([100, 99.5, 99, 98.8, 98]);   // alt -2% vs btc -4%
  const r = rsFor(bars, d);
  assert.ok(r, 'record missing');
  assert.ok(Math.abs(r.rs - 2) < 1e-9, 'rs off: ' + r.rs);
  assert.strictEqual(r.btc, -4);
  assert.ok(Math.abs(r.alt - -2) < 1e-9, 'alt off: ' + r.alt);
  // window resolves to a single bar -> no return computable
  assert.strictEqual(rsFor([bar(0, 100)], d), null);
  // all bars after the window start -> no anchor bar
  assert.strictEqual(rsFor([bar(10, 100), bar(11, 99)], d), null);
});

// 25 flat prior bars (low=prevLow) + one decision bar at index 25.
const candBars = (lastC, lastH, lastL, prevLow = 95, nPrev = 25) => {
  const bars = [];
  for (let i = 0; i < nPrev; i++) bars.push([T0 + i * H, 100, 101, prevLow]);
  bars.push([T0 + nPrev * H, lastC, lastH, lastL]);
  return bars;
};
const T_END = nPrev => T0 + nPrev * H;

test('passesFilters: all three filters pass on a textbook candidate', () => {
  // last bar: low 94 pierces prevLow 95, close 96.5 recovers and sits
  // above the bar midpoint (97+94)/2 = 95.5; rs 2 >= 1.5.
  const bars = candBars(96.5, 97, 94);
  assert.strictEqual(passesFilters(bars, T_END(25), 2), true);
});

test('passesFilters: RS below threshold rejects alone', () => {
  const bars = candBars(96.5, 97, 94);
  assert.strictEqual(passesFilters(bars, T_END(25), 1.4), false);
  assert.strictEqual(passesFilters(bars, T_END(25), 1.5), true, 'boundary rs=1.5 must pass');
});

test('passesFilters: lower-half close rejects while break still holds', () => {
  // close 96 < midpoint 97, but low 94 still pierced and close > 95:
  // only the upper-half filter fails.
  const bars = candBars(96, 100, 94);
  assert.strictEqual(passesFilters(bars, T_END(25), 2), false);
});

test('passesFilters: no low pierce rejects while upper-half holds', () => {
  // low 96 stays above prevLow 95 -> no false-break; close 99 > mid 98.
  const bars = candBars(99, 100, 96);
  assert.strictEqual(passesFilters(bars, T_END(25), 2), false);
});

test('passesFilters: pierce without recovery rejects while upper-half holds', () => {
  // low 94 < prevLow 95 but close 94.9 fails to recover above 95, yet
  // still above its own midpoint 94.75 - isolates the recovery leg.
  const bars = candBars(94.9, 95.5, 94);
  assert.strictEqual(passesFilters(bars, T_END(25), 2), false);
});

test('passesFilters: fewer than lb prior bars cannot qualify', () => {
  const bars = candBars(96.5, 97, 94, 95, 23);      // b=23 < lb=24
  assert.strictEqual(passesFilters(bars, T_END(23), 2), false);
});

test('mergePages: newest-first pages with overlap -> ascending [ts,close,high,low] bars', () => {
  // Regression for the PR #92 entries() bug: klines() deduped bars in
  // a Map but returned map.entries() pairs, so bars[i][1] was the
  // nested bar array instead of a numeric close -> NaN RS -> zero
  // detected dumps on live data. This pins the output shape.
  const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91];
  const mkBar = (i, c) => [T0 + i * H, c, c * 1.01, c * 0.99];
  const all = closes.map((c, i) => mkBar(i, c));
  // pages as klines() collects them: each newest-first, the second
  // page overlaps the first on bars 5-6 (dedupe by ts)
  const pages = [
    all.slice(5).reverse(),                       // bars 9..5
    all.slice(0, 7).reverse(),                    // bars 6..0 (5,6 dup)
  ];
  const bars = mergePages(pages);
  assert.strictEqual(bars.length, 10, 'duplicated bars must dedupe by ts');
  assert.ok(bars.every((b, i) => b[0] === T0 + i * H), 'bars must sort ascending by ts');
  for (const b of bars) {
    assert.strictEqual(b.length, 4, 'bar must be [ts, close, high, low]');
    assert.strictEqual(typeof b[1], 'number', 'bars[i][1] must be the numeric close, not a nested pair');
  }
  assert.strictEqual(bars[0][1], 100);
  assert.strictEqual(bars[9][1], 91);
});

test('mergePages: single page and empty input', () => {
  const page = [bar(2, 98), bar(1, 99), bar(0, 100)];   // newest-first
  const bars = mergePages([page]);
  assert.deepStrictEqual(bars.map(b => b[0]), [T0, T0 + H, T0 + 2 * H]);
  assert.strictEqual(bars[0][1], 100);
  assert.deepStrictEqual(mergePages([]), []);
  assert.deepStrictEqual(mergePages([[]]), []);
});

test('at: last bar closed at/before ts', () => {
  const bars = series([100, 101, 102]);
  assert.strictEqual(at(bars, T0 + 2 * H), 2);
  assert.strictEqual(at(bars, T0 + 2 * H + 1), 2, 'mid-bar ts snaps down');
  assert.strictEqual(at(bars, T0 - 1), -1);
});

test('topCandidates: top-3 by RS desc, input untouched', () => {
  const list = [
    { sym: 'A', rs: 1.6 }, { sym: 'B', rs: 3.0 }, { sym: 'C', rs: 2.0 },
    { sym: 'D', rs: 5.0 }, { sym: 'E', rs: 1.5 },
  ];
  const top = topCandidates(list, 3);
  assert.deepStrictEqual(top.map(c => c.sym), ['D', 'B', 'C']);
  assert.strictEqual(list[0].sym, 'A', 'input order mutated');
});
