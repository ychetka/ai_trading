// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// n8n-sqlite-deployer.js — shared workflow deployer for the n8n SQLite store.
// One call = schema guard + file backup + single transaction across
// workflow_entity / workflow_history / workflow_published_version /
// webhook_entity / shared_workflow / trigger_status + post-write verify.
// deploy_*.js scripts become thin configs on top of this.
//
//   const { deployWorkflow } = require('./lib/n8n-sqlite-deployer');
//   const r = deployWorkflow({
//     dbPath, name: 'My Svc (svc)', matchLike: 'My Svc%',
//     nodes, connections, author: 'deploy_x.js',
//     hooks:    [['my-path', 'GET', 'My Webhook'], ...],
//     triggers: [['n-id1', 'in-memory'], ['n-id2', 'persisted'], ...],
//     snapshotPath,           // optional: write {name,nodes,connections} JSON
//     allowSchemaDrift: false // set true to bypass the migration guard
//   });
//   -> { workflowId, versionId, updated, backupPath }
//
// Run with n8n STOPPED. Requires node:sqlite (Node 22+).

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

// Schema fingerprint of the n8n version this deployer was written against.
// A different latest migration = schema may have drifted; fail loud unless
// allowSchemaDrift is set. Bump after verifying on the new n8n version.
const EXPECTED_LATEST_MIGRATION = 'AddExecutionScopesToCustomRoles1789995003141';

const REQUIRED_TABLES = [
  'workflow_entity', 'workflow_history', 'workflow_published_version',
  'webhook_entity', 'shared_workflow', 'workflow_publication_trigger_status',
  'migrations',
];
const REQUIRED_ENTITY_COLS = ['id', 'name', 'active', 'nodes', 'connections',
  'settings', 'versionId', 'triggerCount', 'createdAt', 'updatedAt',
  'isArchived', 'versionCounter', 'activeVersionId'];

function guardSchema(db, allowDrift) {
  const tables = new Set(
    db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all().map(r => r.name));
  const missing = REQUIRED_TABLES.filter(t => !tables.has(t));
  if (missing.length)
    {throw new Error(`n8n schema guard: missing tables: ${missing.join(', ')}`);}
  const cols = new Set(db.prepare('PRAGMA table_info(workflow_entity)').all().map(r => r.name));
  const missCols = REQUIRED_ENTITY_COLS.filter(c => !cols.has(c));
  if (missCols.length)
    {throw new Error(`n8n schema guard: workflow_entity missing columns: ${missCols.join(', ')}`);}
  const latest = db.prepare('SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1').get();
  const got = latest && latest.name;
  if (got !== EXPECTED_LATEST_MIGRATION && !allowDrift)
    {throw new Error(`n8n schema guard: latest migration is '${got}', expected ` +
      `'${EXPECTED_LATEST_MIGRATION}'. Schema drifted - verify table layout on ` +
      'the new n8n version, then bump EXPECTED_LATEST_MIGRATION or pass allowSchemaDrift.');}
  return got;
}

// File-level backup before any write; keeps the newest `keep` backups.
// Copies -wal/-shm too: a dirty WAL after unclean shutdown otherwise
// silently drops the newest committed pages from the backup.
function backupDb(dbPath, keep = 10) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${dbPath}.bak.${stamp}`;
  fs.copyFileSync(dbPath, bak);
  for (const ext of ['-wal', '-shm'])
    {try { fs.copyFileSync(dbPath + ext, bak + ext); } catch {}}
  // retention by backup set, not by file: one stamp = one .bak/-wal/-shm triplet
  const dir = path.dirname(dbPath), base = path.basename(dbPath) + '.bak.';
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(.+?)(-wal|-shm)?$');
  const stamps = [...new Set(fs.readdirSync(dir)
    .map(f => (f.match(re) || [])[1]).filter(Boolean))].sort();
  for (const old of stamps.slice(0, Math.max(0, stamps.length - keep)))
    {for (const ext of ['', '-wal', '-shm'])
      {try { fs.unlinkSync(path.join(dir, base + old + ext)); } catch {}}}
  return bak;
}

function deployWorkflow(cfg) {
  const {
    dbPath, name, matchLike, nodes, connections,
    author = 'deploy', hooks = [], triggers = [],
    shareFrom = '66fb7895-f0b3-47',   // borrow owner's projectId from Donchian wf
    snapshotPath = null, allowSchemaDrift = false,
  } = cfg;
  if (!dbPath || !name || !nodes || !connections)
    {throw new Error('deployWorkflow: dbPath, name, nodes, connections are required');}

  const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const VER_ID = crypto.randomUUID();
  const wfJson = JSON.stringify(nodes), connJson = JSON.stringify(connections);

  const db = new DatabaseSync(dbPath);
  const schema = guardSchema(db, allowSchemaDrift);
  const backupPath = backupDb(dbPath);
  console.log('schema ok (latest migration:', schema + '), backup ->', backupPath);

  let workflowId, updated = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    const existing = matchLike
      ? db.prepare('SELECT id FROM workflow_entity WHERE name LIKE ?').get(matchLike)
      : db.prepare('SELECT id FROM workflow_entity WHERE name=?').get(name);

    if (existing) {
      workflowId = existing.id;
      db.prepare(`INSERT INTO workflow_history
        (versionId,workflowId,authors,createdAt,updatedAt,nodes,connections,name,autosaved)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(VER_ID, workflowId, author + ' --update', now, now, wfJson, connJson, name, 0);
      db.prepare('UPDATE workflow_entity SET nodes=?,connections=?,versionId=?,activeVersionId=?,updatedAt=? WHERE id=?')
        .run(wfJson, connJson, VER_ID, VER_ID, now, workflowId);
      db.prepare('UPDATE workflow_published_version SET publishedVersionId=?,updatedAt=? WHERE workflowId=?')
        .run(VER_ID, now, workflowId);
      updated = true;
    } else {
      workflowId = crypto.randomUUID().slice(0, 16);
      // cyclic FK entity<->history: entity with NULL activeVersionId first
      db.prepare(`INSERT INTO workflow_entity
        (id,name,active,nodes,connections,settings,versionId,triggerCount,createdAt,updatedAt,isArchived,versionCounter,activeVersionId)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
        .run(workflowId, name, 1, wfJson, connJson,
          JSON.stringify({ executionOrder: 'v1' }), VER_ID, 0, now, now, 0, 1);
      db.prepare(`INSERT INTO workflow_history
        (versionId,workflowId,authors,createdAt,updatedAt,nodes,connections,name,autosaved)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(VER_ID, workflowId, author, now, now, wfJson, connJson, name, 0);
      db.prepare('UPDATE workflow_entity SET activeVersionId=? WHERE id=?')
        .run(VER_ID, workflowId);
      db.prepare(`INSERT INTO workflow_published_version
        (workflowId,publishedVersionId,createdAt,updatedAt) VALUES (?,?,?,?)`)
        .run(workflowId, VER_ID, now, now);
    }

    // aux records: without these, webhooks/schedules never register
    db.prepare('DELETE FROM webhook_entity WHERE workflowId=?').run(workflowId);
    for (const [p, m, n] of hooks)
      {db.prepare('INSERT INTO webhook_entity (workflowId,webhookPath,method,node,webhookId,pathLength) VALUES (?,?,?,?,?,?)')
        .run(workflowId, p, m, n, null, null);}

    const proj = db.prepare('SELECT projectId FROM shared_workflow WHERE workflowId=?').get(shareFrom);
    if (proj)
      {db.prepare('INSERT OR IGNORE INTO shared_workflow (workflowId,projectId,role) VALUES (?,?,?)')
        .run(workflowId, proj.projectId, 'workflow:owner');}

    db.prepare('DELETE FROM workflow_publication_trigger_status WHERE workflowId=?').run(workflowId);
    for (const [nid, kind] of triggers)
      {db.prepare('INSERT INTO workflow_publication_trigger_status (workflowId,nodeId,versionId,status,errorMessage,createdAt,updatedAt,triggerKind) VALUES (?,?,?,?,?,?,?,?)')
        .run(workflowId, nid, VER_ID, 'activated', null, now, now, kind);}

    // post-write verify: referential integrity before commit
    const v = db.prepare('SELECT versionId,activeVersionId FROM workflow_entity WHERE id=?').get(workflowId);
    const pub = db.prepare('SELECT publishedVersionId FROM workflow_published_version WHERE workflowId=?').get(workflowId);
    const nHooks = db.prepare('SELECT COUNT(*) c FROM webhook_entity WHERE workflowId=?').get(workflowId).c;
    const nTrig = db.prepare('SELECT COUNT(*) c FROM workflow_publication_trigger_status WHERE workflowId=?').get(workflowId).c;
    const errs = [];
    if (!v || v.versionId !== VER_ID) errs.push('entity.versionId mismatch');
    if (!v || v.activeVersionId !== VER_ID) errs.push('entity.activeVersionId mismatch');
    if (!pub || pub.publishedVersionId !== VER_ID) errs.push('publishedVersionId mismatch');
    if (nHooks !== hooks.length) errs.push(`webhook rows ${nHooks} != ${hooks.length}`);
    if (nTrig !== triggers.length) errs.push(`trigger rows ${nTrig} != ${triggers.length}`);
    if (errs.length) throw new Error('post-write verify failed: ' + errs.join('; '));

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    throw e;
  }
  db.close();
  console.log((updated ? 'updated' : 'inserted') + ' workflow', workflowId, 'version', VER_ID);

  if (snapshotPath) {
    fs.writeFileSync(snapshotPath,
      JSON.stringify({ name, nodes, connections }, null, 2));
    console.log('snapshot ->', snapshotPath);
  }
  return { workflowId, versionId: VER_ID, updated, backupPath };
}

module.exports = { deployWorkflow, EXPECTED_LATEST_MIGRATION };
