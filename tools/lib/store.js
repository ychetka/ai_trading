// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

'use strict';
// Shared helpers: argv parsing, ./ENV reading, JSONL store access with
// the project's `<file>.1` single-generation rotation convention.
//
// Why this exists: three independent copies of the .1-merge logic and
// two argv-parser variants had already drifted apart - identical data
// produced different reports depending on which reader ran. ONE copy
// lives here; every consumer migrates to it.
//
// Rotation convention (voltrack.js --*-max-mb, n8n snapshot writers):
//   writes append to <file>; past the size cap <file> is renamed to
//   <file>.1 (previous .1 discarded). Readers merge `.1` FIRST, then
//   the live file - same ordering every consumer must use.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ---------- argv ------------------------------------------------------------
// `--key=value` only (existing convention - no space-separated values,
// no short flags). `arg('k', d)` returns d when the flag is absent or
// empty; `flag('k')` tests presence.
const arg = (k, d) => {
  const v = (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
  return v === undefined || v === '' ? d : v;
};
const flag = k => process.argv.includes(`--${k}`);

// ---------- env -------------------------------------------------------------
// Untracked ./ENV (or ./.env) file: KEY=value lines, optional quotes.
const envFile = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const envTxt = (root = ROOT) =>
  envFile(path.join(root, 'ENV')) || envFile(path.join(root, '.env'));
const envVal = (key, root = ROOT) => {
  if (process.env[key]) return process.env[key];
  const m = envTxt(root).match(new RegExp('^\\s*' + key + '\\s*=\\s*"?([^"\\n]+)"?', 'm'));
  return m ? m[1] : '';
};

// ---------- JSONL store -----------------------------------------------------
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

// Rotated-read: <file>.1 (older generation) then <file> (current).
const loadJsonlRotated = f => [...loadJsonl(f + '.1'), ...loadJsonl(f)];

// Bounded append: past maxMb the file rotates to <file>.1 (single
// generation). maxMb <= 0 disables rotation.
function appendJsonl(file, obj, maxMb = 0) {
  const text = (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n';
  if (maxMb > 0) {
    try {
      if (fs.statSync(file).size > maxMb * 1e6) fs.renameSync(file, file + '.1');
    } catch {}
  }
  fs.appendFileSync(file, text);
}

module.exports = { ROOT, arg, flag, envFile, envTxt, envVal, loadJsonl, loadJsonlRotated, appendJsonl };
