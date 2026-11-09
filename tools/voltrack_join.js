#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// voltrack_join.js - signal-to-outcome joiner for the voltrack forward log.
// Reads the JSONL state rows emitted by `voltrack.js --watch --out=...`
// (each row carries {ts,sym,mid,state,regime,signals[]}) and resolves every
// virtual signal against subsequent mids:
//   exit on invalidation level -> 'invalid'   (R = -1 by construction)
//   exit on target level       -> 'target'
//   exit after --expiry-h      -> 'expiry'    (mark-to-mid at that tick)
// One open position per (sym,side): a repeating signal is not re-opened
// while its twin is still live. Positions still open at log end are
// reported as 'open' but NOT written to --out (a later run re-evaluates
// them once they resolve).
//
// Idempotent append: outcome key = sym:side:entryTs; rows already present
// in --out are skipped, so the joiner is safe to run on a timer.
//
//   node tools/voltrack_join.js --in=voltrack_state.jsonl --out=voltrack_outcomes.jsonl
//   node tools/voltrack_join.js --in=... --out=... --expiry-h=4
//
// Output row: {sym,side,setup,state,regime,entryTs,entry,target,invalid,
//   exitTs,exit,reason,R,mae,mfe,bars}.

const fs = require('fs');
const { loadJsonl } = require('./voltrack.js');
const { arg, loadJsonlRotated } = require('./lib/store');

const IN = arg('in', null);
const OUT = arg('out', null);
const EXPIRY = +arg('expiry-h', 4) * 3600e3;

// resolve(rows) -> {closed:[], open:[]} - pure, testable.
// rows: voltrack state rows (any order; sorted internally).
function resolve(rows, o = {}) {
  const expiry = o.expiryMs ?? EXPIRY;
  const recs = rows.filter(r => r.sym && r.mid && r.ts != null).sort((a, b) => a.ts - b.ts);
  const open = new Map();   // key sym:side -> position
  const closed = [];
  for (const r of recs) {
    // 1) resolve live positions against this tick's mid
    for (const [k, p] of open) {
      if (k.split(':')[0] !== r.sym) continue;
      const dir = p.side === 'long' ? 1 : -1;
      const adv = (r.mid - p.entry) * dir;              // favorable move
      if (adv > p.mfePx) p.mfePx = adv;
      if (adv < p.maePx) p.maePx = adv;
      let exit = null, reason = null;
      const hitInvalid = p.side === 'long' ? r.mid <= p.invalid : r.mid >= p.invalid;
      const hitTarget = p.target != null && (p.side === 'long' ? r.mid >= p.target : r.mid <= p.target);
      if (hitInvalid) { exit = p.invalid; reason = 'invalid'; }
      else if (hitTarget) { exit = p.target; reason = 'target'; }
      else if (r.ts - p.entryTs >= expiry) { exit = r.mid; reason = 'expiry'; }
      if (exit != null) {
        const R = +((exit - p.entry) * dir / p.risk).toFixed(3);
        closed.push({ sym: p.sym, side: p.side, setup: p.setup, state: p.state,
          regime: p.regime, entryTs: p.entryTs, entry: p.entry, target: p.target,
          invalid: p.invalid, exitTs: r.ts, exit, reason, R,
          mae: +(p.maePx / p.risk).toFixed(3), mfe: +(p.mfePx / p.risk).toFixed(3),
          bars: p.bars });
        open.delete(k);
      } else p.bars++;
    }
    // 2) open new positions from this tick's signals
    for (const s of r.signals || []) {
      if (s.side !== 'long' && s.side !== 'short') continue;
      const key = `${r.sym}:${s.side}`;
      if (open.has(key)) continue;
      const dir = s.side === 'long' ? 1 : -1;
      const risk = (s.px - s.invalid) * dir;
      if (!(risk > 0) || s.invalid == null) continue;
      open.set(key, { sym: r.sym, side: s.side, setup: s.setup, state: r.state,
        regime: r.regime || 'neutral', entryTs: r.ts, entry: s.px,
        target: s.target ?? null, invalid: s.invalid,
        risk, mfePx: 0, maePx: 0, bars: 0 });
    }
  }
  return { closed, open: [...open.values()] };
}

function summarize(closed) {
  const rs = closed.map(c => c.R).sort((a, b) => a - b);
  const n = rs.length;
  const q = p => n ? rs[Math.min(n - 1, Math.floor(p * n))] : null;
  const mean = n ? +(rs.reduce((a, b) => a + b, 0) / n).toFixed(3) : null;
  const by = k => {
    const m = {};
    for (const c of closed) { (m[c[k]] = m[c[k]] || []).push(c.R); }
    return Object.fromEntries(Object.entries(m).map(([g, v]) =>
      [g, { n: v.length, meanR: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3),
        win: +(100 * v.filter(x => x > 0).length / v.length).toFixed(1) }]));
  };
  return { n, meanR: mean, medianR: q(0.5), p5: q(0.05), p95: q(0.95),
    winPct: n ? +(100 * rs.filter(r => r > 0).length / n).toFixed(1) : null,
    byReason: closed.reduce((m, c) => (m[c.reason] = (m[c.reason] || 0) + 1, m), {}),
    byState: by('state'), byRegime: by('regime') };
}

function main() {
  if (!IN) { console.error('usage: --in=<voltrack_state.jsonl> [--out=outcomes.jsonl] [--expiry-h=4]'); process.exit(2); }
  // merge the rotated tail too: voltrack.js rotates --out to <file>.1,
  // and positions opened just before rotation live there, not in IN
  const rows = loadJsonlRotated(IN);
  const { closed, open } = resolve(rows);
  if (OUT) {
    const seen = new Set(loadJsonl(OUT).map(c => `${c.sym}:${c.side}:${c.entryTs}`));
    const fresh = closed.filter(c => !seen.has(`${c.sym}:${c.side}:${c.entryTs}`));
    if (fresh.length) fs.appendFileSync(OUT, fresh.map(c => JSON.stringify(c)).join('\n') + '\n');
    console.log(`appended ${fresh.length} outcome(s), ${open.length} position(s) still open`);
  }
  console.log(JSON.stringify({ summary: summarize(closed), open: open.length }, null, 1));
}
if (require.main === module) main();
module.exports = { resolve, summarize };
