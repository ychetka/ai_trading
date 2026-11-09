'use strict';
// Shared deploy entry point for tools/deploy_*.js.
//
// Primary path: n8n public REST API (tools/lib/n8n-api.js) — live
// deployment without stopping n8n, with structural read-back, version
// pointer assertion and webhook registration probes.
//
// Emergency fallback: `--emergency-sqlite` re-routes to the legacy
// direct-SQLite patcher (tools/lib/n8n-sqlite-deployer.js), which
// requires the container stopped. Break-glass only; scheduled for
// removal after two successful API deploy cycles.
//
// Call signature stays compatible with the sqlite deployer:
//   deployWorkflow({name, nodes, connections, hooks?, triggers?,
//                   snapshotPath?, dbPath?, matchLike?, author?})
// `hooks` = [[path, METHOD, nodeName], ...]  -> webhook probes.
// `triggers`/`dbPath`/`matchLike`/`author` are sqlite-era and ignored
// on the API path (activation registers everything itself).

const fs = require('fs');
const api = require('./n8n-api');

async function deployWorkflow(spec) {
  if (process.argv.includes('--emergency-sqlite')) {
    console.warn('EMERGENCY: using direct SQLite patcher — n8n container must be stopped');
    const legacy = require('./n8n-sqlite-deployer');
    return legacy.deployWorkflow(spec);
  }

  const webhookPaths = (spec.hooks || []).map(([p, method]) => ({ path: p, method }));
  const res = await api.deployWorkflow({
    name: spec.name,
    nodes: spec.nodes,
    connections: spec.connections,
    settings: spec.settings,
    activate: spec.activate,
    webhookPaths,
  });

  if (spec.snapshotPath) {
    fs.writeFileSync(spec.snapshotPath, JSON.stringify(
      { name: spec.name, nodes: spec.nodes, connections: spec.connections }, null, 2));
  }

  console.log(`DEPLOYED ${spec.name} via API`);
  console.log(`  workflowId:      ${res.id}`);
  console.log(`  versionId:       ${res.versionId}`);
  console.log(`  activeVersionId: ${res.activeVersionId}`);
  console.log(`  contentChanged:  ${res.changed}`);
  for (const p of res.verified.webhooks) {
    console.log(`  webhook ${typeof p === 'object' ? JSON.stringify(p.path) : p}: registered (probe ${p.status})`);
  }
  return res;
}

module.exports = { deployWorkflow };
