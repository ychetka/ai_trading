// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.
//
// Unit tests for tools/lib/n8n-sqlite-deployer.js. Runs against a throwaway
// sqlite file seeded with the minimal n8n schema the deployer expects -
// no real database, no network. Invoke: node --test tools/lib/*.test.js
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), os = require('os'), path = require('path');
const { deployWorkflow, EXPECTED_LATEST_MIGRATION } = require('./n8n-sqlite-deployer');

const NODES = [{ id: 'n1', type: 'n8n-nodes-base.scheduleTrigger' }];
const CONNS = {};
const HOOKS = [['book', 'GET', 'n1']];
const TRIGGERS = [['n1', 'in-memory']];

let dir, dbPath;

function seed(migrationName) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE migrations(id INTEGER PRIMARY KEY, timestamp INTEGER, name TEXT);
    CREATE TABLE workflow_entity(id TEXT PRIMARY KEY, name TEXT, active INTEGER,
      nodes TEXT, connections TEXT, settings TEXT, versionId TEXT,
      triggerCount INTEGER, createdAt TEXT, updatedAt TEXT, isArchived INTEGER,
      versionCounter INTEGER, activeVersionId TEXT);
    CREATE TABLE workflow_history(versionId TEXT, workflowId TEXT, authors TEXT,
      createdAt TEXT, updatedAt TEXT, nodes TEXT, connections TEXT, name TEXT,
      autosaved INTEGER);
    CREATE TABLE workflow_published_version(workflowId TEXT,
      publishedVersionId TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE webhook_entity(workflowId TEXT, webhookPath TEXT, method TEXT,
      node TEXT, webhookId TEXT, pathLength INTEGER);
    CREATE TABLE shared_workflow(workflowId TEXT, projectId TEXT, role TEXT);
    CREATE TABLE workflow_publication_trigger_status(workflowId TEXT,
      nodeId TEXT, versionId TEXT, status TEXT, errorMessage TEXT,
      createdAt TEXT, updatedAt TEXT, triggerKind TEXT);
    INSERT INTO migrations (timestamp, name) VALUES (1, 'older-migration');
    INSERT INTO shared_workflow (workflowId, projectId, role)
      VALUES ('66fb7895-f0b3-47', 'proj-1', 'workflow:owner');
  `);
  db.prepare('INSERT INTO migrations (timestamp, name) VALUES (2, ?)')
    .run(migrationName);
  db.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-deployer-test-'));
  dbPath = path.join(dir, 'database.sqlite');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('fresh deploy inserts workflow and aux rows, creates backup', () => {
  seed(EXPECTED_LATEST_MIGRATION);
  const r = deployWorkflow({ dbPath, name: 'Test WF', nodes: NODES,
    connections: CONNS, hooks: HOOKS, triggers: TRIGGERS });
  assert.equal(r.updated, false);
  assert.ok(r.workflowId && r.versionId);
  assert.ok(fs.existsSync(r.backupPath), 'backup file missing');

  const db = new DatabaseSync(dbPath);
  const wf = db.prepare('SELECT * FROM workflow_entity WHERE id=?').get(r.workflowId);
  assert.equal(wf.versionId, r.versionId);
  assert.equal(wf.activeVersionId, r.versionId);
  const pub = db.prepare('SELECT publishedVersionId FROM workflow_published_version WHERE workflowId=?')
    .get(r.workflowId);
  assert.equal(pub.publishedVersionId, r.versionId);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM webhook_entity WHERE workflowId=?')
    .get(r.workflowId).c, HOOKS.length);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM workflow_publication_trigger_status WHERE workflowId=?')
    .get(r.workflowId).c, TRIGGERS.length);
  const share = db.prepare('SELECT projectId FROM shared_workflow WHERE workflowId=?')
    .get(r.workflowId);
  assert.equal(share.projectId, 'proj-1');
  db.close();
});

test('redeploy with matchLike updates pointers to the new version', () => {
  seed(EXPECTED_LATEST_MIGRATION);
  deployWorkflow({ dbPath, name: 'Test WF v1', nodes: NODES,
    connections: CONNS, hooks: HOOKS, triggers: TRIGGERS });
  const r2 = deployWorkflow({ dbPath, name: 'Test WF v2', matchLike: 'Test WF%',
    nodes: NODES, connections: CONNS, hooks: HOOKS, triggers: TRIGGERS });
  assert.equal(r2.updated, true);

  const db = new DatabaseSync(dbPath);
  const wf = db.prepare('SELECT * FROM workflow_entity WHERE id=?').get(r2.workflowId);
  assert.equal(wf.versionId, r2.versionId);
  assert.equal(wf.activeVersionId, r2.versionId);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM workflow_history WHERE workflowId=?')
    .get(r2.workflowId).c, 2);
  db.close();
});

test('schema guard rejects a db with unexpected latest migration', () => {
  seed('SomeNewerMigration9999999999999');
  assert.throws(() => deployWorkflow({ dbPath, name: 'X', nodes: NODES,
    connections: CONNS }), /latest migration/);
  // explicit opt-out bypasses the guard
  const r = deployWorkflow({ dbPath, name: 'X', nodes: NODES, connections: CONNS,
    allowSchemaDrift: true });
  assert.ok(r.versionId);
});

test('snapshotPath writes a snapshot and author lands in history', () => {
  seed(EXPECTED_LATEST_MIGRATION);
  const snap = path.join(dir, 'wf-snapshot.json');
  const r = deployWorkflow({ dbPath, name: 'Snap WF', nodes: NODES,
    connections: CONNS, author: 'test-suite', snapshotPath: snap });
  const s = JSON.parse(fs.readFileSync(snap, 'utf8'));
  assert.equal(s.name, 'Snap WF');
  assert.deepEqual(s.nodes, NODES);
  const db = new DatabaseSync(dbPath);
  const h = db.prepare('SELECT authors FROM workflow_history WHERE versionId=?')
    .get(r.versionId);
  assert.equal(h.authors, 'test-suite');
  db.close();
});

test('schema guard rejects a db missing required tables', () => {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE migrations(id INTEGER, timestamp INTEGER, name TEXT)');
  db.close();
  assert.throws(() => deployWorkflow({ dbPath, name: 'X', nodes: NODES,
    connections: CONNS }), /missing tables/);
});
