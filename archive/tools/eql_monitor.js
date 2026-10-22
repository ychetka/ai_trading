#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// eql_monitor.js — event-driven Equal Lows detector (TV-alert replacement).
//
// Events (on 1H bar close):
//   equal_lows — a new pool confirmed (info)
//   eql_sweep  — bar pierced the pool low and closed above it (info)
//   eql_armed  — "trap armed": live pool < POC AND close > POC.
//                Edge: 1st armed bar, then re-fire every REARM
//                consecutive armed bars (stateless).
//
// Pool lifecycle: born (pair confirmed) → alive → swept | broken.
//
//   node eql_monitor.js --replay=SNDKUSDT [--bars=300]  — timeline
//   node eql_monitor.js                               — live universe scan

const CONC   = 5;
const BARS   = 200;
const SWING_K = 3;
const TOL_PCT = 0.15;   // delta_tolerance — EQL shelf tolerance
const MIN_TURN = 10e6;
const TOP_N    = 60;
const CLUSTER_AGE_MAX = 96;
const REARM  = 3;      // re_arm_interval_hours
// non-crypto instruments: metals, oil, indices, tokenized stocks
const NON_CRYPTO = new Set(`XAUUSDT XAGUSDT XPTUSDT XPDUSDT CLUSDT HGUSDT
SPXUSDT SPCXUSDT NDQUSDT DJIUSDT SNDKUSDT SOXLUSDT SOXSUSDT SKHYUSDT
SKHYNIXUSDT MSTRUSDT MRVLUSDT BZUSDT PLTRUSDT COINUSDT HOODUSDT AAPLUSDT
TSLAUSDT NVDAUSDT MSFTUSDT AMZNUSDT GOOGLUSDT METAUSDT AMDUSDT INTCUSDT
MUUSDT NFLXUSDT AVGOUSDT ORCLUSDT QCOMUSDT TXNUSDT SHOPUSDT UBERUSDT
PYPLUSDT SQUSDT ABNBUSDT BKNGUSDT DASHUSDT MELIUSDT SEUSDT BABAUSDT
JDUSDT PDDUSDT BIDUUSDT NIOUSDT XPEVUSDT LIUSDT TCOMUSDT FUTUUSDT
BEKEUSDT TMEUSDT BILIUSDT IQUSDT ZTOUSDT CRUSDT`.split(/\s+/));

const api = async (path) => {
  const r = await fetch('https://api.bybit.com' + path,
    { headers: { 'User-Agent': 'curl/8.0' } });
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(path + ' -> ' + j.retMsg);
  return j.result;
};

const klines = async (sym, limit) =>
  (await api(`/v5/market/kline?category=linear&symbol=${sym}&interval=60&limit=${limit}`))
    .list.map(r => ({ ts:+r[0], o:+r[1], h:+r[2], l:+r[3], c:+r[4], v:+r[5] }))
         .sort((a,b)=>a.ts-b.ts);

// POC identical to Trade Calc: hlc3 volume, 40 bins, window = all bars up to end
const pocAt = (bars, end) => {
  const w = bars.slice(0, end + 1);
  let hi = -Infinity, lo = Infinity;
  for (const x of w) { if (x.h > hi) hi = x.h; if (x.l < lo) lo = x.l; }
  const step = (hi - lo) / 40; if (!(step > 0)) return NaN;
  const vols = new Array(40).fill(0);
  for (const x of w) {
    const tp = (x.h + x.l + x.c) / 3;
    let bi = Math.floor((tp - lo) / step);
    if (bi >= 40) bi = 39; if (bi < 0) bi = 0;
    vols[bi] += x.v;
  }
  let mi = 0;
  for (let i = 1; i < 40; i++) if (vols[i] > vols[mi]) mi = i;
  return lo + (mi + 0.5) * step;
};

// OB Low as in Trade Calc: last bearish candle + impulse >=1% within <=3 bars
const obAt = (bars, end) => {
  const imp = 1;
  for (let i = end - 3; i >= 1; i--) {
    if (bars[i].c < bars[i].o) {
      let mx = bars[i+1].c;
      for (let j = 2; j <= 3 && i + j <= end; j++) mx = Math.max(mx, bars[i+j].c);
      if ((mx - bars[i].c) / bars[i].c * 100 >= imp) return bars[i].l;
    }
  }
  return NaN;
};

const detect = (bars) => {
  const n = bars.length, swingAt = [], confirmed = [], clusters = [], events = [];
  for (let i = SWING_K; i < n - SWING_K; i++) {
    let lo = true;
    for (let k = 1; k <= SWING_K; k++)
      if (bars[i-k].l <= bars[i].l || bars[i+k].l <= bars[i].l) lo = false;
    if (lo) swingAt[i] = bars[i].l;
  }
  const close = (a, b) =>
    Math.abs(a - b) / ((a + b) / 2) * 100 <= TOL_PCT;
  for (let i = 0; i < n; i++) {
    const s = i - SWING_K;
    if (swingAt[s] !== undefined) {
      const p = swingAt[s];
      for (const prev of confirmed) {
        if (!close(prev.p, p)) continue;
        let cl = clusters.find(c =>
          c.died === undefined && c.members.some(m => m.i === prev.i));
        if (cl) {
          cl.members.push({ i: s, p });
          cl.level = cl.members.reduce((x,m)=>x+m.p,0) / cl.members.length;
        } else {
          clusters.push({ level: (prev.p + p) / 2,
            members: [{ i: prev.i, p: prev.p }, { i: s, p }],
            born: i, died: undefined, fired: false });
          events.push({ bar: i, ts: bars[i].ts, type: 'equal_lows',
                        level: (prev.p + p) / 2 });
        }
        break;
      }
      confirmed.push({ i: s, p });
    }
    for (const c of clusters) {
      if (c.died !== undefined) continue;
      if (i - c.born > CLUSTER_AGE_MAX) { c.died = i; continue; }
      if (bars[i].c < c.level) { c.died = i; continue; }
      if (bars[i].l < c.level && bars[i].c > c.level && !c.fired) {
        c.fired = true; c.died = i;
        events.push({ bar: i, ts: bars[i].ts, type: 'eql_sweep',
                      level: c.level });
      }
    }
  }
  return { events, clusters };
};

const armedAt = (bars, c, i) => {
  if (i < c.born || (c.died !== undefined && i >= c.died)
      || i - c.born > CLUSTER_AGE_MAX) return false;
  const p = pocAt(bars, i);
  return Number.isFinite(p) && bars[i].c > p && c.level < p;
};

// armed events over all history + state on the last bar
const armedTimeline = (bars, clusters) => {
  const out = [];
  for (const c of clusters) {
    let run = 0;
    for (let i = c.born; i < bars.length; i++) {
      if (armedAt(bars, c, i)) {
        run++;
        const ob = obAt(bars, i), poc = pocAt(bars, i);
        const geo = Number.isFinite(ob) && Number.isFinite(poc) && ob < poc;
        if (geo && (run === 1 || (run - 1) % REARM === 0))
          out.push({ bar: i, ts: bars[i].ts, type: 'eql_armed',
                     level: c.level, run });
      } else run = 0;
    }
  }
  return out;
};

const replay = async (sym, limit) => {
  const bars = await klines(sym, limit);
  const { events, clusters } = detect(bars);
  const armed = armedTimeline(bars, clusters);
  const all = [...events, ...armed].sort((a,b)=>a.bar-b.bar);
  const f = (ts) => new Date(ts).toISOString().slice(0,16).replace('T',' ');
  console.log(`\n=== ${sym}: ${bars.length} bars, events ${all.length} ===`);
  for (const e of all)
    console.log(`${f(e.ts)}  ${e.type.padEnd(10)} lvl=${e.level.toPrecision(6)}${e.run?` run=${e.run}`:''}`);
  const alive = clusters.filter(c=>c.died===undefined);
  if (alive.length)
    console.log('Live pools:', alive.map(c=>c.level.toPrecision(6)).join(', '));
};

const liveScan = async () => {
  const tickers = (await api('/v5/market/tickers?category=linear')).list;
  const cands = tickers
    .filter(t => /^[A-Z0-9]+USDT$/.test(t.symbol) && !NON_CRYPTO.has(t.symbol))
    .filter(t => +t.turnover24h >= MIN_TURN)
    .sort((a,b) => +b.turnover24h - +a.turnover24h)
    .slice(0, TOP_N);

  const now = Date.now();
  const fired = [], armedNow = [];
  for (let i = 0; i < cands.length; i += CONC) {
    const batch = await Promise.allSettled(
      cands.slice(i, i + CONC).map(async (t) => {
        const bars = await klines(t.symbol, BARS);
        if (now - bars[bars.length-1].ts < 3600e3) bars.pop();
        const { events, clusters } = detect(bars);
        const i0 = bars.length - 1;
        let armed = null;
        for (const c of clusters) {
          let run = 0, j = i0;
          while (j >= 0 && armedAt(bars, c, j)) { run++; j--; }
          if (run > 0 && (run === 1 || (run - 1) % REARM === 0))
            if (!armed || c.level > armed.level) armed = c;
        }
        const ob = obAt(bars, i0), poc = pocAt(bars, i0);
        const geo = Number.isFinite(ob) && Number.isFinite(poc) && ob < poc;
        return { sym: t.symbol,
          ev: events.filter(e => e.bar === i0)
                    .map(e => ({...e, price: bars[i0].c})),
          armed: geo ? armed : null };
      }));
    for (const r of batch) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      fired.push(...r.value.ev.map(e => ({symbol: r.value.sym, ...e})));
      if (r.value.armed)
        armedNow.push({ symbol: r.value.sym, level: r.value.armed.level });
    }
  }
  for (const e of fired)
    console.log(`ℹ️ ${e.symbol} ${e.type} lvl=${e.level.toPrecision(6)}`);
  for (const a of armedNow)
    console.log(`🎯 ${a.symbol} eql_armed lvl=${a.level.toPrecision(6)}`);
  if (!fired.length && !armedNow.length)
    console.log('No fresh events.');
};

const arg = (k) => (process.argv.find(a=>a.startsWith(`--${k}=`))||'').split('=')[1];
(async () => {
  const rp = arg('replay');
  if (rp) return replay(rp, +(arg('bars')||BARS));
  await liveScan();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
