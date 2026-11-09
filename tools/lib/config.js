// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

'use strict';
// Single configuration module: paths, symbol universe, runtime
// assumptions. Everything that used to live as a drifted argv default
// or a copy-pasted literal across tools/ and systemd/ units owns one
// definition here.
//
// Ownership rules:
//   - PATHS: the n8n data volume is `docker-data/volumes/crypto-
//     analyst_n8n_storage/_data`. Workflow state files live at its
//     ROOT (books_history.jsonl, whale_events.jsonl, *_state.json);
//     only n8n internals (database.sqlite, config) live in `.n8n/`.
//   - SYMBOLS: BASE_SYMBOLS is the always-on floor; the live universe
//     unions it with donchian_state.json (monthly re-rank, re-read
//     every tick - see voltrack.js uniSymsOf). Systemd units must not
//     hardcode a symbol list - they pass --universe or nothing.
//   - NODE: n8n-sqlite-deployer + n8n_api_key need node:sqlite ->
//     NODE_MIN_MAJOR 22. Systemd units pin the interpreter binary
//     (currently v24.18.0; localtunnel.service pins a different
//     version - known drift, out of scope until unit templating).
//     assertNode() is called by tools that need the floor.

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const N8N_DATA = path.join(ROOT, 'docker-data', 'volumes', 'crypto-analyst_n8n_storage', '_data');
const N8N_DIR = path.join(N8N_DATA, '.n8n');

const paths = {
  ROOT,
  N8N_DATA,
  N8N_DIR,
  N8N_DB: path.join(N8N_DIR, 'database.sqlite'),
  N8N_CONFIG: path.join(N8N_DIR, 'config'),
  BOOKS_HISTORY: path.join(N8N_DATA, 'books_history.jsonl'),
  WHALE_EVENTS: path.join(N8N_DATA, 'whale_events.jsonl'),
  WALL_EVENTS: path.join(N8N_DATA, 'wall_events.jsonl'),
  DONCHIAN_STATE: path.join(N8N_DATA, 'donchian_state.json'),
  VOLTRACK_STATE: path.join(ROOT, 'data', 'voltrack_state.jsonl'),
  VOLTRACK_OUTCOMES: path.join(ROOT, 'data', 'voltrack_outcomes.jsonl'),
  BOOKS_MINUTE: path.join(ROOT, 'data', 'books_minute.jsonl'),
};

const BASE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

const NODE_MIN_MAJOR = 22;
function assertNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < NODE_MIN_MAJOR) {
    throw new Error(`node >= ${NODE_MIN_MAJOR} required (node:sqlite), got ${process.versions.node}`);
  }
}

module.exports = { paths, BASE_SYMBOLS, NODE_MIN_MAJOR, assertNode };
