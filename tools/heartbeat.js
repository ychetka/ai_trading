#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// heartbeat.js — dead-man's switch for the collector stack (issue #23).
// Checks that n8n state files keep being written by their schedules and
// that the n8n container answers /healthz. On a stall, sends one Telegram
// alert per check per DEDUP_H window; otherwise exits quietly (0).
//
//   node tools/heartbeat.js          # run once (systemd timer or cron)
//
// Env (from ./ENV or process env): TG_BOT_TOKEN, TG_CHAT_ID.
// Checks (mtime-based, no container access needed):
//   books_history.jsonl   - 15-min schedule   -> stale after 25 min
//   whales_state.json     - 15-min scan       -> stale after 25 min
//   donchian_state.json   - hourly scan       -> stale after 80 min
//   n8n /healthz          - container alive

const fs = require('fs'), path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const ROOT = path.join(__dirname, '..');
// state files land in the volume root (container /home/node/.n8n -> _data)
const N8N = path.join(ROOT, 'docker-data',
  'volumes/crypto-analyst_n8n_storage/_data');
const HB_STATE = path.join(ROOT, 'data', 'heartbeat_state.json');

const envFile = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const ENV_TXT = envFile(path.join(ROOT, 'ENV')) || envFile(path.join(ROOT, '.env'));
const env = k => process.env[k] ||
  (ENV_TXT.match(new RegExp(`^\\s*${k}\\s*=\\s*"?([^"\\n]+)"?`, 'm')) || [])[1] || '';

const DEDUP_H = 4;
const CHECKS = [
  { name: 'books_history', file: 'books_history.jsonl', maxAgeMin: 25 },
  { name: 'whales_state', file: 'whales_state.json', maxAgeMin: 25 },
  { name: 'donchian_state', file: 'donchian_state.json', maxAgeMin: 80 },
];

const stale = [];
for (const c of CHECKS) {
  const p = path.join(N8N, c.file);
  try {
    const ageMin = (Date.now() - fs.statSync(p).mtimeMs) / 60000;
    if (ageMin > c.maxAgeMin) stale.push(`${c.name}: stale ${Math.round(ageMin)}m (max ${c.maxAgeMin}m)`);
  } catch {
    stale.push(`${c.name}: file missing`);
  }
}
try {
  const out = execSync('docker exec n8n-crypto-bot wget -q -O- --timeout=10 http://localhost:5678/healthz', { timeout: 20000 }).toString();
  if (!out.includes('"ok"')) stale.push('n8n /healthz: ' + out.slice(0, 80));
} catch (e) {
  stale.push('n8n /healthz unreachable: ' + String(e.message).slice(0, 80));
}

let hb = {}; try { hb = JSON.parse(fs.readFileSync(HB_STATE, 'utf8')); } catch {}
const now = Date.now(), due = stale.filter(s => {
  const key = s.split(':')[0];
  return !hb[key] || now - hb[key] > DEDUP_H * 3600e3;
});

if (!due.length) { console.log('heartbeat ok' + (stale.length ? ' (alerts deduped)' : '')); process.exit(0); }

const msg = '<b>HEARTBEAT ALERT</b>\n' + due.join('\n');
const token = env('TG_BOT_TOKEN'), chat = env('TG_CHAT_ID');
if (!token || !chat) { console.error('ALERT (no TG creds): ' + msg); process.exit(2); }

const body = JSON.stringify({ chat_id: chat, text: msg, parse_mode: 'HTML' });
const req = https.request({
  hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, res => {
  res.resume();
  res.on('end', () => {
    if (res.statusCode === 200) {
      for (const s of due) hb[s.split(':')[0]] = now;
      fs.mkdirSync(path.dirname(HB_STATE), { recursive: true });
      fs.writeFileSync(HB_STATE, JSON.stringify(hb));
      console.log('alert sent:', due.length);
    } else {
      console.error('telegram ' + res.statusCode); process.exit(2);
    }
  });
});
req.on('error', e => { console.error('telegram error: ' + e.message); process.exit(2); });
req.write(body); req.end();
