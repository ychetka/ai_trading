#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// screener.js — universal Bybit asset screener.
// Input: a selection profile. Output: ranked watchlist + digest text.
//
// Profiles — swappable scoring rule sets:
//   reversion   — Equal Lows long traps (Mean Reversion, the strategy at the time)
//   pump_short  — post-pump short candidates (skeleton, features ready)
//
// Usage:
//   node screener.js --profile=reversion [--top=10] [--json]
//   node screener.js --profile=pump_short
//
// Designed for the n8n Code node (helpers.httpRequest) and standalone cron.

const CONC   = 5;
const BARS   = 200;
const SWING_K = 3;
const TOL_PCT = 0.3;
const LOOKBACK = 20;

// ── HTTP (standalone; replaced by helpers.httpRequest inside n8n) ────
const api = async (path) => {
  const r = await fetch('https://api.bybit.com' + path,
    { headers: { 'User-Agent': 'curl/8.0' } });
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(path + ' -> ' + j.retMsg);
  return j.result;
};

const klines = async (sym) =>
  (await api(`/v5/market/kline?category=linear&symbol=${sym}&interval=60&limit=${BARS}`))
    .list.map(r => ({ ts:+r[0], o:+r[1], h:+r[2], l:+r[3], c:+r[4], v:+r[5] }))
         .sort((a,b)=>a.ts-b.ts);

// ── Features (single block for all profiles) ─────────────────────────
const features = (bars, t, ratio) => {
  const n = bars.length, f = {};
  // swings
  const lows = [], highs = [];
  for (let i = SWING_K; i < n - SWING_K; i++) {
    let lo = true, hi = true;
    for (let k = 1; k <= SWING_K; k++) {
      if (bars[i-k].l <= bars[i].l || bars[i+k].l <= bars[i].l) lo = false;
      if (bars[i-k].h >= bars[i].h || bars[i+k].h >= bars[i].h) hi = false;
    }
    if (lo) lows.push({ i, p: bars[i].l });
    if (hi) highs.push({ i, p: bars[i].h });
  }
  // Equal Lows / Equal Highs (pairs within tolerance)
  const eqCount = (arr) => {
    let c = 0;
    for (let a = 0; a < arr.length; a++)
      for (let b = a + 1; b < arr.length; b++) {
        if (arr[b].i - arr[a].i <= SWING_K) continue;
        const avg = (arr[a].p + arr[b].p) / 2;
        if (Math.abs(arr[a].p - arr[b].p) / avg * 100 <= TOL_PCT) c++;
      }
    return c;
  };
  f.eql = eqCount(lows);
  f.eqh = eqCount(highs);
  // low sweeps (long squeezes) and high sweeps (short squeezes)
  f.sqzDn = 0; f.sqzUp = 0;
  for (let i = LOOKBACK; i < n; i++) {
    let pl = Infinity, ph = -Infinity;
    for (let k = i - LOOKBACK; k < i; k++) {
      pl = Math.min(pl, bars[k].l); ph = Math.max(ph, bars[k].h);
    }
    if (bars[i].l < pl && bars[i].c > pl) f.sqzDn++;   // took lows, closed back above
    if (bars[i].h > ph && bars[i].c < ph) f.sqzUp++;   // took highs, closed back below
  }
  // ATR(14) %
  let tr = 0;
  for (let i = n - 14; i < n; i++)
    tr += Math.max(bars[i].h - bars[i].l,
                   Math.abs(bars[i].h - bars[i-1].c),
                   Math.abs(bars[i].l - bars[i-1].c));
  f.atrPct = tr / 14 / bars[n-1].c * 100;
  // volume trend: last 24 bars vs previous 24
  const v1 = bars.slice(-24).reduce((s,b)=>s+b.v,0) / 24;
  const v0 = bars.slice(-48,-24).reduce((s,b)=>s+b.v,0) / 24;
  f.volDecay = v0 > 0 ? (v1 - v0) / v0 * 100 : 0;
  // price position within the 24h range
  const hh = Math.max(...bars.slice(-24).map(b=>b.h));
  const ll = Math.min(...bars.slice(-24).map(b=>b.l));
  f.posIn24h = hh > ll ? (bars[n-1].c - ll) / (hh - ll) : 0.5;
  // exchange features
  f.turn24   = +t.turnover24h / 1e6;
  f.chg24    = +t.price24hPcnt * 100;
  f.buyRatio = ratio != null ? ratio * 100 : NaN;
  return f;
};

// ── Scoring profiles ─────────────────────────────────────────────────
const PROFILES = {
  // Long trap: dump played out, OI/crowd cooled, frequent down-squeezes,
  // an equal-lows pool exists, ATR in the 0.5–2% working window (= v4.5 guards).
  reversion: (f) => {
    if (f.buyRatio >= 62) return { skip: true };
    if (f.atrPct < 0.3 || f.atrPct > 2.5) return { skip: true }; // dead/volatile
    if (f.chg24 > 5) return { skip: true };     // pumping — not our context
    let s = f.sqzDn * 2 + f.eql * 0.4;
    if (f.chg24 < 0) s += 4;                    // dump happened — pools are ripe
    if (f.buyRatio < 55) s += 3;                // crowd in shorts = fuel
    if (f.atrPct >= 0.5 && f.atrPct <= 2) s += 3;
    if (f.posIn24h < 0.45) s += 2;              // price near range bottom
    return { score: s };
  },
  // Short trap: pump finished (price near top, volume falling), highs swept,
  // crowd in longs (overload = downside fuel — mirror of reversion).
  pump_short: (f) => {
    if (f.buyRatio <= 45) return { skip: true };
    if (f.atrPct < 0.5 || f.atrPct > 3) return { skip: true };
    let s = f.sqzUp * 2 + f.eqh * 0.4;
    if (f.chg24 > 3) s += 4;                    // there was a pump
    if (f.volDecay < -15) s += 4;               // volume fading
    if (f.posIn24h > 0.7) s += 3;               // price still near the top
    if (f.buyRatio > 62) s += 4;                // long overload = fuel
    if (f.atrPct <= 2.5) s += 2;
    return { score: s };
  },
};

// ── Main loop ────────────────────────────────────────────────────────
async function run(profile, topN) {
  const tick = (await api('/v5/market/tickers?category=linear')).list;
  const cands = tick
    .filter(t => /^[A-Z0-9]+USDT$/.test(t.symbol))
    .filter(t => +t.turnover24h >= 10e6)   // floor = $10M runtime guard
    .sort((a,b) => +b.turnover24h - +a.turnover24h)
    .slice(0, 60);

  const rows = [];
  for (let i = 0; i < cands.length; i += CONC) {
    await Promise.all(cands.slice(i, i + CONC).map(async (t) => {
      const s = t.symbol;
      try {
        const bars = await klines(s);
        if (bars.length < 60) return;
        let ratio = null;
        try {
          const r = await api(`/v5/market/account-ratio?category=linear&period=5min&symbol=${s}`);
          ratio = +(r.list[0].buyRatio);
        } catch {}
        const f = features(bars, t, ratio);
        const { score = 0, skip } = PROFILES[profile](f);
        if (!skip) rows.push({ s, score, ...f });
      } catch (e) { /* skip the failing ticker */ }
    }));
  }
  rows.sort((a,b) => b.score - a.score);
  return rows.slice(0, topN);
}

const fmtDigest = (profile, rows) => {
  const title = profile === 'reversion'
    ? '📡 SCREENER: Equal Lows traps (long)'
    : '📡 SCREENER: post-pump (short)';
  const lines = rows.map((r, i) =>
    `${i+1}. ${r.s} — score ${r.score.toFixed(0)} | turn $${r.turn24.toFixed(0)}M | ` +
    `buyRatio ${isNaN(r.buyRatio)?'?':r.buyRatio.toFixed(0)}% | ATR ${r.atrPct.toFixed(2)}% | ` +
    `sqz↓${r.sqzDn} ↑${r.sqzUp} | EQL ${r.eql} EQH ${r.eqh} | Δ24h ${r.chg24.toFixed(1)}%`);
  return title + '\n' + (lines.join('\n') || 'no candidates') +
    '\n\nAlgorithm: Bybit REST → klines 200×1H → deterministic scoring';
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const prof = (args.find(a => a.startsWith('--profile=')) || '--profile=reversion').split('=')[1];
  const topN = +(((args.find(a => a.startsWith('--top=')) || '--top=10').split('=')[1]));
  run(prof, topN)
    .then(rows => console.log(fmtDigest(prof, rows)))
    .catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}

module.exports = { run, fmtDigest, features, PROFILES };
