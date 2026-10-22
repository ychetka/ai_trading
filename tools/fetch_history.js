#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// fetch_history.js — fetches 1H history into the data/klines/ cache for a symbol list.
// File format compatible with backtest_deep.js: {complete, bars:[{ts,o,h,l,c,v}]}.
//
//   node tools/fetch_history.js --from=2021-01-01 --syms=ADA,ETH,...  (or --all-legacy)
//   --all-legacy: all LinearPerpetual USDT with launchTime < 2022-06-01 (minus non-crypto)

const fs=require('fs'),path=require('path');
const CACHE=path.join(__dirname,'..','data','klines');
fs.mkdirSync(CACHE,{recursive:true});
const NON_CRYPTO=new Set(['PAXGUSDT','XAUUSDT','XAUTUSDT','XAGUSDT']);
const arg=k=>(process.argv.find(a=>a.startsWith(`--${k}=`))||'').split('=')[1];
const FROM=Date.parse(arg('from')||'2021-01-01T00:00:00Z');
const CONC=+(arg('conc')||5);

const api=async p=>{
  for(let t=0;t<5;t++){
    try{
      const r=await fetch('https://api.bybit.com'+p,{headers:{'User-Agent':'curl/8.0'}});
      const j=await r.json();
      if(j.retCode===0)return j.result;
      if(t===4)throw new Error(p+' -> '+j.retMsg);
    }catch(e){if(t===4)throw e;await new Promise(r=>setTimeout(r,1200*(t+1)));}
  }
};

async function klinesDeep(sym){
  const file=path.join(CACHE,`${sym}_60_${FROM}.json`);
  if(fs.existsSync(file)){
    const j=JSON.parse(fs.readFileSync(file));
    if(j.complete)return j.bars;
  }
  let end=Date.now(),bars=[];
  for(;;){
    const res=await api(`/v5/market/kline?category=linear&symbol=${sym}&interval=60`+
      `&start=${FROM}&end=${end}&limit=1000`);
    const list=(res.list||[]).map(r=>({ts:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]}));
    if(!list.length)break;
    bars=bars.concat(list);
    const earliest=Math.min(...list.map(x=>x.ts));
    if(earliest<=FROM)break;
    if(list.length<1000)break;          // hit the listing boundary
    end=earliest-1;
  }
  bars.sort((a,b)=>a.ts-b.ts);
  const seen=new Set();bars=bars.filter(b=>!seen.has(b.ts)&&seen.add(b.ts));
  const complete=!!(bars.length&&bars[0].ts<=FROM+2*3600e3);
  fs.writeFileSync(file,JSON.stringify({complete,bars}));
  return bars;
}

(async()=>{
  let syms;
  if(process.argv.includes('--all-legacy')){
    const res=await api('/v5/market/instruments-info?category=linear&limit=1000');
    const cut=Date.parse('2022-06-01T00:00:00Z');
    syms=res.list.filter(i=>i.contractType==='LinearPerpetual'&&i.symbol.endsWith('USDT')
      &&i.status==='Trading'&&+i.launchTime<cut&&!NON_CRYPTO.has(i.symbol))
      .map(i=>i.symbol);
  }else{
    syms=arg('syms').split(',').map(s=>s.trim()+'USDT').filter(s=>!NON_CRYPTO.has(s));
  }
  console.log(`universe: ${syms.length} symbols, from ${new Date(FROM).toISOString().slice(0,10)}`);
  let done=0;
  for(let i=0;i<syms.length;i+=CONC){
    await Promise.allSettled(syms.slice(i,i+CONC).map(async s=>{
      const b=await klinesDeep(s);
      done++;
      process.stdout.write(`\r[${done}/${syms.length}] ${s}: ${b.length} bars   `);
    }));
  }
  console.log('\ndone');
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
