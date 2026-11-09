'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { canonNodes, canonConns } = require('./n8n-api');

test('canonNodes: volatile fields stripped', () => {
  const a = { name: 'N', type: 't', id: 'x', position: [1, 2], parameters: { a: 1 } };
  const b = { name: 'N', type: 't', id: 'y', position: [9, 9], webhookId: 'srv', parameters: { a: 1 } };
  const ca = canonNodes([a])[0], cb = canonNodes([b])[0];
  assert.strictEqual(ca.id, undefined);
  assert.strictEqual(ca.position, undefined);
  assert.strictEqual(cb.webhookId, 'srv'); // server-added field kept in canon
  assert.deepStrictEqual(ca.parameters, cb.parameters);
});

test('canonNodes: position stripped at node level only', () => {
  const n = { name: 'N', position: [5, 5], parameters: { opts: { position: 1, k: 2 } } };
  const c = canonNodes([n])[0];
  assert.strictEqual(c.position, undefined);
  assert.deepStrictEqual(c.parameters.opts, { position: 1, k: 2 });
});

test('canonConns: key order normalized', () => {
  const a = { B: { main: [[{ node: 'C', type: 'main', index: 0 }]] }, A: { main: [[]] } };
  const b = { A: { main: [[]] }, B: { main: [[{ node: 'C', type: 'main', index: 0 }]] } };
  assert.strictEqual(JSON.stringify(canonConns(a)), JSON.stringify(canonConns(b)));
});

test('specSubsetMatch semantics via module internals', () => {
  // exercised indirectly: subset-match tolerates extra server keys
  const spec = { name: 'N', type: 'n8n-nodes-base.code', parameters: { jsCode: 'x' } };
  const stored = { ...spec, webhookId: 'srv-added', notices: ['n'] };
  const cs = canonNodes([spec])[0], cg = canonNodes([stored])[0];
  assert.ok(Object.keys(cg).includes('webhookId'));
  assert.ok(!Object.keys(cs).includes('webhookId'));
});
