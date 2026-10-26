#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// deploy_whales.js — workflow "Whales Monitor (svc)" (issue #4).
// Tracks profitable Hyperliquid wallets (free leaderboard API) and their
// open positions (clearinghouseState). Fires when a cluster of smart
// wallets holds the same coin in the same direction.
//   Schedule 15min / GET /webhook/whales          -> scan + cluster check
//   GET /webhook/whale-history?hours=N            -> JSONL event log
// Run with n8n STOPPED. Deploy: node tools/deploy_whales.js [--update]
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const DB = arg('db') || path.join(__dirname, '..', 'docker-data',
  'volumes/crypto-analyst_n8n_storage/_data/.n8n/database.sqlite');

const envFile = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const ENV_TXT = envFile(path.join(__dirname, '..', 'ENV')) || envFile(path.join(__dirname, '..', '.env'));
const TG_CHAT_ID = process.env.TG_CHAT_ID ||
  (ENV_TXT.match(/^\s*TG_CHAT_ID\s*=\s*"?([^"\n]+)"?/m) || [])[1] || 'YOUR_CHAT_ID';

const WF_ID = crypto.randomUUID().slice(0, 16);
const VER_ID = crypto.randomUUID();
const H1 = crypto.randomUUID(), H2 = crypto.randomUUID();

const codeScan = String.raw`
const helpers=this.helpers;
const fs=require('fs');
const STATE='/home/node/.n8n/whales_state.json';
const HIST='/home/node/.n8n/whale_events.jsonl';
const TOP_N=50, MIN_ACCT=1e6, CLUSTER_K=2, CLUSTER_USD=5e5;
const get=async u=>{try{return await helpers.httpRequest({method:'GET',url:u,json:true,timeout:20000});}catch(e){return null;}};
const post=async(u,b)=>{try{return await helpers.httpRequest({method:'POST',url:u,json:true,body:b,timeout:10000});}catch(e){return null;}};

let st={wallets:{},clusters:{},lbTs:0,addrs:[]};
try{st=Object.assign(st,JSON.parse(fs.readFileSync(STATE,'utf8')));}catch(e){}

// ---------- 1. leaderboard -> address set (cached 1h) ----------
if(Date.now()-st.lbTs>3600e3||!st.addrs.length){
  const lb=await get('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard');
  const rows=(lb&&lb.leaderboardRows)||[];
  const scored=[];
  for(const r of rows){
    const acct=+r.accountValue||0;
    const perf=r.windowPerformances||[];
    const m=(perf.find(w=>w[0]==='month')||[])[1]||{};
    if(acct<MIN_ACCT)continue;
    const roi=+m.roi||0,pnl=+m.pnl||0;
    if(roi<=0)continue;
    scored.push({addr:r.ethAddress,acct,pnl,roi});
  }
  scored.sort((a,b)=>b.pnl-a.pnl);
  st.addrs=scored.slice(0,TOP_N).map(w=>w.addr);
  st.lbTs=Date.now();
}

// ---------- 2. poll positions, diff vs previous ----------
const events=[];
const cur={};
for(const addr of st.addrs){
  const d=await post('https://api.hyperliquid.xyz/info',{type:'clearinghouseState',user:addr});
  const aps=(d&&d.assetPositions)||[];
  const pos={};
  for(const p of aps){
    const P=p.position||{};
    const sz=+P.szi||0;
    if(!sz)continue;
    pos[P.coin]={sz,usd:Math.abs(sz*(+P.entryPx||0)),lev:P.leverage&&+P.leverage.value,entry:+P.entryPx};
  }
  cur[addr]=pos;
}
for(const addr of st.addrs){
  const prev=st.wallets[addr]||{},now=cur[addr]||{};
  for(const coin of Object.keys(now)){
    if(!prev[coin])events.push({type:'open',addr,coin,sz:now[coin].sz,usd:now[coin].usd,ts:Date.now()});
    else if(Math.abs(now[coin].sz)>1.5*Math.abs(prev[coin].sz))events.push({type:'grow',addr,coin,sz:now[coin].sz,usd:now[coin].usd,ts:Date.now()});
  }
  for(const coin of Object.keys(prev))
    if(!now[coin])events.push({type:'close',addr,coin,ts:Date.now()});
}
st.wallets=cur;

// ---------- 3. cluster detection (same coin, same direction, K wallets) ----------
// top-5 coins by open interest are consensus background, not signal -
// every tracked wallet touches them. Cluster alerts skip them.
let majors=new Set();
const m=await post('https://api.hyperliquid.xyz/info',{type:'metaAndAssetCtxs'});
if(m&&m[0]&&m[1]){
  const uni=m[0].universe||[],ctxs=m[1]||[];
  majors=new Set(uni.map((u,i)=>({c:u.name,oi:(+ctxs[i].openInterest||0)*(+ctxs[i].markPx||1)}))
    .sort((a,b)=>b.oi-a.oi).slice(0,5).map(x=>x.c));
}
const byCoin={};
for(const addr of st.addrs)
  for(const[coin,p]of Object.entries(cur[addr]||{})){
    const dir=p.sz>0?'L':'S';
    const k=coin+':'+dir;
    (byCoin[k]=byCoin[k]||{n:0,usd:0,addrs:[]});
    byCoin[k].n++;byCoin[k].usd+=p.usd;byCoin[k].addrs.push(addr.slice(0,8));
  }
// Bybit tickers -> funding rate per symbol (single bulk call)
const tick=await get('https://api.bybit.com/v5/market/tickers?category=linear');
const fund={};
for(const t of (tick&&tick.result&&tick.result.list)||[])
  fund[t.symbol.replace(/USDT$/,'')]=+t.fundingRate;

const alerts=[];
for(const[k,c]of Object.entries(byCoin)){
  const[coin,dir]=k.split(':');
  if(majors.has(coin))continue;                 // top-5 OI = consensus, skip
  if(c.n<CLUSTER_K||c.usd<CLUSTER_USD)continue;
  const was=st.clusters[k];
  if(was&&was.n>=c.n&&Date.now()-was.ts<6*3600e3)continue;   // already reported, still alive
  st.clusters[k]={n:c.n,usd:c.usd,ts:Date.now()};
  const f=fund[coin];
  // paid-to-hold side = basis-arb carry; paying side = directional
  const carry=(dir==='S'&&f>0)||(dir==='L'&&f<0);
  alerts.push({type:'cluster',coin,dir,n:c.n,usd:Math.round(c.usd),
    funding:f===undefined?null:f,carry:f===undefined?null:carry,
    wallets:c.addrs.slice(0,6),ts:Date.now()});
}
for(const k of Object.keys(st.clusters))
  if(!byCoin[k]||byCoin[k].n<CLUSTER_K)delete st.clusters[k];   // cluster dissolved

// ---------- 4. persist + report ----------
for(const e of events.concat(alerts))
  try{fs.appendFileSync(HIST,JSON.stringify(e)+'\n');}catch(e2){}
try{fs.writeFileSync(STATE,JSON.stringify(st));}catch(e){}

alerts.sort((a,b)=>b.usd-a.usd);
const lines=[];
for(const a of alerts){
  const tag=a.carry===null?'':a.carry?' [carry?]':' [directional]';
  const line='<b>WHALE CLUSTER '+(a.dir==='L'?'LONG':'SHORT')+' '+a.coin+'</b>'+tag+'\n'+
    a.n+' wallets, ~$'+(a.usd/1e6).toFixed(2)+'M combined'+
    (a.funding===null?'':' | funding '+(a.funding*100).toFixed(3)+'%')+'\n'+a.wallets.join(', ');
  if(lines.join('\n\n').length+line.length>3200)break;
  lines.push(line);
}
if(alerts.length>lines.length)lines.push('+'+(alerts.length-lines.length)+' more clusters');
const isHook=!!($input.first().json.headers||$input.first().json.params);
const diag={wallets:st.addrs.length,
  positions:Object.values(cur).reduce((s,p)=>s+Object.keys(p).length,0),
  events:events.length,alerts};
if(!lines.length)return isHook?[{json:Object.assign({digest:null},diag)}]:[];
return[{json:Object.assign({digest:lines.join('\n\n')},diag)}];
`;

const codeHist = String.raw`
const fs=require('fs');
const q=$input.first().json.query||{};
const hours=+q.hours||24;
let rows=[];
try{rows=fs.readFileSync('/home/node/.n8n/whale_events.jsonl','utf8').trim().split('\n').map(JSON.parse);}catch(e){}
const cut=Date.now()-hours*3600e3;
rows=rows.filter(r=>r.ts>=cut);
return[{json:{hours,n:rows.length,rows:rows.slice(-1000)}}];
`;

const nodes = [
  { parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } },
    id: 'w-sch', name: 'Whales Schedule',
    type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-400, -200] },
  { parameters: { httpMethod: 'GET', path: 'whales', responseMode: 'lastNode', options: {}, webhookId: H1 },
    id: 'w-hook', name: 'Whales Webhook',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-400, 0], webhookId: H1 },
  { parameters: { jsCode: codeScan },
    id: 'w-code', name: 'Whales Monitor',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, -100] },
  { parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{
          id: 'd1', leftValue: '={{ $json.digest }}',
          rightValue: '', operator: { type: 'string', operation: 'notEmpty' } }],
        combinator: 'and' },
      options: {} },
    id: 'w-if', name: 'Has Alert',
    type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [60, -100] },
  { parameters: {
      resource: 'message', operation: 'sendMessage', chatId: TG_CHAT_ID,
      text: '={{ $json.digest }}',
      additionalFields: { parse_mode: 'HTML' } },
    id: 'w-tg', name: 'Send Whales',
    type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [260, -100],
    credentials: { telegramApi: { id: 'Ms0WDN8WVr6TdRtU', name: 'Telegram Bot' } } },
  { parameters: { httpMethod: 'GET', path: 'whale-history', responseMode: 'lastNode', options: {}, webhookId: H2 },
    id: 'w-hist-hook', name: 'Whale History Webhook',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-400, 200], webhookId: H2 },
  { parameters: { jsCode: codeHist },
    id: 'w-hist', name: 'Whale History',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, 200] }
];
const connections = {
  'Whales Schedule': { main: [[{ node: 'Whales Monitor', type: 'main', index: 0 }]] },
  'Whales Webhook': { main: [[{ node: 'Whales Monitor', type: 'main', index: 0 }]] },
  'Whales Monitor': { main: [[{ node: 'Has Alert', type: 'main', index: 0 }]] },
  'Has Alert': { main: [[{ node: 'Send Whales', type: 'main', index: 0 }]] },
  'Whale History Webhook': { main: [[{ node: 'Whale History', type: 'main', index: 0 }]] }
};

const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
const db = new DatabaseSync(DB);
db.exec('BEGIN');
const existing = db.prepare(`SELECT id FROM workflow_entity WHERE name='Whales Monitor (svc)'`).get();
let wf;
if (existing) {
  wf = existing.id;
  db.prepare(`INSERT INTO workflow_history
    (versionId,workflowId,authors,createdAt,updatedAt,nodes,connections,name,autosaved)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(VER_ID, wf, 'deploy_whales.js --update', now, now,
      JSON.stringify(nodes), JSON.stringify(connections), 'Whales Monitor (svc)', 0);
  db.prepare(`UPDATE workflow_entity SET nodes=?,connections=?,versionId=?,activeVersionId=?,updatedAt=? WHERE id=?`)
    .run(JSON.stringify(nodes), JSON.stringify(connections), VER_ID, VER_ID, now, wf);
  db.prepare(`UPDATE workflow_published_version SET publishedVersionId=?,updatedAt=? WHERE workflowId=?`)
    .run(VER_ID, now, wf);
  console.log('updated workflow', wf, 'version', VER_ID);
} else {
  wf = WF_ID;
  db.prepare(`INSERT INTO workflow_entity
    (id,name,active,nodes,connections,settings,versionId,triggerCount,createdAt,updatedAt,isArchived,versionCounter,activeVersionId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
    .run(WF_ID, 'Whales Monitor (svc)', 1,
      JSON.stringify(nodes), JSON.stringify(connections),
      JSON.stringify({ executionOrder: 'v1' }), VER_ID, 0, now, now, 0, 1);
  db.prepare(`INSERT INTO workflow_history
    (versionId,workflowId,authors,createdAt,updatedAt,nodes,connections,name,autosaved)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(VER_ID, wf, 'deploy_whales.js', now, now,
      JSON.stringify(nodes), JSON.stringify(connections), 'Whales Monitor (svc)', 0);
  db.prepare(`UPDATE workflow_entity SET activeVersionId=? WHERE id=?`)
    .run(VER_ID, wf);
  db.prepare(`INSERT INTO workflow_published_version
    (workflowId,publishedVersionId,createdAt,updatedAt) VALUES (?,?,?,?)`)
    .run(wf, VER_ID, now, now);
  console.log('inserted workflow', wf, 'version', VER_ID);
}
db.prepare(`DELETE FROM webhook_entity WHERE workflowId=?`).run(wf);
for (const [p, m, n] of [['whales', 'GET', 'Whales Webhook'], ['whale-history', 'GET', 'Whale History Webhook']])
  db.prepare(`INSERT INTO webhook_entity (workflowId,webhookPath,method,node,webhookId,pathLength) VALUES (?,?,?,?,?,?)`)
    .run(wf, p, m, n, null, null);
const proj = db.prepare(`SELECT projectId FROM shared_workflow WHERE workflowId='66fb7895-f0b3-47'`).get();
if (proj) db.prepare(`INSERT OR IGNORE INTO shared_workflow (workflowId,projectId,role) VALUES (?,?,?)`)
  .run(wf, proj.projectId, 'workflow:owner');
db.prepare(`DELETE FROM workflow_publication_trigger_status WHERE workflowId=?`).run(wf);
for (const [nid, kind] of [['w-sch', 'in-memory'], ['w-hook', 'persisted'], ['w-code', 'persisted'],
  ['w-if', 'persisted'], ['w-tg', 'persisted'], ['w-hist-hook', 'persisted'], ['w-hist', 'persisted']])
  db.prepare(`INSERT INTO workflow_publication_trigger_status (workflowId,nodeId,versionId,status,errorMessage,createdAt,updatedAt,triggerKind) VALUES (?,?,?,?,?,?,?,?)`)
    .run(wf, nid, VER_ID, 'activated', null, now, now, kind);
db.exec('COMMIT');
db.close();

fs.writeFileSync(path.join(__dirname, '..', 'workflow-whales.json'),
  JSON.stringify({ name: 'Whales Monitor (svc)', nodes, connections }, null, 2));
console.log('snapshot -> workflow-whales.json');
