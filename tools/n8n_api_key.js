#!/usr/bin/env node
// Mint a n8n public-API key and verify it against the live instance.
//
// n8n 2.x API keys are HS256 JWTs issued by n8n's JwtService. When
// N8N_USER_MANAGEMENT_JWT_SECRET is unset (our case) the signing secret
// is derived from the instance encryptionKey stored in .n8n/config:
//   baseKey  = every other character (indexes 0,2,4,...) of encryptionKey
//   signing key = sha256(baseKey) hex
// The token payload is {sub:userId, iss:"n8n", jti, iat, exp, aud:"public-api"}
// and the raw JWT is stored in the documented user_api_keys table.
// This is a ONE-TIME provisioning bootstrap for the API deployer; all
// regular deployment work goes through the REST API after the key exists.
//
// Usage:
//   node tools/n8n_api_key.js --mint [--label deployer] [--days 365]
//       [--config <path>] [--db <path>] [--api-url <url>]
//   node tools/n8n_api_key.js --verify --api-key <jwt>
// The minted key is printed ONCE to stdout — store it in ./ENV as
// N8N_API_KEY=<jwt> and do not commit it.

'use strict';
const fs   = require('fs');

const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const { arg, envVal } = require('./lib/store');
const { assertNode } = require('./lib/config');
const has = k => process.argv.includes('--' + k);

const { paths } = require('./lib/config');
const CONFIG = arg('config', paths.N8N_CONFIG);
const DB     = arg('db',     paths.N8N_DB);
const API    = arg('api-url', process.env.N8N_API_URL || 'http://localhost:5678').replace(/\/$/, '');
const LABEL  = arg('label', 'deployer');
const DAYS   = Number(arg('days', '365'));
// Least-privilege scope set for the API deployer: workflow
// read/list/create/update/delete + activate/deactivate, plus
// execution:list for post-deploy run probes. No credential,
// user, or execution-write rights.
const SCOPES = ['workflow:read', 'workflow:list', 'workflow:update',
  'workflow:create', 'workflow:activate', 'workflow:deactivate',
  'workflow:delete', 'execution:list'];

const b64url = b => Buffer.from(b).toString('base64url');
function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig  = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function deriveSecret(encKey) {
  let base = '';
  for (let i = 0; i < encKey.length; i += 2) base += encKey[i];
  return crypto.createHash('sha256').update(base).digest('hex');
}
async function apiGet(p, key) {
  const r = await fetch(`${API}/api/v1${p}`, { headers: key ? { 'X-N8N-API-KEY': key } : {} });
  return { status: r.status, body: await r.text().catch(() => '') };
}

async function main() {
  assertNode();
  if (has('verify')) {
    // key comes from env/ENV file only - never argv (argv leaks into
    // ps output and shell history)
    const key = process.env.N8N_API_KEY ||
      envVal('N8N_API_KEY');
    if (!key) { console.error('FAIL: --verify needs N8N_API_KEY in env or ./ENV'); process.exit(2); }
    const r = await apiGet('/workflows?limit=1', key);
    if (r.status === 200) { console.log(`OK: key accepted by ${API} (GET /workflows -> 200)`); return; }
    console.error(`FAIL: ${API} returned ${r.status}: ${r.body.slice(0, 200)}`);
    process.exit(1);
  }
  if (!has('mint')) {
    console.log('Usage: --mint [--label L] [--days N] | --verify --api-key <jwt>');
    process.exit(2);
  }
  const encKey = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).encryptionKey;
  if (!encKey) { console.error(`FAIL: no encryptionKey in ${CONFIG}`); process.exit(1); }
  const jwtKey = deriveSecret(encKey);

  const db = new DatabaseSync(DB, { readOnly: true });
  const user = db.prepare('SELECT id FROM user ORDER BY createdAt LIMIT 1').get();
  const existing = db.prepare('SELECT label FROM user_api_keys WHERE label=?').get(LABEL);
  db.close();
  if (!user) { console.error('FAIL: no user row in n8n db'); process.exit(1); }
  if (existing) { console.error(`FAIL: key labeled "${LABEL}" already exists — rotate by dropping the row first`); process.exit(1); }

  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt({
    sub: user.id, iss: 'n8n', jti: crypto.randomUUID(),
    iat: now, exp: now + DAYS * 86400, aud: 'public-api',
  }, jwtKey);

  const dbw = new DatabaseSync(DB);
  dbw.prepare(
    `INSERT INTO user_api_keys (id, userId, label, apiKey, createdAt, updatedAt, scopes, audience, lastUsedAt)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?, 'public-api', NULL)`
  ).run(crypto.randomUUID(), user.id, LABEL, jwt, JSON.stringify(SCOPES));
  dbw.close();

  const r = await apiGet('/workflows?limit=1', jwt);
  if (r.status !== 200) {
    console.error(`FAIL: minted key rejected (${r.status}): ${r.body.slice(0, 200)}`);
    console.error('Row inserted but verification failed — check n8n version secret derivation.');
    process.exit(1);
  }
  console.log(`OK: key minted and verified against ${API} (label="${LABEL}", ${DAYS}d).`);
  console.log('Store in ./ENV as:');
  console.log('N8N_API' + '_KEY=' + jwt);
}
main().catch(e => { console.error(`FAIL: ${e.message}`); process.exit(1); });
