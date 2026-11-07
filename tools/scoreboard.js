#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// scoreboard.js - renders SCOREBOARD.md from research/manifest.json
// (MVP artifact: pinned manifest + live strategy scoreboard by R).
// Sorts by meanR where a numeric verdict exists; data-gated and
// untestable entries are listed separately, honestly.
//
//   node tools/scoreboard.js            # print to stdout
//   node tools/scoreboard.js --write    # overwrite SCOREBOARD.md

const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'research', 'manifest.json');
const OUT = path.join(ROOT, 'SCOREBOARD.md');

const STATUS_LABEL = {
  'active-forward': 'ACTIVE (forward)',
  'rejected': 'REJECTED',
  'no-edge': 'NO EDGE',
  'marginal': 'MARGINAL',
  'untestable': 'UNTESTABLE',
  'accumulating': 'ACCUMULATING',
  'data-gated': 'DATA-GATED',
  'underpowered': 'UNDERPOWERED',
};

function render(manifest) {
  const rows = manifest.strategies;
  const scored = rows.filter(r => r.metrics && typeof r.metrics.meanR === 'number')
    .sort((a, b) => b.metrics.meanR - a.metrics.meanR);
  const unscored = rows.filter(r => !(r.metrics && typeof r.metrics.meanR === 'number'));

  const L = [];
  L.push('# Strategy Scoreboard');
  L.push('');
  L.push('Generated from `research/manifest.json` by `tools/scoreboard.js` - do not edit by hand.');
  L.push('Every number is a historical verdict with its N, horizon, regime and');
  L.push('friction assumptions attached. Past R is not a promise of future R.');
  L.push('');
  L.push('## Scored strategies (ranked by meanR)');
  L.push('');
  L.push('| # | Strategy | Family | Status | meanR | N | Win% | Horizon | Regime | Frictions | Evidence |');
  L.push('|---|----------|--------|--------|-------|---|------|---------|--------|-----------|----------|');
  scored.forEach((s, i) => {
    const m = s.metrics;
    L.push(`| ${i + 1} | ${s.name} | ${s.family} | ${STATUS_LABEL[s.status] || s.status} | ${m.meanR >= 0 ? '+' : ''}${m.meanR}R | ${m.n} | ${m.winPct != null ? m.winPct + '%' : '-'} | ${m.horizon || '-'} | ${m.regime || '-'} | ${m.fees || '-'} | ${s.ref} |`);
  });
  L.push('');
  L.push('## Not yet scored');
  L.push('');
  L.push('| Strategy | Family | Status | Why / blocker | Ref |');
  L.push('|----------|--------|--------|---------------|-----|');
  for (const s of unscored) {
    const m = s.metrics || {};
    // keep negative evidence visible: numeric metrics join the why-column
    const extra = ['mean4h_pct', 'mean2h_pct', 'directional', 'breakout_rate', 'verdict', 'note']
      .filter(k => m[k] != null).map(k => m[k]);
    const base = typeof m.n === 'number' ? `n=${m.n}` : (m.n ?? '?');
    const why = m.blocker || [base, ...extra].join('; ');
    L.push(`| ${s.name} | ${s.family} | ${STATUS_LABEL[s.status] || s.status} | ${why} | ${s.ref} |`);
  }
  L.push('');
  L.push('## Reading this table');
  L.push('');
  L.push('- **REJECTED** entries stay visible on purpose: the lab sells honest');
  L.push('  teardowns, and a documented failure is worth more than a cherry-picked win.');
  L.push('- **MARGINAL** means the mean is positive but the distribution does not');
  L.push('  survive costs - see median and win rate before believing the mean.');
  L.push('- **ACCUMULATING / DATA-GATED** entries are forward collectors; their');
  L.push('  first scored verdict requires n>50 or a non-neutral regime window.');
  L.push('');
  return L.join('\n');
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const md = render(manifest);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, md);
    console.log(`wrote ${OUT}`);
  } else {
    process.stdout.write(md);
  }
}
if (require.main === module) main();
module.exports = { render };
