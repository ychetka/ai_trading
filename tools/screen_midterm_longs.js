#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// screen_midterm_longs.js — screener for mid-term long candidates "in a zone of interest".
// Source: Bybit REST only (free).
//   1) liquidity: turnover24h >= 50M, tokenized stocks/metals excluded
//   2) zone of interest: price in the lower part of the 90d range, above a
//      dense swing-low cluster (3+ touches, held — no close below the cluster)
//   3) pullback stage: ret30 < 0, but the last 7d stabilize (ret7 >= -3%)
//   4) not long-overloaded: funding <= 0.01%, buyRatio (top traders) <= 0.55
//
//   node tools/screen_midterm_longs.js [--top=20] [--json]

const TOP = +(process.argv.find(a => a.startsWith('--top=')) || '--top=20').slice(6);
const JSON_OUT = process.argv.includes('--json');
const MIN_TURN = 10e6, K = 3, TOL = 0.006, LBARS = 500; // 4H × 500 ≈ 83 days

const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async p => {
  const j = await (await fetch('https://api.bybit.com' + p,
    { headers: { 'User-Agent': 'curl/8.0' } })).json();
  if (j.retCode !== 0) throw new Error(p + ' -> ' + j.retMsg);
  return j.result;
};

// swing-low clustering: zones with n touches
function supClusters(bars) {
  const lows = [];
  for (let i = K; i < bars.length - K; i++) {
    let ok = true;
    for (let j = i - K; j <= i + K; j++) if (j !== i && bars[j].l < bars[i].l) { ok = false; break; }
    if (ok) lows.push({ px: bars[i].l, ts: bars[i].ts });
  }
  lows.sort((a, b) => a.px - b.px);
  const out = [];
  for (const v of lows) {
    const l = out[out.length - 1];
    if (l && v.px - l.max < l.max * TOL) { l.n++; l.max = v.px; l.min = Math.min(l.min, v.px); l.lastTs = v.ts; }
    else out.push({ min: v.px, max: v.px, n: 1, lastTs: v.ts });
  }
  return out;
}

(async () => {
  // crypto = empty symbolType; stock/ETF/commodity excluded via metadata.
  // XAUT/PAXG are gold tokens (ERC-20, flagged crypto at Bybit) — excluded manually;
  // *PERP are duplicate contracts of the same underlying.
  const EXCLUDE = new Set(['XAUTUSDT', 'PAXGUSDT']);
  const inst = await api('/v5/market/instruments-info?category=linear&limit=1000');
  const cryptoSet = new Set(inst.list
    .filter(i => i.status === 'Trading' && (i.symbolType || '') === ''
               && !EXCLUDE.has(i.symbol) && !i.symbol.endsWith('PERP'))
    .map(i => i.symbol));

  const tk = (await api('/v5/market/tickers?category=linear')).list
    .filter(t => cryptoSet.has(t.symbol) && +t.turnover24h >= MIN_TURN);
  console.error(`liquidity candidates: ${tk.length}`);

  const rows = [];
  for (const t of tk) {
    const s = t.symbol;
    try {
      const bars = (await api(`/v5/market/kline?category=linear&symbol=${s}&interval=240&limit=${LBARS}`))
        .list.map(r => ({ ts: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
             .sort((a, b) => a.ts - b.ts);
      if (bars.length < 400) { await sleep(120); continue; }
      const c = bars[bars.length - 2].c;               // last closed 4H
      const hi90 = Math.max(...bars.slice(-540).map(b => b.h));
      const lo90 = Math.min(...bars.slice(-540).map(b => b.l));
      const range = (c - lo90) / (hi90 - lo90);
      const ret30 = (c - bars[bars.length - 2 - 180].c) / bars[bars.length - 2 - 180].c;
      const ret7  = (c - bars[bars.length - 2 - 42].c) / bars[bars.length - 2 - 42].c;
      const ret3  = (c - bars[bars.length - 2 - 18].c) / bars[bars.length - 2 - 18].c;

      // nearest cluster below price, n>=3, no close under it in the window
      const cls = supClusters(bars.slice(-540))
        .filter(x => x.max < c && x.n >= 3)
        .sort((a, b) => b.max - a.max);
      let sup = null, held = false;
      for (const cl of cls) {
        // support 'holds' = no close below the cluster bottom AFTER its last touch
        const broke = bars.some(b => b.ts > cl.lastTs && b.c < cl.min * 0.995);
        if (!broke) { sup = cl; held = true; break; }
        if (!sup) sup = cl;                            // broken — still support, but weaker
      }
      const distSup = sup ? (c - sup.max) / c : null;

      rows.push({ s, c, turn: +t.turnover24h, fund: +t.fundingRate,
        range, ret30, ret7, ret3,
        supN: sup ? sup.n : 0, supMin: sup ? sup.min : null, supMax: sup ? sup.max : null,
        distSup, held });
    } catch (e) { console.error(`${s}: ${e.message}`); }
    await sleep(120);
  }

  // mandatory minimum: a support with 2+ touches within ≤15% below
  let cands = rows.filter(r => r.supN >= 2 && r.distSup != null && r.distSup <= 0.15);

  // account-ratio (long overload) only for survivors — saves requests
  for (const r of cands) {
    try {
      const ar = (await api(`/v5/market/account-ratio?category=linear&symbol=${r.s}&period=1h&limit=1`)).list;
      r.buyRatio = ar.length ? +ar[0].buyRatio : null;
    } catch { r.buyRatio = null; }
    await sleep(120);
  }

  // score: support strength + proximity + pullback depth − long overload
  for (const r of cands)
    r.score = r.supN * 0.4 + (0.15 - r.distSup) * 100 * 0.25
            + Math.min(-r.ret30, 0.3) * 30 + (0.0001 - Math.max(r.fund, -0.001)) * 500
            + (r.held ? 1.5 : 0) + (r.ret7 >= -0.03 ? 0.5 : 0)
            + (r.buyRatio != null ? (0.72 - r.buyRatio) * 20 : 0)
            - (r.range > 0.65 ? 2 : 0);                 // penalty for upper range
  cands.sort((a, b) => b.score - a.score);

  if (JSON_OUT) { console.log(JSON.stringify(cands.slice(0, TOP), null, 1)); return; }
  console.log(`\n=== top-${TOP} mid-term long candidates ===`);
  console.log('flags: !sup=support was broken, R=upper range, F=longs overpaying, L=long overload');
  console.log('sym     price     support(xtch)   dist↓  range% ret30%  ret7% fund%  buyR  score');
  for (const r of cands.slice(0, TOP)) {
    const flags = (r.held ? ' ' : '!') + (r.range > 0.65 ? 'R' : ' ')
                + (r.fund > 0.0001 ? 'F' : ' ') + (r.buyRatio != null && r.buyRatio > 0.72 ? 'L' : ' ');
    console.log(
      r.s.replace('USDT', '').padEnd(8) +
      r.c.toPrecision(5).padEnd(10) +
      `${r.supMin.toFixed(4)}-${r.supMax.toFixed(4)}`.padEnd(18) +
      ('x' + r.supN).padEnd(5) +
      (r.distSup * 100).toFixed(1).padStart(5) + '% ' +
      (r.range * 100).toFixed(0).padStart(5) + '% ' +
      (r.ret30 * 100).toFixed(1).padStart(6) + ' ' +
      (r.ret7 * 100).toFixed(1).padStart(6) + ' ' +
      (r.fund * 100).toFixed(3).padStart(6) + ' ' +
      (r.buyRatio == null ? '—' : r.buyRatio.toFixed(2)).padStart(5) + ' ' +
      r.score.toFixed(1).padStart(6) + ' ' + flags);
  }
  console.log(`\ntotal passed filters: ${cands.length} of ${rows.length}`);
  console.error('(!) after xN = support was broken in the window — weaker than the rest');
})();
