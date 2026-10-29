#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// deploy_books.js — workflow "Books Aggregator (svc)": order-book microservice.
// Branches:
//   GET /webhook/book?symbol=X     → live fan-out across 13 venues → agg+venues JSON
//   GET /webhook/book-history      → stored snapshots (hourly buckets)
//   GET /webhook/books-ui          → web UI (standalone HTML page)
//   Schedule 15min                 → collector: universe snapshots → JSONL (180d)
// Run with n8n STOPPED. Deploy: node tools/deploy_books.js
const path = require('path'), crypto = require('crypto');
const { deployWorkflow } = require('./lib/n8n-sqlite-deployer');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const DB = arg('db') || path.join(__dirname, '..', 'docker-data',
  'volumes/crypto-analyst_n8n_storage/_data/.n8n/database.sqlite');

const H1 = crypto.randomUUID(), H2 = crypto.randomUUID(), H3 = crypto.randomUUID(), H4 = crypto.randomUUID();

// ---------- shared adapter code (used by the live node and the collector) ----------
const ADAPTERS = String.raw`
const get=async url=>{try{return await helpers.httpRequest({method:'GET',url,json:true,timeout:8000});}catch(e){return null;}};
const post=async(url,body)=>{try{return await helpers.httpRequest({method:'POST',url,json:true,body,timeout:8000});}catch(e){return null;}};
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
const jobsFor=sym=>{
  const base=sym.replace(/USDT$/,'');
  return{
  bybit_p:async()=>{const j=await get('https://api.bybit.com/v5/market/orderbook?category=linear&symbol='+sym+'&limit=200');return j&&j.result?{b:j.result.b,a:j.result.a}:null;},
  binance_s:async()=>{const j=await get('https://data-api.binance.vision/api/v3/depth?symbol='+sym+'&limit=500');return j&&j.bids?{b:j.bids,a:j.asks}:null;},
  binance_f:async()=>{const j=await get('https://fapi.binance.com/fapi/v1/depth?symbol='+sym+'&limit=500');return j&&j.bids?{b:j.bids,a:j.asks}:null;},
  okx_sw:async()=>{const j=await get('https://www.okx.com/api/v5/market/books?instId='+base+'-USDT-SWAP&sz=100');return j&&j.data&&j.data[0]?{b:j.data[0].bids,a:j.data[0].asks}:null;},
  bitget_s:async()=>{const j=await get('https://api.bitget.com/api/v2/spot/market/orderbook?symbol='+sym+'&type=step0&limit=100');return j&&j.code==='00000'?{b:j.data.bids,a:j.data.asks}:null;},
  gate_s:async()=>{const j=await get('https://api.gateio.ws/api/v4/spot/order_book?currency_pair='+base+'_USDT&limit=100');return j&&j.bids?{b:j.bids,a:j.asks}:null;},
  kraken_s:async()=>{const pair=sym==='BTCUSDT'?'XBTUSDT':sym;const j=await get('https://api.kraken.com/0/public/Depth?pair='+pair+'&count=100');const r=j&&j.result?j.result[Object.keys(j.result)[0]]:null;return r&&r.bids?{b:r.bids,a:r.asks}:null;},
  coinbase_s:async()=>{const j=await get('https://api.exchange.coinbase.com/products/'+base+'-USD/book?level=2');return j&&j.bids?{b:j.bids,a:j.asks}:null;},
  mexc_s:async()=>{const j=await get('https://api.mexc.com/api/v3/depth?symbol='+sym+'&limit=500');return j&&j.bids?{b:j.bids,a:j.asks}:null;},
  hl_p:async()=>{const j=await post('https://api.hyperliquid.xyz/info',{type:'l2Book',coin:base});
    const n=r=>(r||[]).map(x=>[x.px,x.sz]);return j&&j.levels&&j.levels[0]?{b:n(j.levels[0]),a:n(j.levels[1])}:null;},
  dydx_p:async()=>{const j=await get('https://indexer.dydx.trade/v4/orderbooks/perpetualMarket/'+base+'-USD');
    const n=r=>(r||[]).map(x=>[+x.price,+x.size]);return j&&j.bids?{b:n(j.bids),a:n(j.asks)}:null;},
  aster_f:async()=>{const j=await get('https://fapi.asterdex.com/fapi/v1/depth?symbol='+sym+'&limit=500');return j&&j.bids?{b:j.bids,a:j.asks}:null;},
  lighter_p:async()=>{const det=await get('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?filter=perp');
    const m=(det&&det.order_book_details||[]).find(x=>x.symbol===base);if(!m)return null;
    const j=await get('https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id='+m.market_id+'&limit=100');
    const n=r=>(r||[]).map(x=>[+x.price,+x.remaining_base_amount]);return j&&j.code===200?{b:n(j.bids),a:n(j.asks)}:null;}
};};
const snapAll=async sym=>{
  const jobs=jobsFor(sym),names=Object.keys(jobs);
  const res=await Promise.allSettled(names.map(n=>jobs[n]()));
  const venues={},wallsA=[],wallsB=[];
  let tb1=0,ta1=0,tb3=0,ta3=0;const mids=[];
  names.forEach((n,i)=>{
    const v=res[i].status==='fulfilled'?res[i].value:null;
    const s=v&&v.b&&v.b.length&&v.a&&v.a.length?sumBook(v.b,v.a):null;
    venues[n]=s;
    if(s){tb1+=s.b1;ta1+=s.a1;tb3+=s.b3;ta3+=s.a3;mids.push(s.mid);
      s.topA.forEach(w=>wallsA.push([w[0],w[1],n]));
      s.topB.forEach(w=>wallsB.push([w[0],w[1],n]));}
  });
  wallsA.sort((a,b)=>b[1]-a[1]);wallsB.sort((a,b)=>b[1]-a[1]);
  const mid=mids.length?+(mids.reduce((x,y)=>x+y)/mids.length).toPrecision(7):null;
  return{sym,ts:Date.now(),
    agg:{mid,b1:tb1,a1:ta1,b3:tb3,a3:ta3,
         imb:+(tb1/Math.max(ta1,1)).toFixed(2),nVenues:mids.length,
         wallsA:wallsA.slice(0,10),wallsB:wallsB.slice(0,10)},
    venues};
};
const slimVenues=v=>{const o={};for(const k in v)if(v[k])o[k]={mid:v[k].mid,b1:v[k].b1,a1:v[k].a1,imb:v[k].imb,topA:v[k].topA[0]||null,topB:v[k].topB[0]||null};return o;};
`;

// ---------- node 1: live aggregator ----------
const codeLive = String.raw`
const helpers=this.helpers;
const sym=(($input.first().json.query||{}).symbol||'BTCUSDT').toUpperCase();
${ADAPTERS}
return[{json:await snapAll(sym)}];
`;

// ---------- node 2: collector (schedule → universe snapshots → JSONL) ----------
const codeCollect = String.raw`
const helpers=this.helpers,fs=require('fs');
const HIST='/home/node/.n8n/books_history.jsonl';
const SVC='/home/node/.n8n/books_svc_state.json';
const uni=(()=>{try{return JSON.parse(fs.readFileSync('/home/node/.n8n/donchian_state.json','utf8')).universe||[];}catch(e){return[];}})();
const syms=[...new Set([...uni,'BTCUSDT','ETHUSDT','SOLUSDT'])];
${ADAPTERS}
const rows=[];
for(const sym of syms){
  try{const j=await snapAll(sym);
    if(j&&j.agg&&j.agg.nVenues>0)rows.push({ts:j.ts,sym,agg:j.agg,venues:slimVenues(j.venues)});
  }catch(e){}
  await new Promise(r=>setTimeout(r,300));
}
// market regime tag (issue #29): stratify all forward stats by regime
const regime=await(async()=>{try{
  const tk=await get('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT');
  const t0=((tk&&tk.result&&tk.result.list)||[])[0]||{};
  const kl=await get('https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=D&limit=32');
  const cls=((kl&&kl.result&&kl.result.list)||[]).map(r=>+r[4]).filter(v=>v>0).slice(1);  // drop unclosed daily bar
  const last=cls[0],prev=cls.slice(1,31);
  const sma=prev.length?prev.reduce((a,b)=>a+b,0)/prev.length:null;
  const rets=[];for(let i=0;i<Math.min(14,cls.length-1);i++)rets.push(Math.log(cls[i]/cls[i+1]));
  const rm=rets.length?rets.reduce((a,b)=>a+b,0)/rets.length:0;
  const vol=rets.length>1?Math.sqrt(rets.reduce((a,b)=>a+(b-rm)**2,0)/(rets.length-1))*100:null;
  const chg30=last&&sma?(last/sma-1)*100:null;
  return{btcChg24h:t0.price24hPcnt===undefined?null:+(+t0.price24hPcnt*100).toFixed(2),
    btcFunding:t0.fundingRate===undefined?null:+t0.fundingRate,
    btcChg30d:chg30===null?null:+chg30.toFixed(2),
    btcVol:vol===null?null:+vol.toFixed(2),
    regime:chg30===null?'unknown':chg30<=-7?'bear':chg30>=7?'bull':'neutral'};
}catch(e){return null;}})();
if(regime)rows.forEach(r=>r.regime=regime);
// wall persistence tracker: snapshot walls -> absolute-price chains (issue #25)
// (runs BEFORE the history append so persistWalls lands in the JSONL record)
const WST='/home/node/.n8n/walls_state.json', WEV='/home/node/.n8n/wall_events.jsonl';
const ws=(()=>{try{return JSON.parse(fs.readFileSync(WST,'utf8'));}catch(e){return{chains:[]};}})();
ws.chains=ws.chains||[];
const WMIN=500000,WDIST=0.3,WBAND=0.75,WTOUCH=0.35;
const wEvents=[];
for(const r of rows){
  const mid=r.agg.mid;if(!mid)continue;
  const wl=[...(r.agg.wallsA||[]).map(w=>({side:'A',pct:w[0],usd:w[1]})),
            ...(r.agg.wallsB||[]).map(w=>({side:'B',pct:w[0],usd:w[1]}))]
    .filter(w=>w.usd>=WMIN&&Math.abs(w.pct)>=WDIST)
    .map(w=>({...w,px:mid*(1+w.pct/100)}));
  const seen=new Set();
  for(const w of wl){
    let best=null,bd=1e9;
    ws.chains.forEach((c,j)=>{
      if(c.sym!==r.sym||c.side!==w.side||seen.has(j))return;
      const d=Math.abs(w.px/c.px-1)*100;
      if(d<bd){best=j;bd=d;}});
    if(best!==null&&bd<=WBAND){seen.add(best);const c=ws.chains[best];
      c.lastSeen=r.ts;c.n=(c.n||1)+1;c.usdMax=Math.max(c.usdMax||0,w.usd);}
    else ws.chains.push({sym:r.sym,side:w.side,px:w.px,usdMax:w.usd,start:r.ts,lastSeen:r.ts,n:1,touched:false});
  }
  for(let j=ws.chains.length-1;j>=0;j--){
    const c=ws.chains[j];
    if(c.sym!==r.sym)continue;
    if(Math.abs(mid/c.px-1)*100<=WTOUCH)c.touched=true;
    let out=null;
    if(c.side==='A'&&mid>c.px)out='break';
    else if(c.side==='B'&&mid<c.px)out='break';
    else if(c.lastSeen<r.ts)out=c.touched?'hold':'pull';
    if(out){
      wEvents.push({type:'wall',sym:c.sym,side:c.side,px:+c.px.toPrecision(7),usd:c.usdMax,
        persistMin:Math.round((c.lastSeen-c.start)/60000)+15,touched:c.touched,outcome:out,
        regime:regime&&regime.regime,ts:r.ts});
      ws.chains.splice(j,1);
    }
  }
  r.agg.persistWalls=ws.chains.filter(c=>c.sym===r.sym)
    .map(c=>({side:c.side,px:+c.px.toPrecision(7),usd:c.usdMax,persistMin:Math.round((r.ts-c.start)/60000)+15}))
    .filter(c=>c.persistMin>=120);
}
// staleness: chains for symbols no longer scanned never refresh - close them.
// gated on rows.length: an empty run (collector outage) must not wipe the state.
if(rows.length){
  const scanned=new Set(rows.map(r=>r.sym));
  const nowT=rows[rows.length-1].ts;
  for(let j=ws.chains.length-1;j>=0;j--){
    const c=ws.chains[j];
    if(scanned.has(c.sym))continue;
    if(nowT-c.lastSeen>120*60000){
      wEvents.push({type:'wall',sym:c.sym,side:c.side,px:+c.px.toPrecision(7),usd:c.usdMax,
        persistMin:Math.round((c.lastSeen-c.start)/60000)+15,touched:!!c.touched,
        outcome:c.touched?'hold':'pull',regime:regime&&regime.regime,ts:nowT});
      ws.chains.splice(j,1);
    }
  }
}
if(rows.length)fs.appendFileSync(HIST,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
if(wEvents.length)try{fs.appendFileSync(WEV,wEvents.map(e=>JSON.stringify(e)).join('\n')+'\n');}catch(e){}
try{fs.writeFileSync(WST+'.tmp',JSON.stringify({chains:ws.chains.slice(-400)}));fs.renameSync(WST+'.tmp',WST);}catch(e){}
// rotation: once a day drop everything older than 180 days
const day=new Date().toISOString().slice(0,10);
const st=(()=>{try{return JSON.parse(fs.readFileSync(SVC,'utf8'));}catch(e){return{};}})();
if(st.pruneDay!==day){
  try{
    const cut=Date.now()-180*86400e3;
    for(const f of [HIST,WEV])try{
      const lines=fs.readFileSync(f,'utf8').split('\n').filter(l=>{
        if(!l)return false;try{return JSON.parse(l).ts>cut;}catch(e){return false;}});
      fs.writeFileSync(f,lines.join('\n')+(lines.length?'\n':''));
    }catch(e){}
  }catch(e){}
  st.pruneDay=day;fs.writeFileSync(SVC,JSON.stringify(st));
}
return[{json:{ok:rows.length,syms}}];
`;

// ---------- node 3: history ----------
const codeHist = String.raw`
const helpers=this.helpers,fs=require('fs');
const HIST='/home/node/.n8n/books_history.jsonl';
const q=$input.first().json.query||{};
const sym=(q.symbol||'BTCUSDT').toUpperCase();
const hours=Math.min(+(q.hours||48),720);
const since=Date.now()-hours*3600e3;
const pts=[];
try{
  for(const l of fs.readFileSync(HIST,'utf8').split('\n')){
    if(!l)continue;
    const r=JSON.parse(l);
    if(r.sym===sym&&r.ts>=since)pts.push(r);
  }
}catch(e){}
// hourly buckets
const buckets={};
for(const p of pts){
  const h=new Date(p.ts).toISOString().slice(0,13)+':00';
  (buckets[h]=buckets[h]||{n:0,imb:0,b1:0,a1:0,minMid:1/0,maxMid:0});
  const b=buckets[h];b.n++;b.imb+=p.agg.imb;b.b1+=p.agg.b1;b.a1+=p.agg.a1;
  b.minMid=Math.min(b.minMid,p.agg.mid);b.maxMid=Math.max(b.maxMid,p.agg.mid);
}
const hourly=Object.entries(buckets).sort().map(([h,b])=>({
  h,n:b.n,imb:+(b.imb/b.n).toFixed(2),
  b1:Math.round(b.b1/b.n),a1:Math.round(b.a1/b.n),minMid:b.minMid,maxMid:b.maxMid}));
// points (thinned to ~500)
const stride=Math.max(1,Math.ceil(pts.length/500));
const points=pts.filter((_,i)=>i%stride===0).map(p=>({ts:p.ts,imb:p.agg.imb,b1:p.agg.b1,a1:p.agg.a1,mid:p.agg.mid,nV:p.agg.nVenues}));
return[{json:{sym,hours,n:pts.length,hourly,points}}];
`;

// ---------- node 4: UI (HTML) ----------
const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Books Aggregator</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{background:#0d1117;color:#c9d1d9;font:14px/1.5 monospace;margin:0;padding:16px}
h1{color:#58a6ff;font-size:18px;margin:0 0 12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:14px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{padding:4px 8px;text-align:right;border-bottom:1px solid #21262d}
th{color:#8b949e;text-align:left}td:first-child{text-align:left}
select,button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:6px 12px;font:inherit}
button{cursor:pointer}button:hover{background:#30363d}
.pos{color:#3fb950}.neg{color:#f85149}.dim{color:#8b949e}
canvas{width:100%;height:160px;background:#0d1117}
</style></head><body>
<h1>📚 Books Aggregator — aggregated order-book depth (13 venues)</h1>
<div class="card">
 <select id="sym"></select>
 <button onclick="live()">Live snapshot</button>
 <span id="st" class="dim"></span>
 <div id="agg"></div>
</div>
<div class="card"><b>Per-venue breakdown</b><div id="ven"></div></div>
<div class="card"><b>imb history</b> <span class="dim">(15-min collector)</span>
 <select id="hrs" onchange="hist()"><option value="24">24h</option><option value="48" selected>48h</option><option value="168">7d</option></select>
 <canvas id="ch" width="1200" height="160"></canvas><div id="ht"></div></div>
<script>
const SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','ZECUSDT','NEARUSDT','ENAUSDT','HYPEUSDT','QUSDT','KORUUSDT'];
const sel=document.getElementById('sym');SYMS.forEach(s=>{const o=document.createElement('option');o.text=o.value=s;sel.appendChild(o);});
const fmtM=v=>v==null?'—':'$'+(v/1e6).toFixed(1)+'M';
const imb=v=>v==null?'—':'<span class="'+(v>1?'pos':v<1?'neg':'')+'">'+v+'</span>';
const walls=w=>(w||[]).map(x=>((x[0]>0?'+':'')+x[0]+'% $'+(x[1]/1e6).toFixed(1)+'M '+(x[2]||''))).join('<br>')||'—';
async function live(){
 document.getElementById('st').textContent='…loading (fan-out ~4s)';
 const d=await fetch('/webhook/book?symbol='+sel.value).then(r=>r.json());
 const a=d.agg;
 document.getElementById('st').textContent='updated '+new Date(d.ts).toLocaleTimeString();
 document.getElementById('agg').innerHTML='<h2>mid '+a.mid+' | imb '+imb(a.imb)+' | venues '+a.nVenues+'</h2>'
  +'±1%: B '+fmtM(a.b1)+' / A '+fmtM(a.a1)+' &nbsp; ±3%: B '+fmtM(a.b3)+' / A '+fmtM(a.a3)
  +'<br><br><b>ASK walls</b><br>'+walls(a.wallsA)+'<br><br><b>BID walls</b><br>'+walls(a.wallsB);
 let h='<table><tr><th>venue</th><th>mid</th><th>imb</th><th>b1</th><th>a1</th><th>wallA</th><th>wallB</th></tr>';
 for(const k in d.venues){const v=d.venues[k];
  const w=x=>x&&x.length&&x[0]?x[0][0]+'% $'+(x[0][1]/1e6).toFixed(1)+'M':'—';
  h+=v?'<tr><td>'+k+'</td><td>'+v.mid+'</td><td>'+imb(v.imb)+'</td><td>'+fmtM(v.b1)+'</td><td>'+fmtM(v.a1)+'</td><td>'+w(v.topA)+'</td><td>'+w(v.topB)+'</td></tr>'
      :'<tr><td>'+k+'</td><td colspan="6" class="dim">not listed</td></tr>';}
 document.getElementById('ven').innerHTML=h+'</table>';
}
async function hist(){
 const d=await fetch('/webhook/book-history?symbol='+sel.value+'&hours='+document.getElementById('hrs').value).then(r=>r.json());
 const c=document.getElementById('ch'),x=c.getContext('2d'),W=c.width,H=c.height;
 x.clearRect(0,0,W,H);
 if(d.points.length<2){x.fillStyle='#8b949e';x.fillText('no data yet — collector still accumulating',20,30);}
 else{
  const imbs=d.points.map(p=>p.imb),mn=Math.min(...imbs,0.5),mx=Math.max(...imbs,1.5);
  const X=i=>20+i*(W-40)/(d.points.length-1),Y=v=>H-15-(v-mn)*(H-30)/(mx-mn);
  x.strokeStyle='#30363d';x.beginPath();x.moveTo(20,Y(1));x.lineTo(W-20,Y(1));x.stroke();
  x.strokeStyle='#58a6ff';x.beginPath();d.points.forEach((p,i)=>i?x.lineTo(X(i),Y(p.imb)):x.moveTo(X(i),Y(p.imb)));x.stroke();
  x.fillStyle='#8b949e';x.fillText('imb '+mn.toFixed(2)+' … '+mx.toFixed(2)+' | '+d.points.length+' points',20,14);
 }
 let h='<table><tr><th>hour UTC</th><th>n</th><th>imb</th><th>B±1%</th><th>A±1%</th><th>mid min–max</th></tr>';
 d.hourly.slice(-24).reverse().forEach(b=>{h+='<tr><td>'+b.h+'</td><td>'+b.n+'</td><td>'+imb(b.imb)+'</td><td>'+fmtM(b.b1)+'</td><td>'+fmtM(b.a1)+'</td><td class="dim">'+b.minMid+' – '+b.maxMid+'</td></tr>';});
 document.getElementById('ht').innerHTML=h+'</table>';
}
live();hist();
</script></body></html>`;
const codeUI = 'const html=' + JSON.stringify(HTML_PAGE) + ';return[{json:{html}}];';

// ---------- node 5: persistent walls ----------
const codeWalls = String.raw`
const fs=require('fs');
const q=$input.first().json.query||{};
const want=(q.symbol||'').toUpperCase();
const minMin=+q.minMin>0?+q.minMin:120;
let ws={chains:[]};
try{ws=JSON.parse(fs.readFileSync('/home/node/.n8n/walls_state.json','utf8'));}catch(e){}
const now=Date.now();
let active=(ws.chains||[]).map(c=>({...c,persistMin:Math.round((now-c.start)/60000)+15}));
if(want)active=active.filter(c=>c.sym===want);
active=active.filter(c=>c.persistMin>=minMin).sort((a,b)=>b.persistMin-a.persistMin);
let events=[];
try{for(const l of fs.readFileSync('/home/node/.n8n/wall_events.jsonl','utf8').split('\n')){
  if(!l)continue;try{events.push(JSON.parse(l));}catch(e){}}}catch(e){}
if(want)events=events.filter(e=>e.sym===want);
return[{json:{active,activeCount:active.length,recentEvents:events.slice(-100)}}];
`;

const nodes = [
  {
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } },
    id: 'b-sch', name: 'Books Schedule',
    type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-400, -160]
  },
  {
    parameters: { jsCode: codeCollect },
    id: 'b-collect', name: 'Collect Snapshots',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, -160]
  },
  {
    parameters: { httpMethod: 'GET', path: 'book', responseMode: 'lastNode', options: {}, webhookId: H1 },
    id: 'b-hook', name: 'Books Webhook',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-400, 40], webhookId: H1
  },
  {
    parameters: { jsCode: codeLive },
    id: 'b-code', name: 'Books Aggregator',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, 40]
  },
  {
    parameters: { httpMethod: 'GET', path: 'book-history', responseMode: 'lastNode', options: {}, webhookId: H2 },
    id: 'b-hist-hook', name: 'History Webhook',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-400, 240], webhookId: H2
  },
  {
    parameters: { jsCode: codeHist },
    id: 'b-hist', name: 'History Code',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, 240]
  },
  {
    parameters: { httpMethod: 'GET', path: 'books-ui', responseMode: 'responseNode', options: {}, webhookId: H3 },
    id: 'b-ui-hook', name: 'UI Webhook',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-400, 440], webhookId: H3
  },
  {
    parameters: { jsCode: codeUI },
    id: 'b-ui', name: 'UI Page',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, 440]
  },
  {
    parameters: { respondWith: 'text', responseBody: '={{ $json.html }}',
      options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } } },
    id: 'b-resp', name: 'Respond HTML',
    type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.2, position: [60, 440]
  },
  {
    parameters: { httpMethod: 'GET', path: 'book-walls', responseMode: 'lastNode', options: {}, webhookId: H4 },
    id: 'b-wall-hook', name: 'Wall Webhook',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-400, 640], webhookId: H4
  },
  {
    parameters: { jsCode: codeWalls },
    id: 'b-wall', name: 'Wall Code',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [-160, 640]
  }
];
const connections = {
  'Books Schedule': { main: [[{ node: 'Collect Snapshots', type: 'main', index: 0 }]] },
  'Books Webhook': { main: [[{ node: 'Books Aggregator', type: 'main', index: 0 }]] },
  'History Webhook': { main: [[{ node: 'History Code', type: 'main', index: 0 }]] },
  'UI Webhook': { main: [[{ node: 'UI Page', type: 'main', index: 0 }]] },
  'UI Page': { main: [[{ node: 'Respond HTML', type: 'main', index: 0 }]] },
  'Wall Webhook': { main: [[{ node: 'Wall Code', type: 'main', index: 0 }]] }
};

deployWorkflow({
  dbPath: DB, name: 'Books Aggregator (svc)',
  nodes, connections, author: 'deploy_books.js',
  hooks: [
    ['book', 'GET', 'Books Webhook'],
    ['book-history', 'GET', 'History Webhook'],
    ['books-ui', 'GET', 'UI Webhook'],
    ['book-walls', 'GET', 'Wall Webhook'],
  ],
  triggers: [
    ['b-sch', 'in-memory'], ['b-hook', 'persisted'], ['b-hist-hook', 'persisted'],
    ['b-ui-hook', 'persisted'], ['b-wall-hook', 'persisted'], ['b-collect', 'persisted'],
    ['b-code', 'persisted'], ['b-hist', 'persisted'], ['b-ui', 'persisted'],
    ['b-wall', 'persisted'], ['b-resp', 'persisted'],
  ],
  snapshotPath: path.join(__dirname, '..', 'workflow-books.json'),
});
