#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// voltrack.js - optimal volatility entry scanner (issue #47).
// Hybrid model over our own telemetry:
//   A) order-book wall event model: WALL_APPEAR/PULL/BREAK/HOLD/RELOAD,
//      VOLUME_DROP, STACK_FLIP - derived from consecutive books snapshots
//   B) reconstructed liquidation map: whale open/grow entries x leverage
//      tiers -> long-liq pools below price, short-liq pools above
//   C) scenario state machine: base_down / squeeze / cascade / range /
//      base_up + virtual entry signals (info-only, never orders).
//
// Telemetry/research-grade output: delayed JSONL + summaries, no signals
// intended for real-time use (publication rules, ROADMAP.md).
//
//   node tools/voltrack.js --once --symbol=BTCUSDT --window=7200
//   node tools/voltrack.js --watch --interval=180 --out=.../voltrack_state.jsonl
//
// Exit: --once prints {ts,sym,mid,state,dir,pools,stats,signals,events[]}.

const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const v = (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1]; return v === undefined || v === '' ? d : v; };
const DATA = arg('data', path.join(ROOT, 'docker-data', 'volumes/crypto-analyst_n8n_storage/_data'));
const HIST = arg('history', path.join(DATA, 'books_history.jsonl'));
const WHEV = arg('whaleevents', path.join(DATA, 'whale_events.jsonl'));
const WANT = (arg('symbol', '') || '').toUpperCase() || null;
const WINDOW = +arg('window', 7200) * 1000;          // event window, sec
const MIN_USD = +arg('min-usd', 2e6);                 // event-model wall floor
const MIN_DIST = +arg('min-dist', 0.3);                // %: top-of-book noise floor (wall_scan.js convention)
const BAND = +arg('band', 0.6);                       // %-points: same wall identity
const TOUCH = +arg('touch', 0.35);                    // %: price near wall = touched
const DROP_PCT = +arg('drop-pct', 35);                // VOLUME_DROP: side walls shrink
const FLIP_LO = +arg('flip-lo', 0.7), FLIP_HI = +arg('flip-hi', 1.4);
const RELOAD_H = +arg('reload-h', 6);                 // WALL_RELOAD lookback, hours
const BUCKET = +arg('liq-bucket', 0.5);               // liq map bucket, % of price
const MAG_ZONE = +arg('magnet-zone', 0.8);            // %: price inside pool zone
const LID_PCT = +arg('lid-pct', 1.0);                 // %: ask lid max distance
const LEVERAGE = [[10, 0.5], [25, 0.35], [50, 0.15]]; // tier -> weight
const SYM_COIN = s => s.replace(/USDT$/, '');

const loadJsonl = f => {
  const out = [];
  try {
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch {}
    }
  } catch {}
  return out;
};

// ---------- A) wall event model ------------------------------------------
// Chain walls across snapshots by side + absolute price; classify each
// removal: break (price crossed level), hold (price touched band then wall
// gone), pull (vanished untouched). Plus appear/reload/volume/flip events.
function deriveEvents(recs, o = {}) {
  const minUsd = o.minUsd ?? MIN_USD, band = o.band ?? BAND, touch = o.touch ?? TOUCH;
  const minDist = o.minDist ?? MIN_DIST;
  const dropPct = o.dropPct ?? DROP_PCT, reloadMs = (o.reloadH ?? RELOAD_H) * 3600e3;
  const flo = o.flipLo ?? FLIP_LO, fhi = o.flipHi ?? FLIP_HI;
  const ev = [];
  const absPx = (mid, d) => mid * (1 + d / 100);
  const same = (a, b) => Math.abs(a.px - b.px) / a.px * 100 <= band;
  const recentDead = [];  // {side,px,ts,usd} for WALL_RELOAD
  let prev = null;
  for (const r of recs) {
    const a = r.agg || {}, mid = a.mid;
    if (!mid) { prev = null; continue; }
    const walls = [...(a.wallsA || []).map(w => ({ side: 'A', px: absPx(mid, w[0]), usd: w[1], d: w[0] })),
                   ...(a.wallsB || []).map(w => ({ side: 'B', px: absPx(mid, w[0]), usd: w[1], d: w[0] }))]
      .filter(w => w.usd >= minUsd && Math.abs(w.d) >= minDist);
    if (prev) {
      const t1 = r.ts, m0 = prev.mid, m1 = mid;
      const lo = Math.min(m0, m1), hi = Math.max(m0, m1);
      // removals
      for (const pw of prev.walls) {
        if (walls.some(w => w.side === pw.side && same(pw, w))) continue;
        const crossed = pw.side === 'B' ? lo <= pw.px : hi >= pw.px;
        const touched = Math.abs(m1 - pw.px) / pw.px * 100 <= touch || Math.abs(m0 - pw.px) / pw.px * 100 <= touch;
        const outcome = crossed ? 'WALL_BREAK' : touched ? 'WALL_HOLD' : 'WALL_PULL';
        ev.push({ ts: t1, type: outcome, side: pw.side, px: +pw.px.toPrecision(8), usd: +pw.usd.toFixed(0) });
        recentDead.push({ side: pw.side, px: pw.px, usd: pw.usd, ts: t1 });
      }
      // appearances (unmatched current walls)
      for (const w of walls) {
        if (prev.walls.some(pw => pw.side === w.side && same(pw, w))) continue;
        ev.push({ ts: t1, type: 'WALL_APPEAR', side: w.side, px: +w.px.toPrecision(8), usd: +w.usd.toFixed(0) });
      }
      // reload: new wall near a recently removed one, same side;
      // each dead wall yields at most one reload event
      for (const w of walls) {
        const d = recentDead.find(d => !d.used && d.side === w.side && t1 - d.ts <= reloadMs && same(d, w) && w.usd > d.usd * 0.5);
        if (d) {
          d.used = true;
          ev.push({ ts: t1, type: 'WALL_RELOAD', side: w.side, px: +w.px.toPrecision(8), usd: +w.usd.toFixed(0) });
        }
      }
      // volume drop per side
      for (const side of ['A', 'B']) {
        const s0 = prev.walls.filter(w => w.side === side).reduce((s, w) => s + w.usd, 0);
        const s1 = walls.filter(w => w.side === side).reduce((s, w) => s + w.usd, 0);
        if (s0 > minUsd * 5 && s1 < s0 * (1 - dropPct / 100)) {
          ev.push({ ts: t1, type: 'VOLUME_DROP', side, fromUsd: +s0.toFixed(0), toUsd: +s1.toFixed(0) });
        }
      }
      // stack flip: imbalance regime change across neutral band
      const g = a.imb, g0 = prev.agg.imb;
      if (g != null && g0 != null && ((g0 <= flo && g >= fhi) || (g0 >= fhi && g <= flo))) {
        ev.push({ ts: t1, type: 'STACK_FLIP', from: g0, to: g, dir: g > g0 ? 'B' : 'A' });
      }
    }
    prev = { ts: r.ts, mid, agg: a, walls };
    if (recentDead.length > 1000) recentDead.splice(0, recentDead.length - 1000);
  }
  return ev;
}

// ---------- B) liquidation map (reconstruction) ---------------------------
// whale open/grow entry ~ mid at event ts; liq px = entry*(1-/+ 1/L),
// weighted by usd*tierWeight. Returns pools below/above ref mid.
function liqMap(whales, mids, refMid, o = {}) {
  const coin = o.coin || 'BTC', bucket = o.bucket ?? BUCKET, lev = o.leverage ?? LEVERAGE;
  const ts = mids.map(m => m.ts), px = mids.map(m => m.mid);
  const at = t => {
    let i = 0, lo = 0, hi = ts.length - 1;
    while (lo <= hi) { i = (lo + hi) >> 1; if (ts[i] < t) lo = i + 1; else hi = i - 1; }
    i = Math.max(0, Math.min(ts.length - 1, lo));
    if (i > 0 && Math.abs(ts[i - 1] - t) < Math.abs(ts[i] - t)) i--;
    return Math.abs(ts[i] - t) <= 3600e3 ? px[i] : null;
  };
  // per-(addr,coin) position tracking: close rows carry no usd/sz, so a
  // close removes whatever liq contributions that address previously added
  const pools = new Map(), pos = new Map();
  for (const e of whales) {
    if (e.coin !== coin || !['open', 'grow', 'close'].includes(e.type)) continue;
    const key = (e.addr || '?') + ':' + coin;
    if (e.type === 'close') {
      for (const c of pos.get(key) || []) pools.set(c.b, (pools.get(c.b) || 0) - c.w);
      pos.delete(key);
      continue;
    }
    if (!e.usd || !e.sz) continue;
    const e0 = at(e.ts); if (!e0) continue;
    for (const [L, w] of lev) {
      const lp = e.sz > 0 ? e0 * (1 - 1 / L) : e0 * (1 + 1 / L);
      const b = Math.round(lp / refMid / (bucket / 100)) * (bucket / 100) * refMid;
      const wt = Math.abs(e.usd) * w;
      pools.set(b, (pools.get(b) || 0) + wt);
      (pos.get(key) || pos.set(key, []).get(key)).push({ b, w: wt });
    }
  }
  const below = [], above = [];
  for (const [p, usd] of pools) {
    if (usd <= 0) continue; // emptied buckets carry no resting interest
    (p < refMid ? below : above).push({ px: +p.toPrecision(8), usd: +usd.toFixed(0) });
  }
  below.sort((a, b) => b.px - a.px); above.sort((a, b) => a.px - b.px);
  return { below, above };
}

// ---------- C) scenario state machine --------------------------------------
// states: base_down (sell dominance toward long-liq magnet),
//   squeeze (bid stack + holds + reclaim), cascade (magnet broke clean),
//   base_up / range. Signals are virtual-entry candidates only.
function classify(mid, pools, evs, wallsAgg, o = {}) {
  const zone = o.magZone ?? MAG_ZONE, lid = o.lidPct ?? LID_PCT;
  const cnt = (t, s) => evs.filter(e => e.type === t && (!s || e.side === s)).length;
  const bBrk = cnt('WALL_BREAK', 'B'), bPl = cnt('WALL_PULL', 'B'), bHd = cnt('WALL_HOLD', 'B');
  const aBrk = cnt('WALL_BREAK', 'A'), aPl = cnt('WALL_PULL', 'A'), aHd = cnt('WALL_HOLD', 'A');
  const reload = cnt('WALL_RELOAD'), flips = cnt('STACK_FLIP');
  // only pools with real size count as magnets; nearest bucket kept for info
  const MIN_MAG = o.minMagnetUsd ?? 20e6;
  const longMagnet = pools.below.find(p => p.usd >= MIN_MAG && p.px >= mid * (1 - 0.10)) || null;
  const shortMagnet = pools.above.find(p => p.usd >= MIN_MAG && p.px <= mid * (1 + 0.20)) || null;
  const nearLong = longMagnet && Math.abs(mid - longMagnet.px) / mid * 100 <= zone;
  const lidWall = (wallsAgg.wallsA || []).filter(w => w[0] <= lid && w[0] >= (o.minDist ?? MIN_DIST) && w[1] >= 20e6)
    .sort((a, b) => b[1] - a[1])[0] || null;
  const askLid = !!lidWall;
  const stats = { bBrk, bPl, bHd, aBrk, aPl, aHd, reload, flips,
    bidUsd: +((wallsAgg.wallsB || []).filter(w => Math.abs(w[0]) >= (o.minDist ?? MIN_DIST))
      .reduce((s, w) => s + w[1], 0) / 1e6).toFixed(1),
    askUsd: +((wallsAgg.wallsA || []).filter(w => Math.abs(w[0]) >= (o.minDist ?? MIN_DIST))
      .reduce((s, w) => s + w[1], 0) / 1e6).toFixed(1) };
  let state = 'range', dir = 0, target = null;
  const reasons = [];
  if (nearLong && bBrk >= 1 && bBrk + bPl > bHd * 3) {
    state = 'cascade'; dir = -1; target = pools.below[1] || null;
    reasons.push('inside long-liq zone with breaks dominant - magnet failing');
  } else if (bBrk + bPl >= 3 && bBrk + bPl > (bHd + reload) * 2) {
    state = 'base_down'; dir = -1; target = longMagnet;
    reasons.push(`bid attrition ${bBrk}brk/${bPl}pl vs ${bHd}hold - path to nearest long-liq pool`);
  } else if (bHd >= 1 && (reload >= 1 || stats.bidUsd >= 50) && aPl >= aBrk) {
    state = 'squeeze'; dir = +1; target = shortMagnet;
    reasons.push(`${bHd} bid hold(s) + stack ${stats.bidUsd}M - shorts above are fuel`);
  } else if (aBrk + aPl >= 3 && aBrk + aPl > aHd * 2 && bBrk + bPl <= (aBrk + aPl)) {
    state = 'base_up'; dir = +1; target = shortMagnet;
    reasons.push(`ask ceiling lifted ${aBrk}brk/${aPl}pl - path to nearest short-liq pool`);
  }
  const signals = [];
  if (nearLong && bHd >= 1 && (reload >= 1 || stats.bidUsd >= 50)) {
    signals.push({ side: 'long', px: mid, setup: 'liq-magnet + B hold + bid stack', target: shortMagnet && shortMagnet.px, invalid: +(longMagnet.px * 0.995).toPrecision(8) });
  }
  if (askLid && bBrk >= 2 && bHd === 0) {
    signals.push({ side: 'short', px: mid, setup: 'ask lid + B break series', target: longMagnet && longMagnet.px, invalid: +((lidWall ? mid * (1 + lidWall[0] / 100) : mid * 1.01) * 1.005).toPrecision(8) });
  }
  return { state, dir, target: target && target.px, longMagnet, shortMagnet, stats, reasons, signals };
}

function build(rows, whales, sym, now) {
  const recs = rows.filter(r => r.sym === sym && r.agg && r.agg.mid).sort((a, b) => a.ts - b.ts);
  if (recs.length < 5) return null;
  const last = recs[recs.length - 1];
  const anchor = Math.min(now, last.ts); // historical data: window anchors to last snapshot
  const wRecs = recs.filter(r => r.ts >= anchor - WINDOW - 86400e3); // chains need lookback
  const evs = deriveEvents(wRecs).filter(e => e.ts >= anchor - WINDOW);
  const pools = liqMap(whales.filter(w => w.coin === SYM_COIN(sym)),
    recs.map(r => ({ ts: r.ts, mid: r.agg.mid })), last.agg.mid, { coin: SYM_COIN(sym) });
  const sc = classify(last.agg.mid, pools, evs, last.agg);
  return { ts: now, sym, mid: +last.agg.mid.toFixed(2), imb: last.agg.imb, ...sc,
    events: evs.slice(-50) };
}

// ---------- CLI -------------------------------------------------------------
function main() {
  const once = process.argv.includes('--once') || !process.argv.includes('--watch');
  const OUT = arg('out', null);
  const rows = loadJsonl(HIST), whales = loadJsonl(WHEV);
  const syms = WANT ? [WANT] : [...new Set(rows.map(r => r.sym))].filter(s => /USDT$/.test(s));
  const tick = () => {
    const now = Date.now(), out = [];
    for (const s of syms) {
      const r = build(rows, whales, s, now);
      if (r) out.push(r);
    }
    if (OUT) fs.appendFileSync(OUT, out.map(r => JSON.stringify(r)).join('\n') + (out.length ? '\n' : ''));
    if (once) console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 1));
    return out;
  };
  tick();
  if (!once) setInterval(tick, +arg('interval', 180) * 1000);
}
if (require.main === module) main();
module.exports = { deriveEvents, liqMap, classify, build, loadJsonl };
