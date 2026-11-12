#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// backtest_btc_dump_rs.js — BTC-dump relative-strength screener (issue #8).
//
// Hypothesis: when BTC dumps hard on a 1H bar, alts that hold up
// (relative strength) are being absorbed by a large buyer; they
// out-bounce the market when BTC stabilizes.
//
// Signal (per partner spec):
//   BTC dump bar:   dP_btc <= -1.5%  OR  drop >= 1.8 * ATR14
//   Alt qualifies:  RS = dP_alt - dP_btc >= +1.5%
//                   close in upper half of the bar range
//                   false break: low < min(low,24)[prev] AND close > min(low,24)[prev]
// Entry: next bar open (+slip+fee), SL = signal-bar low - 0.2*ATR14
// Exit:  TP1 = +2R sells 50%, stop -> breakeven; remainder trails
//        by previous bar low; time stop after TIMESTOP bars.
// Portfolio: max MAXPOS concurrent positions; strongest RS first.
//
//   node tools/backtest_btc_dump_rs.js [--top=3] [--verbose]

const fs = require('fs'), path = require('path');
const CACHE = path.join(__dirname, '..', 'data', 'klines');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
const TOPN = +(arg('top') || 3);        // max new entries per dump bar
const REGIME = +(arg('regime') || 0);   // if 1: skip dumps while BTC < SMA200 (bear regime)
const MAXPOS = 8;
const FEE = 0.00055, SLIP = 0.001;      // taker fee + modeled slippage
const TIMESTOP = 120;                   // bars
const RS_MIN = 0.015, DUMP_PCT = 0.015, DUMP_ATR = 1.8;
const NON_CRYPTO = new Set('XAUUSDT XAGUSDT XPTUSDT XPDUSDT PAXGUSDT'.split(' '));

const load = sym => {
  const f = fs.readdirSync(CACHE).find(x => x.startsWith(sym + '_60_'));
  if (!f) return null;
  const j = JSON.parse(fs.readFileSync(path.join(CACHE, f)));
  return j.bars;
};

const atr = (bars, i, n = 14) => {
  if (i < n + 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++)
    s += Math.max(bars[k].h - bars[k].l,
      Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
  return s / n;
};

const btc = load('BTCUSDT');
if (!btc) { console.error('no BTC cache'); process.exit(1); }
const btcIdx = new Map(btc.map((b, i) => [b.ts, i]));

// load all alts that overlap BTC history
const alts = {};
for (const f of fs.readdirSync(CACHE)) {
  const sym = f.split('_')[0];
  if (sym === 'BTCUSDT' || NON_CRYPTO.has(sym)) continue;
  const bars = load(sym);
  if (bars && bars.length > 500) alts[sym] = { bars, idx: new Map(bars.map((b, i) => [b.ts, i])) };
}
console.error(`alts loaded: ${Object.keys(alts).length}`);

const trades = [];
let open = [];   // {sym, entry, sl, r, half, ts}

const closeTrade = (t, exitP, reason, exitTs, frac = 1) => {
  const R = (exitP - t.entry) / (t.entry - t.sl0) / frac;
  trades.push({ sym: t.sym, entryTs: t.entryTs, exitTs, R: +R.toFixed(3), reason });
};

// walk BTC bars; simulate per-bar: first exits on open positions, then new entries
for (let bi = 30; bi < btc.length - 1; bi++) {
  const b = btc[bi], ts = b.ts;

  // ---- manage open positions on THIS bar (their own bar data by ts) ----
  for (const p of open) {
    const ab = alts[p.sym].bars, ai = alts[p.sym].idx.get(ts);
    if (ai === undefined) continue;
    const bar = ab[ai];
    // stop check (conservative: stop hits before TP within the same bar)
    if (bar.l <= p.sl) {
      const out = p.halfDone ? Math.max(p.sl, p.entry * 1.0015) : p.sl;
      closeTrade(p, out * (1 - SLIP) * (1 - FEE), p.halfDone ? 'TRAIL/BE' : 'SL', ts);
      p.dead = true; continue;
    }
    // TP1 at +2R
    if (!p.halfDone && bar.h >= p.entry + 2 * (p.entry - p.sl0)) {
      closeTrade(p, (p.entry + 2 * (p.entry - p.sl0)) * (1 - SLIP) * (1 - FEE), 'TP1', ts, 2);
      p.halfDone = true; p.sl = p.entry * 1.0015;
    }
    // trail stop to prev bar low (after TP1) or time stop
    const age = ai - alts[p.sym].idx.get(p.entryTs);
    if (p.halfDone && ai > 0) p.sl = Math.max(p.sl, ab[ai - 1].l);
    if (age >= TIMESTOP) {
      closeTrade(p, bar.c * (1 - SLIP) * (1 - FEE), 'TIME', ts, p.halfDone ? 2 : 1);
      p.dead = true;
    }
  }
  open = open.filter(p => !p.dead);

  // ---- detect BTC dump on this closed bar ----
  const atrB = atr(btc, bi); if (!atrB) continue;
  if (REGIME) {
    if (bi < 200) continue;
    const sma200 = btc.slice(bi - 200, bi).reduce((s, x) => s + x.c, 0) / 200;
    if (b.c < sma200) continue;         // bear regime: absorption keeps failing
  }
  const dB = (b.c - b.o) / b.o;
  const drop = (b.o - b.c);
  if (!(dB <= -DUMP_PCT || drop >= DUMP_ATR * atrB)) continue;

  // screen alts on the same bar
  const cands = [];
  for (const [sym, A] of Object.entries(alts)) {
    if (open.some(p => p.sym === sym)) continue;
    const ai = A.idx.get(ts); if (ai === undefined || ai < 30) continue;
    const a = A.bars[ai];
    const dA = (a.c - a.o) / a.o;
    const rs = dA - dB;
    if (rs < RS_MIN) continue;
    if (a.c < a.l + 0.5 * (a.h - a.l)) continue;                      // upper half close
    const prev24 = Math.min(...A.bars.slice(ai - 24, ai).map(x => x.l));
    if (!(a.l < prev24 && a.c > prev24)) continue;                    // false break of 24h low
    const atrA = atr(A.bars, ai); if (!atrA) continue;
    cands.push({ sym, rs, atrA, low: a.l });
  }
  cands.sort((x, y) => y.rs - x.rs);

  for (const c of cands.slice(0, TOPN)) {
    if (open.length >= MAXPOS) break;
    const nxt = alts[c.sym].bars[alts[c.sym].idx.get(ts) + 1];
    if (!nxt) continue;
    const entry = nxt.o * (1 + SLIP) * (1 + FEE);
    const sl = c.low - 0.2 * c.atrA;
    if (sl >= entry) continue;
    open.push({ sym: c.sym, entry, sl, sl0: sl, halfDone: false, entryTs: nxt.ts });
    if (VERBOSE) console.error(`+${c.sym} RS=${(c.rs * 100).toFixed(1)}% @${entry.toFixed(4)}`);
  }
}
for (const p of open) closeTrade(p, p.entry, 'EOD', btc[btc.length - 1].ts);

// ---- report ----
const tot = trades.reduce((s, t) => s + t.R, 0);
const wins = trades.filter(t => t.R > 0);
const by = {};
for (const t of trades) { const y = new Date(t.exitTs).getUTCFullYear(); (by[y] = by[y] || []).push(t.R); }
console.log(`trades ${trades.length} | wins ${wins.length} (${(100 * wins.length / (trades.length || 1)).toFixed(0)}%) | sumR ${tot.toFixed(2)} | avgR ${(tot / (trades.length || 1)).toFixed(3)}`);
for (const [y, rs] of Object.entries(by).sort())
  console.log(`  ${y}: n=${rs.length} sumR=${rs.reduce((a, b) => a + b, 0).toFixed(2)} avgR=${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3)}`);
const rsn = {};
for (const t of trades) rsn[t.reason] = (rsn[t.reason] || 0) + 1;
console.log('  exits:', JSON.stringify(rsn));
