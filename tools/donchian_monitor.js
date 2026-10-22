#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// donchian_monitor.js — info-mode Donchian breakout scanner (v4.5.1).
//
// Configuration (validated by backtest_portfolio.js, rolling top-10):
//   N=168, exit=84, ATR×2.5, squeeze bwP≤0.2, vol>1.5×SMA20, long-only,
//   rolling top-10 by 30d turnover (re-ranked on the 1st of the month),
//   8 virtual slots, entry at next bar open + slip+fee.
//
// No orders. Virtual positions live in the state file; exits —
// trail min(low,84)/stop/960-bar expiry, evaluated on closed bars.
//
//   node donchian_monitor.js                 — one pass, JSON events
//   node donchian_monitor.js --state=/path/donchian_state.json
//   node donchian_monitor.js --verbose       — human-readable output
//
// stdout events: {type:'entry'|'exit', ...} — n8n renders to Telegram.

const fs = require('fs'), path = require('path');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const VERBOSE = process.argv.includes('--verbose');
const STATE = arg('state') || path.join(__dirname, '..', 'data', 'donchian_state.json');

// ==== strategy parameters (from backtest, do NOT change without revalidation) ====
const N = 168, EXITN = 84, ATRK = 2.5, SQ = 0.2, VOLK = 1.5, VSMA = 20;
const TOPK = 10, TVWIN = 720, SLOTS = 8, EXPIRY = 960;
const FEE = 0.00055, SLIP_MIN = 0.001, SLIPK = 0.03;
const MIN_TURN24H = 50e6;                 // liquidity filter on re-rank
const KLINES = 600;                        // N + 300-bar bwP window + margin
const NON_CRYPTO = new Set(`XAUUSDT XAGUSDT XPTUSDT XPDUSDT CLUSDT HGUSDT
SPXUSDT SPCXUSDT NDQUSDT DJIUSDT SNDKUSDT SOXLUSDT SOXSUSDT SKHYUSDT
SKHYNIXUSDT MSTRUSDT MRVLUSDT BZUSDT PLTRUSDT COINUSDT HOODUSDT AAPLUSDT
TSLAUSDT NVDAUSDT MSFTUSDT AMZNUSDT GOOGLUSDT METAUSDT AMDUSDT INTCUSDT
MUUSDT NFLXUSDT AVGOUSDT ORCLUSDT QCOMUSDT TXNUSDT SHOPUSDT UBERUSDT
PYPLUSDT SQUSDT ABNBUSDT BKNGUSDT DASHUSDT MELIUSDT SEUSDT BABAUSDT
JDUSDT PDDUSDT BIDUUSDT NIOUSDT XPEVUSDT LIUSDT TCOMUSDT FUTUUSDT
BEKEUSDT TMEUSDT BILIUSDT IQUSDT ZTOUSDT CRUSDT`.split(/\s+/));

const api = async (p) => {
  const r = await fetch('https://api.bybit.com' + p,
    { headers: { 'User-Agent': 'curl/8.0' } });
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(p + ' -> ' + j.retMsg);
  return j.result;
};
const klines = async (sym, limit) =>
  (await api(`/v5/market/kline?category=linear&symbol=${sym}&interval=60&limit=${limit}`))
    .list.map(r => ({ ts:+r[0], o:+r[1], h:+r[2], l:+r[3], c:+r[4], v:+r[5] }))
         .sort((a,b) => a.ts - b.ts);
const tickers = async () =>
  (await api('/v5/market/tickers?category=linear')).list;

// precompute as in backtest_portfolio.js: atr14, vSma20, up/dn(N), bwP(300), tv(720)
function pre(bars) {
  const n = bars.length;
  const atr = new Array(n).fill(NaN), vS = new Array(n).fill(NaN),
        up = new Array(n).fill(NaN), dn = new Array(n).fill(NaN),
        bwP = new Array(n).fill(NaN), tv = new Array(n).fill(NaN);
  let tS = 0, vA = 0, tvA = 0; const trs = [], win = [];
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i-1].c), Math.abs(b.l - bars[i-1].c)) : b.h - b.l;
    trs.push(tr); tS += tr; vA += b.v; tvA += b.v * b.c;
    if (i >= 14) tS -= trs[i-14];
    if (i >= VSMA) vA -= bars[i-VSMA].v;
    if (i >= TVWIN) tvA -= bars[i-TVWIN].v * bars[i-TVWIN].c;
    if (i >= 14) atr[i] = tS / 14;
    if (i >= VSMA) vS[i] = vA / VSMA;
    if (i >= TVWIN) tv[i] = tvA / TVWIN;
    if (i >= N) {
      let mx = -Infinity, mn = Infinity, cm = 0;
      for (let j = i - N; j < i; j++) {
        if (bars[j].h > mx) mx = bars[j].h;
        if (bars[j].l < mn) mn = bars[j].l;
        cm += bars[j].c;
      }
      up[i] = mx; dn[i] = mn;
      const bw = (mx - mn) / (cm / N);
      win.push(bw); if (win.length > 300) win.shift();
      bwP[i] = win.filter(x => x <= bw).length / win.length;
    }
  }
  return { atr, vS, up, dn, bwP, tv };
}
const slipOf = (atr, close) => Math.max(SLIP_MIN, SLIPK * atr / close);

// ==== order-book snapshot at entry (forward log for the wall hypothesis) ====
// Bybit perp (execution venue) + Binance/Bitget spot (volume leaders).
// Venue without a listing/error → null. Book format → {mid,b1,a1,b3,a3,imb,topB,topA}.
const sumBook = (bids, asks) => {
  const b = bids.map(r => [+r[0], +r[1]]), a = asks.map(r => [+r[0], +r[1]]);
  if (!b.length || !a.length) return null;
  const mid = (b[0][0] + a[0][0]) / 2;
  const depth = (rows, pct) =>
    Math.round(rows.filter(x => Math.abs(x[0] - mid) / mid * 100 <= pct)
                   .reduce((s, x) => s + x[0] * x[1], 0));
  const walls = rows => rows
    .filter(x => Math.abs(x[0] - mid) / mid * 100 <= 5)
    .sort((x, y) => y[0] * y[1] - x[0] * x[1]).slice(0, 3)
    .map(x => [+((x[0] - mid) / mid * 100).toFixed(2), Math.round(x[0] * x[1])]);
  const b1 = depth(b, 1), a1 = depth(a, 1);
  return { mid: +mid.toPrecision(7), b1, a1, b3: depth(b, 3), a3: depth(a, 3),
           imb: +(b1 / Math.max(a1, 1)).toFixed(2), topB: walls(b), topA: walls(a) };
};
// primary: Books Aggregator microservice (n8n /webhook/book) — all venues
const svcBook = async (sym) => {
  try { const j = await fetch(`http://localhost:5678/webhook/book?symbol=${sym}`)
          .then(r => r.json());
        return j && j.agg ? j : null; }
  catch { return null; }
};
// fallback: direct 3-venue snapshot
const snapBook = async (sym) => {
  const out = {};
  try { const r = await api(`/v5/market/orderbook?category=linear&symbol=${sym}&limit=200`);
        out.bybit = sumBook(r.b, r.a); }
  catch { out.bybit = null; }
  try { const j = await fetch(`https://data-api.binance.vision/api/v3/depth?symbol=${sym}&limit=100`).then(r => r.json());
        out.binance = sumBook(j.bids, j.asks); }
  catch { out.binance = null; }
  try { const j = await fetch(`https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${sym}&type=step0&limit=100`).then(r => r.json());
        out.bitget = j.code === '00000' ? sumBook(j.data.bids, j.data.asks) : null; }
  catch { out.bitget = null; }
  return out;
};

// ==== state ====
const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { month: null, universe: [], positions: [], trades: [], stats: { n: 0, wins: 0, sumR: 0 } }; }
};
const saveState = s => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
};

(async () => {
  const st = loadState();
  const events = [];
  const now = Date.now();
  // pipeline stage diagnostics (info output)
  const dbg = { eval: 0, brk: 0, volP: 0, cand: 0, entries: 0, exits: 0,
                posChk: 0, kErr: 0, skipDup: 0, skipStale: 0, skipSlot: 0,
                nearSym: null, nearR: 0 };
  const month = new Date(now).toISOString().slice(0, 7);

  // daily turnover24h sample → 30d average = proxy of the backtest TVWIN
  const day = new Date(now).toISOString().slice(0, 10);
  let tk = null;
  if (st.tvDay !== day || st.month !== month) tk = await tickers();
  st.tv = st.tv || {};
  if (st.tvDay !== day) {
    st.tvDay = day;
    for (const t of tk) {
      if (+t.turnover24h > 0) {
        (st.tv[t.symbol] = st.tv[t.symbol] || []).push(+t.turnover24h);
        if (st.tv[t.symbol].length > 30) st.tv[t.symbol].shift();
      }
    }
  }

  // --- monthly re-rank of top-10 by 30d average turnover ---
  if (st.month !== month) {
    st.universe = tk
      .filter(t => t.symbol.endsWith('USDT') && !NON_CRYPTO.has(t.symbol)
                  && +t.turnover24h >= MIN_TURN24H)
      .map(t => {
        const a = st.tv[t.symbol] || [];
        return [t.symbol, a.length >= 7 ? a.reduce((x, y) => x + y, 0) / a.length
                                        : +t.turnover24h];
      })
      .sort((a, b) => b[1] - a[1]).slice(0, TOPK).map(x => x[0]);
    st.month = month;
    events.push({ type: 'universe', month, list: st.universe });
  }
  if (!st.universe.length) { console.log('[]'); return; }

  // --- load klines: universe + symbols with open virtual positions ---
  const need = new Set(st.universe);
  for (const p of st.positions) need.add(p.sym);
  need.add('BTCUSDT');
  const data = {};
  for (const s of need) {
    try { data[s] = await klines(s, KLINES); }
    catch (e) { dbg.kErr++; if (VERBOSE) console.error(`klines ${s}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 120));  // be gentle with the API
  }

  // --- 1) virtual position exits (on the last CLOSED bar) ---
  for (let k = st.positions.length - 1; k >= 0; k--) {
    dbg.posChk++;
    const pos = st.positions[k], bars = data[pos.sym];
    if (!bars || bars.length < 2) continue;
    const i = bars.length - 2;                    // last closed bar
    const b = bars[i];
    if (b.ts <= pos.entryBarTs) continue;          // wait for the first closed bar after entry
    let mn = Infinity;
    for (let j = Math.max(0, i - EXITN); j < i; j++) if (bars[j].l < mn) mn = bars[j].l;
    const eff = Math.max(pos.stop0, mn);
    const hit = b.l <= eff;
    const expired = (b.ts - pos.entryBarTs) / 3600e3 > EXPIRY;
    if (!hit && !expired) { pos.barsHeld = (b.ts - pos.entryBarTs) / 3600e3; continue; }
    const raw = hit ? eff : b.c;
    const p = pre(bars);
    const slip = slipOf(p.atr[i], b.c);
    const exit = raw * (1 - slip - FEE);
    const R = (exit - pos.entry) / pos.risk;
    const reason = hit ? 'TRAIL_HIT' : 'EXPIRY';
    st.stats.n++; st.stats.sumR += R; if (R > 0) st.stats.wins++;
    st.trades.push({ sym: pos.sym, entry: pos.entry, exit, R: +R.toFixed(3),
                     entryTs: pos.entryTs, exitTs: now, bars: pos.barsHeld | 0,
                     reason, slipIn: pos.slipIn, slipOut: +slip.toFixed(5),
                     book: pos.book || null });
    if (st.trades.length > 500) st.trades.shift();
    events.push({ type: 'exit', sym: pos.sym, R: +R.toFixed(2), exit, hit,
                  reason, heldH: pos.barsHeld | 0, stats: st.stats });
    dbg.exits++;
    st.positions.splice(k, 1);
  }

  // --- 2) new signals on the last closed bar ---
  const btc = data['BTCUSDT'];
  const cand = [];
  for (const s of st.universe) {
    const bars = data[s];
    if (!bars || bars.length < N + 302) continue;
    const i = bars.length - 2, b = bars[i], p = pre(bars);
    if (!Number.isFinite(p.atr[i]) || !Number.isFinite(p.up[i])) continue;
    dbg.eval++;
    const ratio = b.c / p.up[i];
    if (ratio > dbg.nearR) { dbg.nearR = ratio; dbg.nearSym = s; }
    if (!(b.c > p.up[i])) continue;                          // long-only
    dbg.brk++;
    const volR = b.v / p.vS[i];
    if (!(volR > VOLK)) continue;
    dbg.volP++;
    if (!(p.bwP[i] <= SQ)) continue;
    dbg.cand++;
    // 24h RS vs BTC (score tie-break, same as in the backtest)
    let rs = 1;
    if (btc && btc.length >= 26 && i >= 24) {
      const dAlt = (b.c - bars[i-24].c) / bars[i-24].c;
      const bi = btc.length - 2;
      const dBtc = (btc[bi].c - btc[bi-24].c) / btc[bi-24].c;
      if (dBtc !== 0) rs = dAlt / dBtc;
    }
    const score = volR / Math.max(p.bwP[i], 0.05) * Math.abs(rs);
    cand.push({ s, i, score, atr: p.atr[i], sigTs: b.ts,
                entryBar: bars[bars.length - 1] });          // forming bar = fill model
  }
  cand.sort((a, b) => b.score - a.score);
  for (const c of cand) {
    if (st.positions.length >= SLOTS) { dbg.skipSlot++; break; }
    if (st.positions.some(x => x.sym === c.s)) continue;
    if (st.lastSig && st.lastSig[c.s] === c.sigTs) { dbg.skipDup++; continue; }
    if (now - c.sigTs > 90 * 60e3) { dbg.skipStale++; continue; }
    const slip = slipOf(c.atr, c.entryBar.o);
    const entry = c.entryBar.o * (1 + slip + FEE);           // fill at next bar open
    const stop0 = entry - ATRK * c.atr;
    const risk = entry - stop0;
    if (!(risk > 0)) continue;
    const book = (await svcBook(c.s)) || await snapBook(c.s);
    st.positions.push({ sym: c.s, entry, stop0, risk, slipIn: +slip.toFixed(5),
                        entryTs: now, entryBarTs: c.sigTs, barsHeld: 0, book });
    (st.lastSig = st.lastSig || {})[c.s] = c.sigTs;
    events.push({ type: 'entry', sym: c.s, entry: +entry.toPrecision(6),
                  stop: +stop0.toPrecision(6), riskPct: +(risk / entry * 100).toFixed(2),
                  score: +c.score.toFixed(2), open: st.positions.length, book });
    dbg.entries++;
  }

  // a breakout happened but gates/slots filtered it out — visible sign of work
  if (dbg.brk > 0 && dbg.entries === 0)
    events.push({ type: 'watch', brk: dbg.brk, volP: dbg.volP, cand: dbg.cand,
                  near: dbg.nearSym, nearR: +dbg.nearR.toFixed(3) });

  // --- 3) daily digest (the 00:0x UTC run, once a day) ---
  if (new Date(now).getUTCHours() === 0 && st.digestDay !== day) {
    st.digestDay = day;
    const t24 = st.trades.filter(t => now - t.exitTs < 86400e3);
    const conc = {};
    for (const t of st.trades.filter(t => now - t.exitTs < 30 * 86400e3))
      conc[t.sym] = (conc[t.sym] || 0) + 1;
    const reasons = {};
    let hb = 0, sl = 0, slN = 0;
    for (const t of st.trades) {
      reasons[t.reason || '?'] = (reasons[t.reason || '?'] || 0) + 1;
      hb += t.bars || 0;
      if (t.slipIn != null) { sl += t.slipIn; slN++; }
    }
    events.push({ type: 'digest', day,
      dN: t24.length, dR: +t24.reduce((s, t) => s + t.R, 0).toFixed(2),
      n: st.stats.n, sumR: +st.stats.sumR.toFixed(1), wins: st.stats.wins,
      open: st.positions.map(p => p.sym.replace('USDT', '')),
      conc: Object.entries(conc).sort((a, b) => b[1] - a[1])
        .map(([s, n]) => s.replace('USDT', '') + '×' + n).join(' ') || '—',
      avgHoldH: st.trades.length ? Math.round(hb / st.trades.length) : 0,
      avgSlipPct: slN ? +(sl / slN * 100).toFixed(3) : 0,
      reasons,
      pipeDay: st.dbg ? st.dbg.day : null, pipe: st.dbg || null });
  }

  // accumulate pipeline stats for the digest (after digest it sees yesterday)
  if (!st.dbg || st.dbg.day !== day) {
    st.dbg = { day, scans: 1, eval: dbg.eval, brk: dbg.brk, volP: dbg.volP,
               cand: dbg.cand, entries: dbg.entries, exits: dbg.exits,
               kErr: dbg.kErr, nearSym: dbg.nearSym, nearR: dbg.nearR };
  } else {
    const d = st.dbg;
    d.scans++; d.eval += dbg.eval; d.brk += dbg.brk; d.volP += dbg.volP;
    d.cand += dbg.cand; d.entries += dbg.entries; d.exits += dbg.exits;
    d.kErr += dbg.kErr;
    if (dbg.nearR > d.nearR) { d.nearR = dbg.nearR; d.nearSym = dbg.nearSym; }
  }

  saveState(st);
  if (VERBOSE) {
    for (const e of events) console.log(JSON.stringify(e));
    console.log(`scan: eval ${dbg.eval} | brk ${dbg.brk} | volP ${dbg.volP} | cand ${dbg.cand}` +
      ` | entries ${dbg.entries} | exits ${dbg.exits} | posChk ${dbg.posChk}` +
      ` | kErr ${dbg.kErr} | near ${dbg.nearSym || '-'} ${dbg.nearR.toFixed(3)}`);
    console.log(`universe[${st.universe.length}] positions=${st.positions.length} trades=${st.stats.n} sumR=${st.stats.sumR.toFixed(1)}`);
  } else {
    console.log(JSON.stringify(events));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
