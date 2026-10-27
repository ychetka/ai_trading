#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// deploy_scoring.js — workflow "Scoring Aggregator (svc)" (issue #7).
// Standalone asset-risk microservice, modelled on Books Aggregator.
//   GET /webhook/score?asset=UNI           -> score + flags + layer details
//   GET /webhook/score?contract=0x..&chain=bsc
//   GET /webhook/score-history?asset=UNI   -> stored scorings (JSONL)
// Layers (free APIs): CoinGecko (resolve/mcap/repos), GoPlus contract
// flags, DefiLlama TVL, GitHub repo activity. Score 0-100, higher=safefr.
// Run with n8n STOPPED. Deploy: node tools/deploy_scoring.js [--update]
const path = require('path'), crypto = require('crypto');
const { deployWorkflow } = require('./lib/n8n-sqlite-deployer');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const DB = arg('db') || path.join(__dirname, '..', 'docker-data',
  'volumes/crypto-analyst_n8n_storage/_data/.n8n/database.sqlite');

const H1 = crypto.randomUUID(), H2 = crypto.randomUUID();

const codeScore = String.raw`
const helpers=this.helpers;
const fs=require('fs');
const STATE='/home/node/.n8n/score_cache.json', HIST='/home/node/.n8n/score_history.jsonl';
let cache={}; try{cache=JSON.parse(fs.readFileSync(STATE,'utf8'));}catch(e){}
const get=async u=>{try{return await helpers.httpRequest({method:'GET',url:u,json:true,timeout:12000,headers:{'User-Agent':'score-svc/1','Accept':'application/json'}});}catch(e){return null;}};
const q=$input.first().json.query||{};
const asset=(q.asset||q.symbol||'').trim();
const contract=(q.contract||q.address||'').trim();
const chainIn=(q.chain||'').toLowerCase();
if(!asset&&!contract) return [{json:{error:'pass ?asset=SYM or ?contract=0x..&chain=eth'}}];

const GPL_CHAIN={eth:'1',bsc:'56',polygon:'137',arb:'42161',base:'8453',sol:'solana',op:'10',avax:'43114'};
const CG2GPL={'ethereum':'eth','binance-smart-chain':'bsc','polygon-pos':'polygon','arbitrum-one':'arb','base':'base','solana':'sol','optimistic-ethereum':'op','avalanche':'avax'};

// ---------- layer 1: CoinGecko resolve ----------
let cg=null;
if(asset){
  const key='cg:'+asset.toUpperCase();
  cg=cache[key]&&(Date.now()-cache[key].ts<86400e3)?cache[key]:null;
  if(!cg){
    const s=await get('https://api.coingecko.com/api/v3/search?query='+encodeURIComponent(asset));
    const coin=(s&&s.coins||[]).find(c=>c.symbol.toUpperCase()===asset.toUpperCase());
    if(coin){
      const d=await get('https://api.coingecko.com/api/v3/coins/'+coin.id+'?localization=false&tickers=false&market_data=true&developer_data=true');
      if(d)cg={id:d.id,name:d.name,sym:d.symbol.toUpperCase(),
        platforms:d.platforms||{},repos:((d.links||{}).repos_url||{}).github||[],
        mcap:((d.market_data||{}).market_cap||{}).usd,
        ath_drop:d.market_data&&d.market_data.ath_change_percentage&&d.market_data.ath_change_percentage.usd,
        dev:d.developer_data||{},genesis:d.genesis_date,ts:Date.now()};
      if(cg){cache[key]=cg;try{fs.writeFileSync(STATE,JSON.stringify(cache));}catch(e){}}
    }
  }
}

// ---------- layer 2: GoPlus contract security ----------
const flags=[];let gp=null,gpChain=null,gpAddr=null;
if(contract){
  gpChain=GPL_CHAIN[chainIn]||null;gpAddr=contract;
}else if(cg){
  for(const[plat,ch]of Object.entries(CG2GPL)){
    if(cg.platforms[plat]){gpAddr=cg.platforms[plat];gpChain=GPL_CHAIN[ch];break;}
  }
}
if(gpChain&&gpAddr){
  const g=await get('https://api.gopluslabs.io/api/v1/token_security/'+gpChain+'?contract_addresses='+gpAddr.toLowerCase());
  const r=g&&g.result&&(g.result[gpAddr.toLowerCase()]||Object.values(g.result)[0]);
  if(r){
    gp={};
    const num=x=>x===undefined||x===null||x===''?null:+x;
    gp.honeypot=r.is_honeypot==='1';gp.mintable=r.is_mintable==='1';
    gp.proxy=r.is_proxy==='1';gp.hiddenOwner=r.hidden_owner==='1';
    gp.takeBack=r.can_take_back_ownership==='1';gp.selfdestruct=r.selfdestruct==='1';
    gp.buyTax=num(r.buy_tax);gp.sellTax=num(r.sell_tax);
    gp.holders=num(r.holder_count);
    const hs=(r.holders||[]).slice(0,10).reduce((s,h)=>s+num(h.percent),0);
    gp.top10pct=+hs.toFixed(3);
    gp.ownerChangeBalance=r.owner_change_balance==='1';
  }
}

// ---------- layer 3: DefiLlama TVL ----------
let ll=null;
if(cg){
  for(const slug of [cg.id,cg.name&&cg.name.toLowerCase().replace(/[^a-z0-9]+/g,'-'),cg.sym.toLowerCase()]){
    if(!slug)continue;
    const d=await get('https://api.llama.fi/protocol/'+slug);
    if(d&&d.tvl!==undefined&&d.name){ll={slug:d.slug||slug,name:d.name,tvl:d.tvl,chains:d.chains,category:d.category,mcap:d.mcap};break;}
  }
}

// ---------- layer 4: GitHub repo activity ----------
let gh=null;
if(cg&&cg.repos.length){
  const m=cg.repos[0].match(/github\.com\/([^/]+\/[^/]+)/);
  if(m){
    const d=await get('https://api.github.com/repos/'+m[1].replace(/\.git$/,''));
    if(d&&d.full_name)gh={repo:d.full_name,stars:d.stargazers_count,forks:d.forks_count,
      pushedAt:d.pushed_at,ageDays:Math.round((Date.now()-Date.parse(d.pushed_at))/86400e3)};
  }
}
if(cg&&cg.dev&&(cg.dev.commits_4_weeks||cg.dev.pull_requests_merged))gh=gh||{};
if(cg&&cg.dev)gh=Object.assign(gh||{},{commits4w:cg.dev.commits_4_weeks||0,devs:cg.dev.pull_request_contributors||0});

// ---------- scoring ----------
let score=100;
const deduct=(pts,label)=>{score-=pts;flags.push({flag:label,penalty:pts});};
if(gp){
  if(gp.honeypot)deduct(60,'HONEYPOT');
  if(gp.takeBack||gp.ownerChangeBalance)deduct(25,'owner can change balance / take back ownership');
  if(gp.hiddenOwner)deduct(15,'hidden owner');
  if(gp.mintable)deduct(15,'mintable supply');
  if(gp.selfdestruct)deduct(20,'selfdestruct present');
  if(gp.proxy)deduct(10,'proxy contract (upgradable logic)');
  if((gp.sellTax||0)>0.10)deduct(15,'sell tax >10%');
  else if((gp.sellTax||0)>0.05)deduct(8,'sell tax 5-10%');
  if(gp.top10pct>0.50)deduct(15,'top-10 holders >50%');
  else if(gp.top10pct>0.30)deduct(7,'top-10 holders 30-50%');
}
if(cg){
  if(cg.mcap&&cg.mcap<5e6)deduct(15,'microcap <$5M');
  else if(cg.mcap&&cg.mcap<2e7)deduct(7,'smallcap <$20M');
  if(cg.ath_drop&&cg.ath_drop<-95)deduct(5,'down >95% from ATH');
  if(gh){
    if(gh.pushedAt&&gh.ageDays>180)deduct(10,'repo stale >180d');
    else if(gh.pushedAt&&gh.ageDays>90)deduct(5,'repo stale >90d');
    if(gh.commits4w===0)deduct(8,'no commits in 4 weeks');
  }
}else if(!contract){
  deduct(10,'asset not resolved via CoinGecko');
}
score=Math.max(0,Math.min(100,Math.round(score)));

const out={asset:asset||(contract.slice(0,10)+'...'),contract:gpAddr,chain:gpChain,
  score,verdict:score>=70?'LOW_RISK':score>=40?'REVIEW':'HIGH_RISK',
  flags:flags.map(f=>f.flag),score_start:100,
  layers:{coingecko:cg?{id:cg.id,name:cg.name,mcap:cg.mcap,genesis:cg.genesis}:null,
    goplus:gp,defillama:ll,github:gh},
  ts:new Date().toISOString()};
try{fs.appendFileSync(HIST,JSON.stringify({ts:Date.now(),asset:out.asset,score,verdict:out.verdict,flags:out.flags})+'\n');}catch(e){}
// rotation: once a day drop history older than 180 days
const day=new Date().toISOString().slice(0,10);
if((cache.pruneDay||'')!==day){
  try{
    const cut=Date.now()-180*86400e3;
    const lines2=fs.readFileSync(HIST,'utf8').split('\n').filter(l=>{
      if(!l)return false;try{return JSON.parse(l).ts>cut;}catch(e){return false;}});
    fs.writeFileSync(HIST,lines2.join('\n')+(lines2.length?'\n':''));
  }catch(e){}
  cache.pruneDay=day;try{fs.writeFileSync(STATE,JSON.stringify(cache));}catch(e){}
}
return[{json:out}];
`;

const codeHist = String.raw`
const fs=require('fs');
const q=$input.first().json.query||{};
const want=(q.asset||'').toUpperCase();
let rows=[];
try{rows=fs.readFileSync('/home/node/.n8n/score_history.jsonl','utf8').trim().split('\n').map(JSON.parse);}catch(e){}
if(want)rows=rows.filter(r=>(r.asset||'').toUpperCase()===want);
return[{json:{n:rows.length,rows:rows.slice(-500)}}];
`;

// ---------- node 5: daily universe sweep (issue #35) ----------
// calls the existing /webhook/score per asset - the engine itself appends
// each result to score_history.jsonl, so a sweep builds the daily panel.
const codeSweep = String.raw`
const helpers=this.helpers;
const fs=require('fs');
const uni=(()=>{try{return JSON.parse(fs.readFileSync('/home/node/.n8n/donchian_state.json','utf8')).universe||[];}catch(e){return[];}})();
const out=[];
for(let i=0;i<uni.length;i++){
  const s=uni[i];
  try{
    if(typeof s!=='string'||!s)throw new Error('bad universe entry');
    const asset=s.replace(/USDT$/,'');
    const r=await helpers.httpRequest({method:'GET',
      url:'http://localhost:5678/webhook/score?asset='+encodeURIComponent(asset),json:true,timeout:30000});
    out.push({asset,score:r&&r.score,verdict:r&&r.verdict});
  }catch(e){out.push({asset:String(s),error:String(e&&e.message||e)});}
  if(i<uni.length-1)await new Promise(r=>setTimeout(r,1500));   // be nice to the free APIs
}
return[{json:{ok:out.length,results:out}}];
`;

const nodes = [
  { parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 15 }] } },
    id: 's-sch', name: 'Daily Schedule',
    type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-400, 400] },
  { parameters: { jsCode: codeSweep },
    id: 's-sweep', name: 'Universe Score Sweep',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, 400] },
  { parameters: { httpMethod: 'GET', path: 'score', responseMode: 'lastNode', options: {}, webhookId: H1 },
    id: 's-hook', name: 'Score Webhook',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-400, 0], webhookId: H1 },
  { parameters: { jsCode: codeScore },
    id: 's-code', name: 'Scoring Engine',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, 0] },
  { parameters: { httpMethod: 'GET', path: 'score-history', responseMode: 'lastNode', options: {}, webhookId: H2 },
    id: 's-hist-hook', name: 'Score History Webhook',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-400, 200], webhookId: H2 },
  { parameters: { jsCode: codeHist },
    id: 's-hist', name: 'Score History',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, 200] }
];
const connections = {
  'Score Webhook': { main: [[{ node: 'Scoring Engine', type: 'main', index: 0 }]] },
  'Score History Webhook': { main: [[{ node: 'Score History', type: 'main', index: 0 }]] },
  'Daily Schedule': { main: [[{ node: 'Universe Score Sweep', type: 'main', index: 0 }]] }
};

deployWorkflow({
  dbPath: DB, name: 'Scoring Aggregator (svc)',
  nodes, connections, author: 'deploy_scoring.js',
  hooks: [['score', 'GET', 'Score Webhook'], ['score-history', 'GET', 'Score History Webhook']],
  triggers: [['s-hook', 'persisted'], ['s-code', 'persisted'], ['s-hist-hook', 'persisted'],
    ['s-hist', 'persisted'], ['s-sch', 'in-memory'], ['s-sweep', 'persisted']],
  snapshotPath: path.join(__dirname, '..', 'workflow-scoring.json'),
});
