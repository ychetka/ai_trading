#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// voltrack_report.test.js - flag logic + autopsy window/delay tests.

const test = require('node:test');
const assert = require('node:assert');
const { flagSetup, analyze } = require('./voltrack_report.js');
const { autopsy, eligibleRows } = require('./cascade_autopsy.js');

const H = 3600e3;
const oc = (R, setup = 's1', regime = 'neutral') => ({ sym: 'X', side: 'long', setup, regime, state: 'squeeze', R, reason: 'expiry' });
const st = (ts, state = 'range', mid = 100, events = [], regime = 'neutral') =>
  ({ ts, sym: 'BTCUSDT', mid, state, regime, signals: [], events });

test('flagSetup: thresholds', () => {
  assert.strictEqual(flagSetup(0, null, null, 0), 'SILENT');
  assert.strictEqual(flagSetup(5, 1.5, 80, 5), 'INSUFFICIENT');   // below n
  assert.strictEqual(flagSetup(25, 0.5, 40, 25), 'SIGNIFICANT');
  assert.strictEqual(flagSetup(25, 0.5, 10, 25), 'DEAD');         // win < dead-win
  assert.strictEqual(flagSetup(25, -0.2, 40, 25), 'DEAD');        // meanR <= 0
  assert.strictEqual(flagSetup(25, 0.1, 30, 25), 'INSUFFICIENT'); // between dead-win and flag-win
});

test('analyze: zero-signal log reports honestly + SILENT on known setups', () => {
  const a = analyze([st(0), st(60000, 'squeeze')], []);
  assert.strictEqual(a.outcomes.n, 0);
  assert.strictEqual(Object.keys(a.signals.emitted).length, 0);
  assert.strictEqual(a.states.squeeze, 1);
  assert.strictEqual(a.flags['long:liq-magnet + B hold + bid stack'].flag, 'SILENT');
  assert.strictEqual(a.flags['short:ask lid + B break series'].flag, 'SILENT');
});

test('analyze: outcome breakdowns + flags wire through', () => {
  const rows = [st(0, 'squeeze', 100, [], 'bear')];
  const outcomes = [...Array(25)].map((_, i) => oc(i < 10 ? 1 : -0.5, 'liq-magnet + B hold + bid stack', 'bear'));
  const a = analyze(rows, outcomes);
  assert.strictEqual(a.outcomes.n, 25);
  const f = a.flags['long:liq-magnet + B hold + bid stack'];
  assert.ok(f, 'flag keyed by side:setup');
  assert.strictEqual(f.flag, 'SIGNIFICANT'); // meanR=(10-7.5)/25=0.1>0, win 40>=35
  assert.strictEqual(a.outcomes.perRegime.bear.n, 25);
});

test('autopsy: picks densest window, honors delay cutoff', () => {
  const now = Date.now();
  const old = now - 30 * H;   // eligible (>24h ago)
  const rows = [
    st(old, 'range', 100), st(old + 60000, 'squeeze', 101, [{ ts: old + 60000, type: 'WALL_HOLD', side: 'B', px: 99 }]),
    st(old + 120000, 'cascade', 98, [{ ts: old + 120000, type: 'WALL_BREAK', side: 'B', px: 99 }]),
    st(now - 1000, 'cascade', 50),   // too fresh
  ];
  const eligible = eligibleRows(rows, 24, now);   // the actual cutoff fn used by main()
  assert.strictEqual(eligible.length, 3);         // the fresh row is ineligible
  const a = autopsy(eligible, 'BTCUSDT', { hours: 1 });
  assert.ok(a);
  assert.strictEqual(a.rows, 3);
  assert.strictEqual(a.events.length, 2);
  assert.ok(a.transitions.some(t => t.state === 'cascade'));
  assert.strictEqual(a.changePct, -2);
});

test('autopsy: null on empty input', () => {
  assert.strictEqual(autopsy([], 'X', { hours: 1 }), null);
});
