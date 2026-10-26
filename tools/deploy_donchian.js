#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// deploy_donchian.js — inserts the "Donchian Scanner (info)" workflow
// into the n8n SQLite DB per the version-pointer procedure (three pointers).
// Run with the n8n container STOPPED.
//   node tools/deploy_donchian.js [--db=/path/database.sqlite]
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const DB = arg('db') || path.join(__dirname, '..', 'docker-data',
  'volumes/crypto-analyst_n8n_storage/_data/.n8n/database.sqlite');

// Real Telegram chat id is a deploy-time secret: read it from the
// untracked ./ENV file (TG_CHAT_ID=...) or the process env; the repo
// keeps the YOUR_CHAT_ID placeholder in the node params.
const envFile = p => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const ENV_TXT = envFile(path.join(__dirname,'..','ENV')) || envFile(path.join(__dirname,'..','.env'));
const TG_CHAT_ID = process.env.TG_CHAT_ID ||
  (ENV_TXT.match(/^\s*TG_CHAT_ID\s*=\s*"?([^"\n]+)"?/m) || [])[1] || 'YOUR_CHAT_ID';

const WF_ID = crypto.randomUUID().slice(0, 16);
const VER_ID = crypto.randomUUID();
const HOOK_ID = crypto.randomUUID();

const jsCode = String.raw`
// Donchian Scanner (info) v4.5.1 — port of tools/donchian_monitor.js.
// Validated parameters: N=168 exit84 ATRx2.5 sq<=0.2 vol>1.5xSMA20,
// long-only, rolling top-10 by turnover, 8 virtual slots.
const fs = require('fs');
const STATE = '/home/node/.n8n/donchian_state.json';
const N=168,EXITN=84,ATRK=2.5,SQ=0.2,VOLK=1.5,VSMA=20;
const TOPK=10,SLOTS=8,EXPIRY=960,FEE=0.00055,SLIP_MIN=0.001,SLIPK=0.03;
const MIN_TURN24H=50e6,KLINES=600;
const NON_CRYPTO=new Set('XAUUSDT XAGUSDT XPTUSDT XPDUSDT CLUSDT HGUSDT SPXUSDT SPCXUSDT NDQUSDT DJIUSDT SNDKUSDT SOXLUSDT SOXSUSDT SKHYUSDT SKHYNIXUSDT MSTRUSDT MRVLUSDT BZUSDT PLTRUSDT COINUSDT HOODUSDT AAPLUSDT TSLAUSDT NVDAUSDT MSFTUSDT AMZNUSDT GOOGLUSDT METAUSDT AMDUSDT INTCUSDT MUUSDT NFLXUSDT AVGOUSDT ORCLUSDT QCOMUSDT TXNUSDT SHOPUSDT UBERUSDT PYPLUSDT SQUSDT ABNBUSDT BKNGUSDT DASHUSDT MELIUSDT SEUSDT BABAUSDT JDUSDT PDDUSDT BIDUUSDT NIOUSDT XPEVUSDT LIUSDT TCOMUSDT FUTUUSDT BEKEUSDT TMEUSDT BILIUSDT IQUSDT ZTOUSDT CRUSDT'.split(' '));
const helpers = this.helpers;
const api = async p => {
  const j = await helpers.httpRequest({method:'GET',url:'https://api.bybit.com'+p,json:true,headers:{'User-Agent':'n8n-donchian'}});
  if (j.retCode!==0) throw new Error(p+' -> '+j.retMsg);
  return j.result;
};
const klines = async sym =>
  (await api('/v5/market/kline?category=linear&symbol='+sym+'&interval=60&limit='+KLINES))
    .list.map(r=>({ts:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]}))
         .sort((a,b)=>a.ts-b.ts);
const tickers = async () =>
  (await api('/v5/market/tickers?category=linear')).list;

function pre(bars){
  const n=bars.length;
  const atr=new Array(n).fill(NaN),vS=new Array(n).fill(NaN),
        up=new Array(n).fill(NaN),dn=new Array(n).fill(NaN),
        bwP=new Array(n).fill(NaN);
  let tS=0,vA=0;const trs=[],win=[];
  for(let i=0;i<n;i++){
    const b=bars[i];
    const tr=i?Math.max(b.h-b.l,Math.abs(b.h-bars[i-1].c),Math.abs(b.l-bars[i-1].c)):b.h-b.l;
    trs.push(tr);tS+=tr;vA+=b.v;
    if(i>=14)tS-=trs[i-14];
    if(i>=VSMA)vA-=bars[i-VSMA].v;
    if(i>=14)atr[i]=tS/14;
    if(i>=VSMA)vS[i]=vA/VSMA;
    if(i>=N){
      let mx=-Infinity,mn=Infinity,cm=0;
      for(let j=i-N;j<i;j++){if(bars[j].h>mx)mx=bars[j].h;if(bars[j].l<mn)mn=bars[j].l;cm+=bars[j].c;}
      up[i]=mx;dn[i]=mn;
      const bw=(mx-mn)/(cm/N);
      win.push(bw);if(win.length>300)win.shift();
      bwP[i]=win.filter(x=>x<=bw).length/win.length;
    }
  }
  return{atr,vS,up,dn,bwP};
}
const slipOf=(atr,close)=>Math.max(SLIP_MIN,SLIPK*atr/close);
// order book at entry: Bybit perp + Binance/Bitget spot (volume leaders)
const sumBook=(bids,asks)=>{
  const b=bids.map(r=>[+r[0],+r[1]]),a=asks.map(r=>[+r[0],+r[1]]);
  if(!b.length||!a.length)return null;
  const mid=(b[0][0]+a[0][0])/2;
  const depth=(rows,pct)=>Math.round(rows.filter(x=>Math.abs(x[0]-mid)/mid*100<=pct).reduce((s,x)=>s+x[0]*x[1],0));
  const walls=rows=>rows.filter(x=>Math.abs(x[0]-mid)/mid*100<=5)
    .sort((x,y)=>y[0]*y[1]-x[0]*x[1]).slice(0,3)
    .map(x=>[+((x[0]-mid)/mid*100).toFixed(2),Math.round(x[0]*x[1])]);
  const b1=depth(b,1),a1=depth(a,1);
  return{mid:+mid.toPrecision(7),b1,a1,b3:depth(b,3),a3:depth(a,3),
    imb:+(b1/Math.max(a1,1)).toFixed(2),topB:walls(b),topA:walls(a)};
};
const httpJson=async url=>{try{return await helpers.httpRequest({method:'GET',url,json:true,timeout:8000});}catch(e){return null;}};
// primary: internal Books Aggregator microservice (svc) — all venues at once
const svcBook=async sym=>{
  const j=await httpJson('http://localhost:5678/webhook/book?symbol='+sym);
  return j&&j.agg?j:null;
};
// fallback: direct 3-venue snapshot
const snapBook=async sym=>{
  const out={};
  try{const r=await api('/v5/market/orderbook?category=linear&symbol='+sym+'&limit=200');
    out.bybit=sumBook(r.b,r.a);}catch(e){out.bybit=null;}
  try{const j=await httpJson('https://data-api.binance.vision/api/v3/depth?symbol='+sym+'&limit=100');
    out.binance=j&&j.bids?sumBook(j.bids,j.asks):null;}catch(e){out.binance=null;}
  try{const j=await httpJson('https://api.bitget.com/api/v2/spot/market/orderbook?symbol='+sym+'&type=step0&limit=100');
    out.bitget=j&&j.code==='00000'?sumBook(j.data.bids,j.data.asks):null;}catch(e){out.bitget=null;}
  return out;
};
const loadState=()=>{try{return JSON.parse(fs.readFileSync(STATE,'utf8'));}
  catch{return{month:null,universe:[],positions:[],trades:[],stats:{n:0,wins:0,sumR:0},lastSig:{}};}};
const saveState=s=>fs.writeFileSync(STATE,JSON.stringify(s));

const st=loadState();
st.lastSig=st.lastSig||{};
const events=[];
const now=Date.now();
// manual run (webhook provides headers) → always report stages
const manual=!!((($input.first()||{}).json)||{}).headers;
const dbg={eval:0,brk:0,volP:0,cand:0,entries:0,exits:0,posChk:0,kErr:0,
  skipDup:0,skipStale:0,skipSlot:0,nearSym:null,nearR:0};
const month=new Date(now).toISOString().slice(0,7);

// daily turnover24h sample → 30d average (proxy of backtest TVWIN)
const day=new Date(now).toISOString().slice(0,10);
let tk=null;
if(st.tvDay!==day||st.month!==month)tk=await tickers();
st.tv=st.tv||{};
if(st.tvDay!==day){st.tvDay=day;
  for(const t of tk){if(+t.turnover24h>0){
    (st.tv[t.symbol]=st.tv[t.symbol]||[]).push(+t.turnover24h);
    if(st.tv[t.symbol].length>30)st.tv[t.symbol].shift();}}}

if(st.month!==month){
  st.universe=tk.filter(t=>t.symbol.endsWith('USDT')&&!NON_CRYPTO.has(t.symbol)
      &&+t.turnover24h>=MIN_TURN24H)
    .map(t=>{const a=st.tv[t.symbol]||[];
      return[t.symbol,a.length>=7?a.reduce((x,y)=>x+y,0)/a.length:+t.turnover24h];})
    .sort((a,b)=>b[1]-a[1]).slice(0,TOPK).map(x=>x[0]);
  st.month=month;
  events.push({type:'universe',list:st.universe});
}
if(!st.universe.length)return[{json:{digest:'Donchian: universe empty'}}];

const need=new Set(st.universe);
for(const p of st.positions)need.add(p.sym);
need.add('BTCUSDT');
const data={};
for(const s of need){try{data[s]=await klines(s);}catch(e){dbg.kErr++;}}

// 1) virtual position exits on the last closed bar
for(let k=st.positions.length-1;k>=0;k--){
  dbg.posChk++;
  const pos=st.positions[k],bars=data[pos.sym];
  if(!bars||bars.length<2)continue;
  const i=bars.length-2,b=bars[i];
  if(b.ts<=pos.entryBarTs)continue;
  let mn=Infinity;
  for(let j=Math.max(0,i-EXITN);j<i;j++)if(bars[j].l<mn)mn=bars[j].l;
  const eff=Math.max(pos.stop0,mn);
  const hit=b.l<=eff;
  const expired=(b.ts-pos.entryBarTs)/3600e3>EXPIRY;
  if(!hit&&!expired){pos.barsHeld=(b.ts-pos.entryBarTs)/3600e3;continue;}
  const raw=hit?eff:b.c;
  const slip=slipOf(pre(bars).atr[i],b.c);
  const exit=raw*(1-slip-FEE);
  const R=(exit-pos.entry)/pos.risk;
  const reason=hit?'TRAIL_HIT':'EXPIRY';
  st.stats.n++;st.stats.sumR+=R;if(R>0)st.stats.wins++;
  st.trades.push({sym:pos.sym,entry:pos.entry,exit,R:+R.toFixed(3),entryTs:pos.entryTs,exitTs:now,bars:pos.barsHeld|0,reason,slipIn:pos.slipIn,slipOut:+slip.toFixed(5),book:pos.book||null});
  if(st.trades.length>500)st.trades.shift();
  events.push({type:'exit',sym:pos.sym,R:+R.toFixed(2),exit:+exit.toPrecision(6),hit,reason,heldH:pos.barsHeld|0});
  dbg.exits++;
  st.positions.splice(k,1);
}

// 2) new signals on the last closed bar
const btc=data['BTCUSDT'];
const cand=[];
for(const s of st.universe){
  const bars=data[s];
  if(!bars||bars.length<N+302)continue;
  const i=bars.length-2,b=bars[i],p=pre(bars);
  if(!Number.isFinite(p.atr[i])||!Number.isFinite(p.up[i]))continue;
  dbg.eval++;
  const ratio=b.c/p.up[i];
  if(ratio>dbg.nearR){dbg.nearR=ratio;dbg.nearSym=s;}
  if(!(b.c>p.up[i]))continue;
  dbg.brk++;
  const volR=b.v/p.vS[i];
  if(!(volR>VOLK))continue;
  dbg.volP++;
  if(!(p.bwP[i]<=SQ))continue;
  dbg.cand++;
  let rs=1;
  if(btc&&btc.length>=26&&i>=24){
    const dAlt=(b.c-bars[i-24].c)/bars[i-24].c;
    const bi=btc.length-2;
    const dBtc=(btc[bi].c-btc[bi-24].c)/btc[bi-24].c;
    if(dBtc!==0)rs=dAlt/dBtc;
  }
  cand.push({s,sigTs:b.ts,atr:p.atr[i],
    score:volR/Math.max(p.bwP[i],0.05)*Math.abs(rs),
    entryBar:bars[bars.length-1]});
}
cand.sort((a,b)=>b.score-a.score);
for(const c of cand){
  if(st.positions.length>=SLOTS){dbg.skipSlot++;break;}
  if(st.positions.some(x=>x.sym===c.s))continue;
  if(st.lastSig[c.s]===c.sigTs){dbg.skipDup++;continue;}
  if(now-c.sigTs>90*60e3){dbg.skipStale++;continue;}   // freshness: stale signal bar
  const slip=slipOf(c.atr,c.entryBar.o);
  const entry=c.entryBar.o*(1+slip+FEE);
  const stop0=entry-ATRK*c.atr;
  const risk=entry-stop0;
  if(!(risk>0))continue;
  const book=(await svcBook(c.s))||await snapBook(c.s);
  st.positions.push({sym:c.s,entry,stop0,risk,slipIn:+slip.toFixed(5),entryTs:now,entryBarTs:c.sigTs,barsHeld:0,book});
  (st.lastSig=st.lastSig||{})[c.s]=c.sigTs;
  events.push({type:'entry',sym:c.s,entry:+entry.toPrecision(6),
    stop:+stop0.toPrecision(6),riskPct:+(risk/entry*100).toFixed(2),
    score:+c.score.toFixed(2),book});
  dbg.entries++;
}

// breakout happened but gates filtered it — visible sign the scanner works
if(dbg.brk>0&&dbg.entries===0)
  events.push({type:'watch',brk:dbg.brk,volP:dbg.volP,cand:dbg.cand,
    near:dbg.nearSym,nearR:+dbg.nearR.toFixed(3)});

// 3) daily digest (the 00:0x UTC run, once a day)
if(new Date(now).getUTCHours()===0&&st.digestDay!==day){
  st.digestDay=day;
  const t24=st.trades.filter(t=>now-t.exitTs<86400e3);
  const conc={};
  for(const t of st.trades.filter(t=>now-t.exitTs<30*86400e3))
    conc[t.sym]=(conc[t.sym]||0)+1;
  const reasons={};let hb=0,sl=0,slN=0;
  for(const t of st.trades){
    reasons[t.reason||'?']=(reasons[t.reason||'?']||0)+1;
    hb+=t.bars||0;
    if(t.slipIn!=null){sl+=t.slipIn;slN++;}
  }
  events.push({type:'digest',day,
    dN:t24.length,dR:+t24.reduce((s,t)=>s+t.R,0).toFixed(2),
    n:st.stats.n,sumR:+st.stats.sumR.toFixed(1),wins:st.stats.wins,
    open:st.positions.map(p=>p.sym.replace('USDT','')),
    conc:Object.entries(conc).sort((a,b)=>b[1]-a[1])
      .map(([s,n])=>s.replace('USDT','')+'×'+n).join(' ')||'—',
    avgHoldH:st.trades.length?Math.round(hb/st.trades.length):0,
    avgSlipPct:slN?+(sl/slN*100).toFixed(3):0,
    reasons,
    pipeDay:st.dbg?st.dbg.day:null,pipe:st.dbg||null});
}

// accumulate pipeline stats for the digest (after digest it sees yesterday)
if(!st.dbg||st.dbg.day!==day){
  st.dbg={day,scans:1,eval:dbg.eval,brk:dbg.brk,volP:dbg.volP,
    cand:dbg.cand,entries:dbg.entries,exits:dbg.exits,kErr:dbg.kErr,
    nearSym:dbg.nearSym,nearR:dbg.nearR};
}else{
  const d=st.dbg;
  d.scans++;d.eval+=dbg.eval;d.brk+=dbg.brk;d.volP+=dbg.volP;
  d.cand+=dbg.cand;d.entries+=dbg.entries;d.exits+=dbg.exits;
  d.kErr+=dbg.kErr;
  if(dbg.nearR>d.nearR){d.nearR=dbg.nearR;d.nearSym=dbg.nearSym;}
}
saveState(st);

if(!events.length&&!manual)return[];
let html=manual?'<b>Donchian scan [manual]</b>\n':'<b>Donchian Scanner (info)</b>\n';
for(const e of events){
  if(e.type==='universe')html+='🔄 Universe '+st.month+': '+e.list.map(x=>x.replace('USDT','')).join(', ')+'\n';
  if(e.type==='entry'){html+='📈 ENTRY <b>'+e.sym.replace('USDT','')+'</b> @ '+e.entry+' | stop '+e.stop+' (−'+e.riskPct+'%) | score '+e.score+' | slot '+st.positions.length+'/'+SLOTS+'\n';
    if(e.book){let line='';
      if(e.book.agg){const g=e.book.agg;
        line='agg imb'+g.imb+' ±1% B$'+Math.round(g.b1/1e6)+'M/A$'+Math.round(g.a1/1e6)+'M ('+g.nVenues+'v)'
          +(g.wallsA.length?' | wallsA '+g.wallsA.slice(0,4).map(w=>'+'+w[0]+'%$'+Math.round(w[1]/1e6)+'M '+w[2]).join(','):'');}
      else{const v=(n,o)=>o?n+' imb'+o.imb+'±1% '+Math.round(o.b1/1e3)/1e3+'M/'+Math.round(o.a1/1e3)/1e3+'M':null;
        line=[v('Byb',e.book.bybit),v('Bin',e.book.binance),v('Btg',e.book.bitget)].filter(Boolean).join(' | ');}
      if(line)html+='📚 '+line+'\n';}}
  if(e.type==='exit')html+=(e.R>0?'✅':'❌')+' EXIT <b>'+e.sym.replace('USDT','')+'</b> '+e.R+'R ('+(e.reason||(e.hit?'TRAIL_HIT':'EXPIRY'))+', '+e.heldH+'h)\n';
  if(e.type==='watch')html+='👀 breakout '+e.brk+' → vol '+e.volP+' → cand '+e.cand+' | gates filtered it (no entry)\n';
  if(e.type==='digest'){
    html+='📊 <b>Digest '+e.day+'</b>\n24h: '+e.dN+' trades | '+e.dR+'R\nopen '+e.open.length+'/'+SLOTS+': '+(e.open.join(' ')||'—')+'\n30d concentration: '+e.conc+'\nholding ~'+e.avgHoldH+'h | trail '+(e.reasons.TRAIL_HIT||0)+'/expiry '+(e.reasons.EXPIRY||0)+' | slip~'+e.avgSlipPct+'%\n';
    if(e.pipe)html+='pipeline '+(e.pipeDay||'')+': scans '+e.pipe.scans+' | eval '+e.pipe.eval+' | brk '+e.pipe.brk+' | vol '+e.pipe.volP+' | cand '+e.pipe.cand+' | ent '+e.pipe.entries+' | ex '+e.pipe.exits+' | kErr '+e.pipe.kErr+' | near '+(e.pipe.nearSym?e.pipe.nearSym.replace('USDT','')+' '+(+e.pipe.nearR).toFixed(3):'—')+'\n';
  }
}
html+='⛓ scan: eval '+dbg.eval+' | brk '+dbg.brk+' | cand '+dbg.cand+' | ent '+dbg.entries+' | ex '+dbg.exits+' | pos '+st.positions.length+'/'+SLOTS+' | kErr '+dbg.kErr+' | near '+(dbg.nearSym?dbg.nearSym.replace('USDT','')+' '+dbg.nearR.toFixed(3):'—')+'\n';
html+='Σ '+st.stats.n+' trades | '+st.stats.sumR.toFixed(1)+'R | win '+st.stats.wins;
return[{json:{digest:html}}];
`;

const nodes = [
  {
    parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1, triggerAtMinute: 2 }] } },
    id: 'd-sch', name: 'Donchian Schedule',
    type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-400, 0]
  },
  {
    parameters: { httpMethod: 'POST', path: 'donchian', responseMode: 'onReceived', options: {}, webhookId: HOOK_ID },
    id: 'd-hook', name: 'Donchian Webhook',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-400, 200], webhookId: HOOK_ID
  },
  {
    parameters: { jsCode },
    id: 'd-code', name: 'Donchian Monitor',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, 0]
  },
  {
    parameters: {
      resource: 'message', operation: 'sendMessage', chatId: TG_CHAT_ID,
      text: '={{ $json.digest }}',
      additionalFields: { parse_mode: 'HTML' }
    },
    id: 'd-tg', name: 'Send Donchian',
    type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [100, 0],
    credentials: { telegramApi: { id: 'Ms0WDN8WVr6TdRtU', name: 'Telegram Bot' } }
  }
];
const connections = {
  'Donchian Schedule': { main: [[{ node: 'Donchian Monitor', type: 'main', index: 0 }]] },
  'Donchian Webhook': { main: [[{ node: 'Donchian Monitor', type: 'main', index: 0 }]] },
  'Donchian Monitor': { main: [[{ node: 'Send Donchian', type: 'main', index: 0 }]] }
};

const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
const UPDATE = process.argv.includes('--update');
const db = new DatabaseSync(DB);
db.exec('BEGIN');
if (UPDATE) {
  const wf = db.prepare(`SELECT id FROM workflow_entity WHERE name LIKE 'Donchian%'`).get();
  if (!wf) { console.error('workflow not found — run without --update first'); process.exit(1); }
  db.prepare(`INSERT INTO workflow_history
    (versionId,workflowId,authors,createdAt,updatedAt,nodes,connections,name,autosaved)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(VER_ID, wf.id, 'deploy_donchian.js --update', now, now,
      JSON.stringify(nodes), JSON.stringify(connections),
      'Donchian Scanner (info) v4.5.1', 0);
  db.prepare(`UPDATE workflow_entity SET nodes=?,connections=?,versionId=?,activeVersionId=?,updatedAt=? WHERE id=?`)
    .run(JSON.stringify(nodes), JSON.stringify(connections), VER_ID, VER_ID, now, wf.id);
  db.prepare(`UPDATE workflow_published_version SET publishedVersionId=?,updatedAt=? WHERE workflowId=?`)
    .run(VER_ID, now, wf.id);
  db.prepare(`UPDATE workflow_publication_trigger_status SET versionId=?,updatedAt=? WHERE workflowId=?`)
    .run(VER_ID, now, wf.id);
  console.log('updated workflow', wf.id, 'version', VER_ID);
} else {
  // cyclic FK entity<->history: insert entity with NULL, then history, then UPDATE
  db.prepare(`INSERT INTO workflow_entity
    (id,name,active,nodes,connections,settings,versionId,triggerCount,createdAt,updatedAt,isArchived,versionCounter,activeVersionId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
    .run(WF_ID, 'Donchian Scanner (info) v4.5.1', 1,
      JSON.stringify(nodes), JSON.stringify(connections),
      JSON.stringify({ executionOrder: 'v1' }), VER_ID, 0, now, now, 0, 1);
  db.prepare(`INSERT INTO workflow_history
    (versionId,workflowId,authors,createdAt,updatedAt,nodes,connections,name,autosaved)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(VER_ID, WF_ID, 'deploy_donchian.js', now, now,
      JSON.stringify(nodes), JSON.stringify(connections),
      'Donchian Scanner (info) v4.5.1', 0);
  db.prepare(`UPDATE workflow_entity SET activeVersionId=? WHERE id=?`)
    .run(VER_ID, WF_ID);
  db.prepare(`INSERT INTO workflow_published_version
    (workflowId,publishedVersionId,createdAt,updatedAt)
    VALUES (?,?,?,?)`)
    .run(WF_ID, VER_ID, now, now);
  console.log('inserted workflow', WF_ID, 'version', VER_ID);
}
db.exec('COMMIT');
db.close();

const snapshot = { name: 'Donchian Scanner (info) v4.5.1', nodes, connections };
fs.writeFileSync(path.join(__dirname, '..', 'workflow-donchian.json'),
  JSON.stringify(snapshot, null, 2).replaceAll(TG_CHAT_ID, 'YOUR_CHAT_ID'));
