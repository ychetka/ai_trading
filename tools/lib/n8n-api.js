// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

'use strict';
// n8n public-API client + workflow deployer (n8n 2.x).
//
// Replaces direct SQLite patching for day-to-day deployment. The API
// path lets n8n itself re-register webhooks/schedule triggers and
// advance the published/active version pointers — the failure class
// that burned us twice with silent stale-version patches.
//
// Deploy sequence (conservative, per architecture review):
//   1. find workflow by name -> GET -> capture versionId/activeVersionId
//   2. POST /deactivate (if active)           — n8n deregisters triggers
//   3. PUT /workflows/{id}                    — new node/connection JSON
//   4. GET -> canonical-hash compare nodes+connections (loud mismatch)
//   5. POST /activate
//   6. GET -> assert activeVersionId non-null and advanced past pre-state
//   7. probe declared webhook paths for registration (404-vs-method check)
//
// Auth: X-N8N-API-KEY JWT minted once by tools/n8n_api_key.js and kept
// in the untracked ./ENV file (N8N_API_KEY=...) or process env.

const { envVal } = require('./store');

// ---- canonical structural compare -----------------------------------------
// Volatile fields that legitimately change between deployments and say
// nothing about workflow behavior. `id` is kept volatile because node
// ids are regenerated per deploy but connections reference node NAMES.
const NODE_VOLATILE = new Set([
  'id', 'versionId', 'createdAt', 'updatedAt', 'notes', 'position',
]);
function canon(v, inNode) {
  if (Array.isArray(v)) return v.map(x => canon(x, false));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (inNode && NODE_VOLATILE.has(k)) continue;
      out[k] = canon(v[k], k === 'nodes');
    }
    return out;
  }
  return v;
}
// Top-level node keys n8n manages itself - ignored when deciding
// whether stored content differs from the spec.
const SERVER_MANAGED = new Set([
  'webhookId', 'notices', 'pinData', 'meta', 'id', 'position',
  'versionId', 'createdAt', 'updatedAt', 'notes',
]);
function canonNodes(nodes) { return canon(nodes, false).map(n => canon(n, true)); }
function canonConns(conns) { return canon(conns, false); }

// ---- REST client -----------------------------------------------------------
async function api(method, p, body, { apiUrl, apiKey } = {}) {
  apiUrl = (apiUrl || envVal('N8N_API_URL') || 'http://localhost:5678').replace(/\/$/, '');
  apiKey = apiKey || envVal('N8N_API_KEY');
  if (!apiKey) throw new Error('N8N_API_KEY missing — run tools/n8n_api_key.js --mint and store it in ./ENV');
  const r = await fetch(`${apiUrl}/api/v1${p}`, {
    method,
    headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch { json = { _raw: txt }; }
  if (!r.ok) {
    const e = new Error(`n8n API ${method} ${p} -> ${r.status}: ${txt.slice(0, 300)}`);
    e.status = r.status; e.body = json;
    throw e;
  }
  return json;
}

async function getWorkflow(id, o) { return api('GET', `/workflows/${id}`, undefined, o); }

async function findWorkflowId(name, o) {
  let cursor;
  do {
    const res = await api('GET', `/workflows?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, o);
    const hit = (res.data || []).find(w => w.name === name);
    if (hit) return hit.id;
    cursor = res.nextCursor;
  } while (cursor);
  throw new Error(`workflow "${name}" not found`);
}

// ---- webhook registration probe --------------------------------------------
// Probe with a method DIFFERENT from the registered one so the hook
// never actually fires: a registered path answers wrong-method
// requests with n8n's "Cannot <METHOD>" hint, while an unregistered
// path gets the generic "webhook not registered" 404. n8n also takes
// a beat to materialize registrations after /activate — poll briefly.
async function probeWebhook(hookPath, o = {}) {
  const apiUrl = (o.apiUrl || envVal('N8N_API_URL') || 'http://localhost:5678').replace(/\/$/, '');
  const reg = (o.method || 'GET').toUpperCase();
  const probe = reg === 'GET' ? 'DELETE' : 'GET';
  const url = `${apiUrl}/webhook/${hookPath.replace(/^\//, '')}`;
  let last;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { method: probe });
    const txt = await r.text();
    last = { status: r.status, body: txt.slice(0, 120) };
    // strict: only the wrong-method hint proves registration; any
    // other response (5xx, proxy error, unrelated 404) fails loudly.
    // Checked FIRST so a phrasing change on the unregistered-404
    // can't shadow a valid hint.
    if (/Did you mean/i.test(txt)) return { ok: true, ...last };
    // unregistered paths: 'The requested webhook "..." is not registered.'
    if (r.status === 404 && /The requested webhook/.test(txt)) {
      await new Promise(r2 => setTimeout(r2, 1200));
      continue;
    }
    return { ok: false, ...last };
  }
  return { ok: false, ...last };
}

// ---- deploy ----------------------------------------------------------------
// spec: {name, nodes, connections, settings?, activate?, webhookPaths?,
//        oldId?} — activate defaults true.
// Returns {id, versionId, activeVersionId, changed, verified:{...}}.
async function deployWorkflow(spec, o = {}) {
  const id = spec.id || await findWorkflowId(spec.name, o);
  const pre = await getWorkflow(id, o);
  const wasActive = !!pre.active;
  const preByName = new Map((pre.nodes || []).map(n => [n.name, n]));
  // symmetric drift check: spec keys must match stored, and stored
  // must not carry functional keys the spec dropped (server-managed
  // keys are tolerated either way).
  const drifted = (want, got) => {
    if (!specSubsetMatch(canon(want, true), canon(got, true))) return true;
    const wk = new Set(Object.keys(want));
    return Object.keys(got).some(k => !wk.has(k) && !SERVER_MANAGED.has(k));
  };
  const changed = spec.nodes.length !== (pre.nodes || []).length
    || spec.nodes.some(n => { const g = preByName.get(n.name); return !g || drifted(n, g); })
    || JSON.stringify(canonConns(spec.connections)) !== JSON.stringify(canonConns(pre.connections));

  if (wasActive) await api('POST', `/workflows/${id}/deactivate`, undefined, o);

  const put = await api('PUT', `/workflows/${id}`, {
    name: spec.name,
    nodes: spec.nodes,
    connections: spec.connections,
    settings: { ...(pre.settings || {}), ...(spec.settings || {}) },
  }, o);

  const post = await getWorkflow(id, o);
  // Spec is source of truth: every key we declare must match exactly.
  // Keys the server adds (webhookId on non-hook nodes, resolved
  // credential names, notices) are server-managed and ignored.
  const gotByName = new Map((post.nodes || []).map(n => [n.name, n]));
  const wantNames = new Set(spec.nodes.map(n => n.name));
  const missing = spec.nodes.filter(n => !gotByName.has(n.name)).map(n => n.name);
  const extra = (post.nodes || []).filter(n => !wantNames.has(n.name)).map(n => n.name);
  const differs = spec.nodes.filter(n => {
    const got = gotByName.get(n.name);
    return got && !specSubsetMatch(canon(n, true), canon(got, true));
  }).map(n => n.name);
  if (missing.length || extra.length || differs.length) {
    throw new Error(`deploy ${spec.name}: nodes mismatch after PUT — ` +
      `missing=[${missing}] extra=[${extra}] differs=[${differs}]`);
  }
  const wantConns = JSON.stringify(canonConns(spec.connections));
  const gotConns = JSON.stringify(canonConns(post.connections));
  if (wantConns !== gotConns) throw new Error(`deploy ${spec.name}: connections mismatch after PUT`);

  // default: preserve the pre-deploy active state (parity with the
  // sqlite path, which never flipped entity.active). spec.activate
  // explicitly overrides.
  const wantActive = spec.activate === undefined ? wasActive : spec.activate !== false;
  let activeVersionId = null;
  if (wantActive) {
    await api('POST', `/workflows/${id}/activate`, undefined, o);
    const fin = await getWorkflow(id, o);
    activeVersionId = fin.activeVersionId || fin.activeVersion?.id || null;
    if (!fin.active) throw new Error(`deploy ${spec.name}: still inactive after /activate`);
    if (!activeVersionId) throw new Error(`deploy ${spec.name}: activeVersionId null after activate`);
    if (changed && pre.activeVersionId && activeVersionId === pre.activeVersionId) {
      // defensive: API must bump the active pointer on a content change
      throw new Error(`deploy ${spec.name}: activeVersionId did not advance`);
    }
  }

  const probes = [];
  for (const p of wantActive ? (spec.webhookPaths || []) : []) {
    const pr = await probeWebhook(typeof p === 'string' ? p : p.path, typeof p === 'string' ? o : { ...o, method: p.method });
    probes.push({ path: p, ...pr });
    if (!pr.ok) throw new Error(`deploy ${spec.name}: webhook ${p} not registered after activate`);
  }

  return {
    id,
    versionId: post.versionId || put.versionId,
    activeVersionId,
    wasActive,
    verified: { nodes: true, connections: true, active: wantActive, webhooks: probes },
    changed,
  };
}

// Every key in `want` (canon'ed spec node) must deep-equal in `got`.
// Extra keys on `got` are ignored — n8n adds server-managed fields.
function specSubsetMatch(want, got) {
  if (Array.isArray(want)) {
    return Array.isArray(got) && want.length === got.length &&
      want.every((v, i) => specSubsetMatch(v, got[i]));
  }
  if (want && typeof want === 'object') {
    if (!got || typeof got !== 'object' || Array.isArray(got)) return false;
    return Object.keys(want).every(k => specSubsetMatch(want[k], got[k]));
  }
  return want === got;
}

module.exports = { api, getWorkflow, findWorkflowId, deployWorkflow, canonNodes, canonConns, probeWebhook, envVal };
