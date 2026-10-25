#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// whale_corr.js — whale-cluster forward-return analyzer (issue #4).
// Reads whale_events.jsonl produced by "Whales Monitor (svc)", takes the
// FIRST cluster formation per coin:direction, then measures Bybit 1h
// forward returns at +1/4/8/24h, raw and BTC-adjusted (market-drift
// control). Klines are fetched on demand into data/whale_klines/.
//
//   node tools/whale_corr.js [--events=/path/whale_events.jsonl]
//                            [--events=open|cluster]

const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const EV = arg('events') || path.join(ROOT, 'docker-data',
  'volumes/crypto-analyst_n8n_storage/_data/.n8n/whale_events.jsonl');
const TYPE = arg('evtype') || 'cluster';
const KDIR = path.join(ROOT, 'data', 'whale_klines');
fs.mkdirSync(KDIR, { recursive: true });
const H = 3600e3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async p => {
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch('https://api.bybit.com' + p, { headers: { 'User-Agent': 'curl/8.0' } });
      const j = await r.json();
      if (j.retCode === 0) return j.result;
      await sleep(1000 * (t + 1));
    } catch (e) { await sleep(1000 * (t + 1)); }
  }
  return null;
};

async function klines(sym) {
  const f = path.join(KDIR, sym + '.json');
  let bars = [];
  if (fs.existsSync(f)) bars = JSON.parse(fs.readFileSync(f));
  const from = bars.length ? bars[bars.length - 1].ts + H : Date.now() - 30 * 24 * H;
  let start = from;
  for (;;) {
    const res = await api(`/v5/market/kline?category=linear&symbol=${sym}&interval=60&start=${start}&limit=1000`);
    const list = (res && res.list || []).map(r => ({ ts: +r[0], c: +r[4] }));
    if (!list.length) break;
    bars = bars.concat(list);
    const last = list[list.length - 1].ts;
    if (list.length < 1000 || last + H > Date.now()) break;
    start = last + H;
    await sleep(120);
  }
  const seen = new Set();
  bars = bars.filter(b => !seen.has(b.ts) && seen.add(b.ts)).sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(f, JSON.stringify(bars));
  return bars;
}

const at = (bars, ts) => {
  let lo = 0, hi = bars.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].ts <= ts) { best = bars[m]; lo = m + 1; } else hi = m - 1; }
  return best;
};

(async () => {
  const rows = fs.readFileSync(EV, 'utf8').trim().split('\n').map(JSON.parse);
  const evts = rows.filter(r => r.type === TYPE);
  // first formation per coin:dir
  const first = new Map();
  for (const r of evts) {
    const k = r.coin + ':' + r.dir;
    if (!first.has(k) || r.ts < first.get(k).ts) first.set(k, r);
  }
  const sigs = [...first.values()];
  console.log(`events=${rows.length} ${TYPE}s=${evts.length} unique coin:dir=${sigs.length}`);

  const btc = await klines('BTCUSDT');
  const out = [];
  for (const r of sigs) {
    const bars = await klines(r.coin + 'USDT');
    await sleep(80);
    if (!bars.length) { out.push({ ...r, skip: 'no klines' }); continue; }
    const p0 = at(bars, r.ts);
    if (!p0) { out.push({ ...r, skip: 'no base' }); continue; }
    const b0 = at(btc, r.ts);
    const rec = { coin: r.coin, dir: r.dir, n: r.n, usd: r.usd, ts: r.ts };
    for (const h of [1, 4, 8, 24]) {
      const px = at(bars, r.ts + h * H), bx = b0 && at(btc, r.ts + h * H);
      rec['r' + h] = px ? (px.c / p0.c - 1) * 100 : null;
      rec['a' + h] = px && bx ? (px.c / p0.c - 1 - (bx.c / b0.c - 1)) * 100 : null;
    }
    out.push(rec);
  }
  const ok = out.filter(r => !r.skip && r.r24 !== null);
  const skipped = out.filter(r => r.skip);
  console.log(`priced n=${ok.length}  skipped(no Bybit perp/data)=${skipped.length} [${[...new Set(skipped.map(s => s.coin))].join(',')}]`);

  const stat = (name, arr, key) => {
    const v = arr.map(r => r[key]).filter(x => x !== null);
    if (!v.length) return;
    const hit = v.filter(x => x > 0).length;
    console.log(`${name.padEnd(24)} n=${String(v.length).padStart(3)} avg=${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2).padStart(6)}%  up=${(100 * hit / v.length).toFixed(0)}%`);
  };
  for (const d of ['L', 'S']) {
    const sub = ok.filter(r => r.dir === d);
    for (const h of [1, 4, 8, 24]) {
      stat(`${d}  raw +${h}h`, sub, 'r' + h);
      stat(`${d}  btc-adj +${h}h`, sub, 'a' + h);
    }
  }
  // size split
  const big = ok.filter(r => (r.usd || 0) >= 1e6), small = ok.filter(r => (r.usd || 0) < 1e6);
  for (const h of [4, 8]) {
    stat(`usd>=1M raw +${h}h`, big, 'r' + h);
    stat(`usd<1M  raw +${h}h`, small, 'r' + h);
  }
  fs.writeFileSync(path.join(ROOT, 'data', 'whale_corr_out.json'), JSON.stringify(out, null, 1));
  console.log('detail -> data/whale_corr_out.json');
})();
