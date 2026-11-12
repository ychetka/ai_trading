#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// fetch_oi_spot.js — phase-2 data for pump fade (issue #5):
//   1. Bybit 1h open-interest in merged windows around pump triggers
//      (detector identical to backtest_pump_variants.js) -> data/oi/SYM.json
//   2. Binance SPOT 1h klines full history -> data/spot/SYM.json
// Resumable: existing files are skipped/refilled. ~6k calls total.
//   node tools/fetch_oi_spot.js [--syms=BTC,ETH] [--oi-only|--spot-only]

const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'data', 'klines');
const OI_DIR = path.join(ROOT, 'data', 'oi');
const SPOT_DIR = path.join(ROOT, 'data', 'spot');
fs.mkdirSync(OI_DIR, { recursive: true });
fs.mkdirSync(SPOT_DIR, { recursive: true });

const H = 3600e3;
const NON = new Set('XAUUSDT XAGUSDT XPTUSDT XPDUSDT PAXGUSDT'.split(' '));
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const ONLY = arg('syms') ? new Set(arg('syms').toUpperCase().split(',').map(s => s + 'USDT')) : null;
const DO_OI = !process.argv.includes('--spot-only');
const DO_SPOT = !process.argv.includes('--oi-only');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const apiJson = async (url, tag) => {
  for (let t = 0; t < 6; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'curl/8.0' } });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (t + 1)); continue; }
      return await r.json();
    } catch (e) { if (t === 5) { console.log('FAIL', tag, e.message); return null; } await sleep(1500 * (t + 1)); }
  }
  return null;
};

const atr = (b, i, n = 14) => {
  if (i < n + 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++)
    s += Math.max(b[k].h - b[k].l, Math.abs(b[k].h - b[k - 1].c), Math.abs(b[k].l - b[k - 1].c));
  return s / n;
};

// pump triggers per symbol (same detector as the backtest)
function triggers(sym, bars) {
  const ts = [];
  for (let i = 30; i < bars.length - 3; i++) {
    const b = bars[i], a = atr(bars, i); if (!a) continue;
    const vs = bars.slice(i - 24, i).reduce((s, x) => s + x.v, 0) / 24;
    if (b.v > 5 * vs && (b.h - b.l) > 3 * a && b.c > b.o) ts.push(b.ts);
  }
  return ts;
}

const mergeWindows = (ts, pre, post) => {
  const W = [];
  let s = ts[0] - pre, e = ts[0] + post;
  for (let k = 1; k < ts.length; k++) {
    const ws = ts[k] - pre, we = ts[k] + post;
    if (ws <= e) e = Math.max(e, we); else { W.push([s, e]); s = ws; e = we; }
  }
  W.push([s, e]);
  return W;
};

// ---------- Bybit OI (200h chunks, paging backwards inside each window) ----------
async function fetchOI(sym, ts) {
  const file = path.join(OI_DIR, sym + '.json');
  let store = {};
  if (fs.existsSync(file)) store = JSON.parse(fs.readFileSync(file)).oi || {};
  // skip windows already fully covered? cheap approach: refetch only if file missing
  if (Object.keys(store).length) { console.log('OI', sym, 'cached', Object.keys(store).length); return; }
  const W = mergeWindows(ts, 28 * H, 2 * H);
  let calls = 0;
  for (const [ws, we] of W) {
    let end = we;
    for (;;) {
      const j = await apiJson(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${sym}` +
        `&intervalTime=1h&startTime=${ws}&endTime=${end}&limit=200`, 'oi:' + sym);
      calls++; await sleep(120);
      const list = j && j.result && j.result.list;
      if (!list || !list.length) break;
      for (const r of list) store[r.timestamp] = +r.openInterest;
      const earliest = Math.min(...list.map(r => +r.timestamp));
      if (earliest <= ws || list.length < 200) break;
      end = earliest - 1;
    }
  }
  fs.writeFileSync(file, JSON.stringify({ oi: store }));
  console.log('OI', sym, 'pts', Object.keys(store).length, 'calls', calls);
}

// ---------- Binance spot 1h (full history, forward paging) ----------
async function fetchSpot(sym) {
  const file = path.join(SPOT_DIR, sym + '.json');
  if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file)); if (j.complete) { console.log('SPOT', sym, 'cached'); return; } }
  let start = Date.parse('2017-08-01T00:00:00Z'), out = {}, calls = 0;
  for (;;) {
    const j = await apiJson(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}` +
      `&interval=1h&startTime=${start}&limit=1000`, 'spot:' + sym);
    calls++; await sleep(80);
    if (!j || !j.length) break;
    for (const r of j) out[r[0]] = { qv: +r[7], v: +r[5], c: +r[4] };
    const last = j[j.length - 1][0];
    if (j.length < 1000 || last + H > Date.now()) break;
    start = last + H;
  }
  const n = Object.keys(out).length;
  fs.writeFileSync(file, JSON.stringify({ complete: true, bars: out }));
  console.log('SPOT', sym, n ? `bars ${n}` : 'NOT LISTED', 'calls', calls);
}

(async () => {
  const files = fs.readdirSync(CACHE);
  for (const f of files) {
    const sym = f.split('_')[0];
    if (NON.has(sym) || (ONLY && !ONLY.has(sym))) continue;
    const bars = JSON.parse(fs.readFileSync(path.join(CACHE, f))).bars;
    if (!bars || bars.length < 500) continue;
    const ts = triggers(sym, bars);
    if (!ts.length) continue;
    if (DO_OI) await fetchOI(sym, ts);
    if (DO_SPOT) await fetchSpot(sym);
  }
  console.log('DONE');
})();
