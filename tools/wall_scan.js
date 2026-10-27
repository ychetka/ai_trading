#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// wall_scan.js — persistent order-book wall analyzer (issue #25).
// Reads books_history.jsonl (15-min snapshots, agg.wallsA/wallsB as
// [%distance, usd, venue]), tracks wall persistence across snapshots and
// classifies each wall's outcome:
//   pull  - wall disappeared before price touched its band
//   hold  - wall vanished after price touched its band (resting liquidity)
//   break - price crossed through the wall level
//   alive - chain still open at the end of the dataset
// Usage: node tools/wall_scan.js [--history=/path/books_history.jsonl]
//        [--symbol=BTCUSDT] [--min-usd=500000] [--min-dist=0.3] [--band=0.75]

const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const v = (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1]; return v === undefined || v === '' ? d : v; };
const HIST = arg('history', path.join(ROOT, 'docker-data',
  'volumes/crypto-analyst_n8n_storage/_data/books_history.jsonl'));
const WANT = (arg('symbol', null) || '').toUpperCase() || null;
const MIN_USD = +arg('min-usd', 500000);
const MIN_DIST = +arg('min-dist', 0.3);   // ignore walls closer than this % to mid (top-of-book noise)
const BAND = +arg('band', 0.75);          // %-points tolerance on wall distance
const TOUCH = 0.35;                        // price within this % of wall = touched
const SNAP_MIN = 15;

// tolerant parse: a torn last line (non-atomic append) must not kill the run
const rows = [];
for (const l of fs.readFileSync(HIST, 'utf8').split('\n')) {
  if (!l) continue;
  try { rows.push(JSON.parse(l)); } catch {}
}
const syms = [...new Set(rows.map(r => r.sym))].filter(s => !WANT || s === WANT);

const pct = (a, b) => (a / b - 1) * 100;
const classify = (out, tag) => { out[tag] = (out[tag] || 0) + 1; };

const stats = {};   // sym -> {chains, persist[], outcome:{pull,hold,break}}
const chains = [];  // all finished chains for detail
for (const sym of syms) {
  const recs = rows.filter(r => r.sym === sym && r.agg && r.agg.mid)
    .sort((a, b) => a.ts - b.ts);
  if (recs.length < 10) continue;
  const st = stats[sym] = { snaps: recs.length, chains: 0, persist: [], outcome: {}, maxHoldH: 0 };

  // active chains per side: {side:'A'|'B', pctAvg, usd, start, lastSeen, touched}
  const active = [];
  const finish = (c, endIdx, outcome) => {
    const snaps = Math.round((c.lastSeen - c.start) / (SNAP_MIN * 60000)) + 1;
    st.chains++; st.persist.push(snaps);
    classify(st.outcome, outcome);
    st.maxHoldH = Math.max(st.maxHoldH, snaps * SNAP_MIN / 60);
    chains.push({ sym, side: c.side, px: +c.px.toPrecision(6), usd: c.usdMax,
      snaps, hours: +(snaps * SNAP_MIN / 60).toFixed(1), outcome,
      start: new Date(c.start).toISOString().slice(5, 16), end: new Date(c.lastSeen).toISOString().slice(5, 16) });
  };

  for (let i = 0; i < recs.length; i++) {
    const r = recs[i], mid = r.agg.mid;
    const walls = [
      ...(r.agg.wallsA || []).map(w => ({ side: 'A', pct: w[0], usd: w[1], v: w[2] })),
      ...(r.agg.wallsB || []).map(w => ({ side: 'B', pct: w[0], usd: w[1], v: w[2] })),
    ].filter(w => w.usd >= MIN_USD && Math.abs(w.pct) >= MIN_DIST)
      .map(w => ({ ...w, px: mid * (1 + w.pct / 100) }));
    const seen = new Set();
    // match walls to active chains by side + absolute price band
    for (const w of walls) {
      let best = null, bd = 1e9;
      active.forEach((c, j) => {
        const d = Math.abs(pct(w.px, c.px));
        if (c.side === w.side && d < bd && !seen.has(j)) { best = j; bd = d; }
      });
      if (best !== null && bd <= BAND) {
        seen.add(best);
        const c = active[best];
        c.lastSeen = r.ts; c.n++;
        c.usdMax = Math.max(c.usdMax, w.usd);
      } else {
        active.push({ side: w.side, px: w.px, usdMax: w.usd,
          start: r.ts, lastSeen: r.ts, n: 1, touched: false });
      }
    }
    // check touch / break against the fixed absolute level
    for (const c of active) {
      if (Math.abs(pct(mid, c.px)) <= TOUCH) c.touched = true;
      if (c.side === 'A' && mid > c.px) { finish(c, i, 'break'); c.dead = true; }
      if (c.side === 'B' && mid < c.px) { finish(c, i, 'break'); c.dead = true; }
    }
    // age out: no match this snapshot -> pull or hold
    for (let j = active.length - 1; j >= 0; j--) {
      const c = active[j];
      if (c.dead) { active.splice(j, 1); continue; }
      if (c.lastSeen < r.ts) {
        finish(c, i, c.touched ? 'hold' : 'pull');
        active.splice(j, 1);
      }
    }
  }
  for (const c of active) finish(c, recs.length - 1, c.touched ? 'hold' : 'alive');
}

// report
const med = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
for (const sym of Object.keys(stats)) {
  const st = stats[sym];
  console.log(`\n=== ${sym} snaps=${st.snaps} chains=${st.chains} ` +
    `median persist=${med(st.persist)} snaps, max=${st.maxHoldH.toFixed(1)}h`);
  console.log('outcomes:', JSON.stringify(st.outcome));
}
console.log('\n--- top persistent walls (>=2h) ---');
chains.filter(c => c.snaps * SNAP_MIN >= 120)
  .sort((a, b) => b.snaps - a.snaps).slice(0, 30)
  .forEach(c => console.log(`${c.sym} ${c.side}@${c.px} $${(c.usd / 1e6).toFixed(1)}M ` +
    `${c.hours}h ${c.outcome}  ${c.start} > ${c.end}`));
const out = path.join(ROOT, 'data', 'wall_scan_out.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ chains, stats }, null, 1));
console.log('\ndetail ->', out);
