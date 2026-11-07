#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// voltrack_join.test.js - unit tests for the signal-to-outcome joiner.

const test = require('node:test');
const assert = require('node:assert');
const { resolve, summarize } = require('./voltrack_join.js');
const { regimeOf } = require('./voltrack.js');

const MIN = 60000;
const row = (ts, mid, signals, extra = {}) => ({
  ts, sym: 'BTCUSDT', mid, state: 'range', regime: 'neutral', signals: signals || [], ...extra,
});
const sig = (px, target, invalid, side = 'long') => ({ side, px, setup: 'test', target, invalid });

test('resolve: long hits invalid -> R=-1', () => {
  const rows = [
    row(0, 100, [sig(100, 110, 95)]),
    row(MIN, 99),
    row(2 * MIN, 95),          // invalid touched
    row(3 * MIN, 120),         // would have been target - too late
  ];
  const { closed, open } = resolve(rows, { expiryMs: 3600e3 });
  assert.strictEqual(open.length, 0);
  assert.strictEqual(closed.length, 1);
  assert.strictEqual(closed[0].reason, 'invalid');
  assert.strictEqual(closed[0].R, -1);
  assert.ok(closed[0].mae < 0, 'mae tracked');
});

test('resolve: long hits target -> R=+2', () => {
  const rows = [
    row(0, 100, [sig(100, 110, 95)]),
    row(MIN, 105),
    row(2 * MIN, 111),
  ];
  const { closed } = resolve(rows, { expiryMs: 3600e3 });
  assert.strictEqual(closed.length, 1);
  assert.strictEqual(closed[0].reason, 'target');
  assert.strictEqual(closed[0].R, 2);
});

test('resolve: invalid wins over target on same tick (conservative)', () => {
  const rows = [
    row(0, 100, [sig(100, 110, 95)]),
    row(MIN, 90), // mid crossed both target zone? no: below invalid -> invalid
  ];
  const { closed } = resolve(rows);
  assert.strictEqual(closed[0].reason, 'invalid');
});

test('resolve: expiry exits mark-to-mid', () => {
  const rows = [
    row(0, 100, [sig(100, 110, 95)]),
    row(3600e3, 102),           // still inside, expiry at 1h
    row(3700e3, 103),           // past expiry -> exit at mid
  ];
  const { closed } = resolve(rows, { expiryMs: 3600e3 });
  assert.strictEqual(closed[0].reason, 'expiry');
  assert.strictEqual(closed[0].exit, 102);   // first tick at/after expiry boundary
  assert.strictEqual(closed[0].R, 0.4);      // (102-100)/5
});

test('resolve: repeated signal does not stack while open; reopens after close', () => {
  const rows = [
    row(0, 100, [sig(100, 110, 95)]),
    row(MIN, 100, [sig(100, 110, 95)]),     // same signal again - ignored
    row(2 * MIN, 111),                       // closes target
    row(3 * MIN, 100, [sig(100, 110, 95)]), // opens fresh
    row(4 * MIN, 95),                        // invalid
  ];
  const { closed, open } = resolve(rows);
  assert.strictEqual(open.length, 0);
  assert.strictEqual(closed.length, 2);
  assert.strictEqual(closed[0].reason, 'target');
  assert.strictEqual(closed[1].reason, 'invalid');
  assert.strictEqual(closed[1].entryTs, 3 * MIN);
});

test('resolve: short side mirrors correctly', () => {
  const rows = [
    row(0, 100, [sig(100, 90, 105, 'short')]),
    row(MIN, 89),
  ];
  const { closed } = resolve(rows);
  assert.strictEqual(closed[0].reason, 'target');
  assert.strictEqual(closed[0].R, 2);   // (100-90)/5
});

test('resolve: still-open position is not closed at log end', () => {
  const rows = [row(0, 100, [sig(100, 110, 95)]), row(MIN, 101)];
  const { closed, open } = resolve(rows);
  assert.strictEqual(closed.length, 0);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].entry, 100);
});

test('summarize: honest N/mean/win/byState/byRegime', () => {
  const closed = [
    { R: -1, reason: 'invalid', state: 'cascade', regime: 'bear' },
    { R: 2, reason: 'target', state: 'squeeze', regime: 'neutral' },
    { R: 0.5, reason: 'expiry', state: 'squeeze', regime: 'neutral' },
  ];
  const s = summarize(closed);
  assert.strictEqual(s.n, 3);
  assert.strictEqual(s.meanR, 0.5);
  assert.strictEqual(s.medianR, 0.5);
  assert.strictEqual(s.winPct, 66.7);
  assert.strictEqual(s.byRegime.neutral.n, 2);
  assert.strictEqual(s.byReason.invalid, 1);
});

test('regimeOf: 24h drift tags bull/bear/neutral', () => {
  const mk = (ts, mid) => ({ ts, agg: { mid } });
  const day = 24 * 3600e3;
  assert.strictEqual(regimeOf([mk(0, 100), mk(day, 103)], day), 'bull');
  assert.strictEqual(regimeOf([mk(0, 100), mk(day, 97)], day), 'bear');
  assert.strictEqual(regimeOf([mk(0, 100), mk(day, 100.5)], day), 'neutral');
  assert.strictEqual(regimeOf([mk(day - 1000, 100), mk(day, 110)], day), 'neutral', 'no 24h lookback -> neutral');
});
