#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// cascade_autopsy.js - T+24h volatility/liquidation cascade autopsy
// (replaces the rejected near-real-time VOLATILITY TICKER per ROADMAP).
// Replays voltrack state rows from a DELAYED window - only rows older
// than --delay-h (default 24h) are eligible, by construction - and
// renders a markdown timeline of the most event-dense stretch:
// mid path, state transitions, wall events, liquidation pools, regime.
//
//   node tools/cascade_autopsy.js                      # best window, print
//   node tools/cascade_autopsy.js --write              # autopsies/AUTOPSY-<date>.md
//   node tools/cascade_autopsy.js --hours=4 --symbol=BTCUSDT

const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { loadJsonl } = require('./voltrack.js');
const arg = (k, d) => { const v = (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1]; return v === undefined || v === '' ? d : v; };
const STATE_FILE = arg('in', path.join(ROOT, 'data', 'voltrack_state.jsonl'));
const SYM = (arg('symbol', '') || '').toUpperCase();
const HOURS = +arg('hours', 4);
const DELAY = +arg('delay-h', 24);
const OUTDIR = arg('outdir', path.join(ROOT, 'autopsies'));

const fmtPx = p => p == null ? '-' : String(p);
const fmtTs = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

// rows eligible for publication: only rows at least delayH old.
function eligibleRows(rows, delayH, now = Date.now()) {
  const cutoff = now - delayH * 3600e3;
  return rows.filter(r => r.ts <= cutoff);
}

// pick the HOURS-window with the highest event weight (non-range rows +
// wall/flip events). Two pointers - O(n log n) over sorted input.
function pickWindow(rows, hours) {
  const ms = hours * 3600e3;
  const recs = [...rows].sort((a, b) => a.ts - b.ts);
  let best = null, ev = 0, nr = 0, j = 0;
  for (let i = 0; i < recs.length; i++) {
    while (j < recs.length && recs[j].ts <= recs[i].ts + ms) {
      ev += (recs[j].events || []).length;
      if (recs[j].state !== 'range') nr++;
      j++;
    }
    const score = ev + nr * 2;
    if (!best || score > best.score) best = { i, j, ev, nr, score, recs };
    ev -= (recs[i].events || []).length;
    if (recs[i].state !== 'range') nr--;
  }
  if (!best) return null;
  return { w: recs.slice(best.i, best.j), events: best.ev, nonRange: best.nr, score: best.score };
}

function autopsy(rows, sym, o = {}) {
  const win = pickWindow(rows, o.hours ?? HOURS);
  if (!win || !win.w.length) return null;
  const w = win.w, t0 = w[0].ts, t1 = w[w.length - 1].ts;
  const mids = w.map(r => r.mid).filter(m => m != null);
  const transitions = [];
  let prev = null;
  for (const r of w) {
    if (r.state !== prev) { transitions.push({ ts: r.ts, state: r.state, mid: r.mid }); prev = r.state; }
  }
  const events = [];
  for (const r of w) for (const e of r.events || []) events.push(e);
  const last = w[w.length - 1];
  return { sym, t0, t1, rows: w.length, events, transitions,
    mid: { start: mids[0], end: mids[mids.length - 1],
      min: mids.length ? Math.min(...mids) : null, max: mids.length ? Math.max(...mids) : null },
    changePct: mids.length > 1 ? +((mids[mids.length - 1] - mids[0]) / mids[0] * 100).toFixed(2) : null,
    states: w.reduce((m, r) => (m[r.state] = (m[r.state] || 0) + 1, m), {}),
    regime: last.regime, longMagnet: last.longMagnet, shortMagnet: last.shortMagnet,
    stats: last.stats, score: win.score };
}

function render(a, draft = false) {
  const L = [`# Cascade Autopsy - ${a.sym} ${fmtTs(a.t0)} .. ${fmtTs(a.t1)}`, ''];
  if (draft) L.push('_DRAFT - below the T+24h publication delay; internal analysis only._', '');
  L.push(`Delayed replay (T+24h publication rule). ${a.rows} state rows, ` +
    `mid ${fmtPx(a.mid.start)} -> ${fmtPx(a.mid.end)} (` +
    (a.changePct != null ? `**${a.changePct}%**` : 'n/a') +
    `, range ${fmtPx(a.mid.min)}..${fmtPx(a.mid.max)}). Regime: **${a.regime}**.`);
  L.push('');
  L.push('## State timeline');
  L.push('');
  L.push(a.transitions.map(t => `- ${fmtTs(t.ts)} **${t.state}** @ ${fmtPx(t.mid)}`).join('\n'));
  L.push('');
  L.push(`State mix: ${Object.entries(a.states).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  L.push('');
  if (a.events.length) {
    L.push('## Events');
    L.push('');
    L.push('| Time | Type | Side | Px | USD |');
    L.push('|------|------|------|----|----|');
    for (const e of a.events.slice(-30)) {
      L.push(`| ${fmtTs(e.ts)} | ${e.type} | ${e.side || e.dir || '-'} | ${fmtPx(e.px)} | ${e.usd || '-'} |`);
    }
    if (a.events.length > 30) L.push(`\n_+${a.events.length - 30} earlier events in this window omitted._`);
    L.push('');
  }
  L.push('## Liquidation pools at window end (reconstructed)');
  L.push('');
  L.push(`- Long-side magnet (below): ${a.longMagnet ? `${fmtPx(a.longMagnet.px)} ~$${(a.longMagnet.usd / 1e6).toFixed(0)}M` : 'none'}`);
  L.push(`- Short-side magnet (above): ${a.shortMagnet ? `${fmtPx(a.shortMagnet.px)} ~$${(a.shortMagnet.usd / 1e6).toFixed(0)}M` : 'none'}`);
  L.push('');
  if (a.stats) {
    L.push(`Wall events in trailing window: bid ${a.stats.bBrk}brk/${a.stats.bPl}pl/${a.stats.bHd}hold, ` +
      `ask ${a.stats.aBrk}brk/${a.stats.aPl}pl/${a.stats.aHd}hold, ` +
      `${a.stats.reload} reloads, ${a.stats.flips} stack flips. ` +
      `Book: bid $${a.stats.bidUsd}M / ask $${a.stats.askUsd}M.`);
  }
  L.push('');
  L.push('_Reconstructed liquidation map - estimate from whale entries x leverage tiers, not exchange OI-by-price._');
  L.push('');
  return L.join('\n');
}

function main() {
  const delay = Math.max(0, DELAY);
  // rotated tail merged like the joiner does - history survives rotation
  const rows = eligibleRows([...loadJsonl(STATE_FILE + '.1'), ...loadJsonl(STATE_FILE)], delay);
  let a;
  if (SYM) {
    a = autopsy(rows.filter(r => r.sym === SYM), SYM, { hours: HOURS });
  } else {
    // per-symbol candidates, best score wins - never mix syms in one window
    const cands = [...new Set(rows.map(r => r.sym))]
      .map(s => autopsy(rows.filter(r => r.sym === s), s, { hours: HOURS }))
      .filter(Boolean);
    a = cands.sort((x, y) => y.score - x.score)[0];
  }
  if (!a) { console.error(`no eligible rows older than ${delay}h`); process.exit(2); }
  const md = render(a, delay < 24);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(OUTDIR, { recursive: true });
    const f = path.join(OUTDIR, `AUTOPSY-${new Date(a.t0).toISOString().slice(0, 10)}-${a.sym}.md`);
    fs.writeFileSync(f, md);
    console.log(`wrote ${f}`);
  } else process.stdout.write(md);
}
if (require.main === module) main();
module.exports = { pickWindow, autopsy, render, eligibleRows };
