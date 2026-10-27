#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// backtest_donchian.js — Volatility Expansion / Donchian breakout.
//
// Hypothesis v6.1 (rank 2): breakout of an N-bar range from a
// volatility-squeeze phase → inertial burst (counterparty liquidations +
// momentum bots). WR ~35-40%, R:R 3.5-5.5.
//
// Long: close > max(High, N)[prev bar] && vol > 1.5×SMA20.
// Squeeze filter: bandwidth = (upper-lower)/SMA(close,N) < 20% quantile over 300 bars.
// Stop: entry − 2.5×ATR(14). Trail: max(hardStop, min(Low, N/2)).
// Short — mirrored. Entry at the signal bar close (conservative: slippage
// not modelled — reality is worse).
//
// Flags: --n=96 --atr=2.5 --nosqueeze --side=both|long|short --from=...
// Data: data/klines cache (fetch_history.js / backtest_deep.js).

const fs=require('fs'),path=require('path');
const CACHE=path.join(__dirname,'..','data','klines');
const arg=k=>(process.argv.find(a=>a.startsWith(`--${k}=`))||'').split('=')[1];
const FROM=Date.parse(arg('from')||'2021-01-01T00:00:00Z');
const N=+(arg('n')||96), ATRK=+(arg('atr')||2.5), EXITN=Math.max(4,Math.floor(N/2));
const SQUEEZE=!process.argv.includes('--nosqueeze');
const SIDE=arg('side')||'both';
const SYMS=(arg('syms')||'BTC,ETH,SOL,ADA,XRP,DOGE,LINK,LTC,BNB,AVAX,DOT,ATOM')
  .split(',').map(s=>s.trim()+'USDT');

const load=sym=>{
  const f=path.join(CACHE,`${sym}_60_${FROM}.json`);
  if(!fs.existsSync(f))return null;
  return JSON.parse(fs.readFileSync(f)).bars;
};
function symTest(bars,sym,rows){
  const n=bars.length;
  // precompute: ATR14, SMA20 vol, SMA close N, bandwidth, rolling 20% quantile
  const atr=new Array(n).fill(NaN),vSma=new Array(n).fill(NaN),
        cSma=new Array(n).fill(NaN),up=new Array(n).fill(NaN),
        dn=new Array(n).fill(NaN);
  let trS=0,vS=0,cS=0;
  const win=[],trs=[];
  for(let i=0;i<n;i++){
    const b=bars[i];
    const tr=i?Math.max(b.h-b.l,Math.abs(b.h-bars[i-1].c),Math.abs(b.l-bars[i-1].c)):b.h-b.l;
    trs.push(tr);
    trS+=tr;vS+=b.v;cS+=b.c;
    if(i>=14)trS-=trs[i-14];
    if(i>=20)vS-=bars[i-20].v;
    if(i>=N)cS-=bars[i-N].c;
    if(i>=14)atr[i]=trS/14;
    if(i>=20)vSma[i]=vS/20;
    if(i>=N)cSma[i]=cS/N;
    if(i>=N){
      let mx=-Infinity,mn=Infinity;
      for(let j=i-N;j<i;j++){if(bars[j].h>mx)mx=bars[j].h;if(bars[j].l<mn)mn=bars[j].l;}
      up[i]=mx;dn[i]=mn;
      win.push((mx-mn)/cSma[i]);
      if(win.length>300)win.shift();
    }
  }
  const q20=x=>{const s=[...x].sort((a,b)=>a-b);return s[Math.floor(s.length*0.2)];};
  let inTrade=null;
  for(let i=N+1;i<n;i++){
    const b=bars[i];
    if(inTrade){
      const {side,stop0,entry,risk}=inTrade;
      // trail: long → max(hard, min(low,EXITN) over previous bars)
      let mx=-Infinity,mn=Infinity;
      for(let j=Math.max(0,i-EXITN);j<i;j++){
        if(bars[j].l<mn)mn=bars[j].l;if(bars[j].h>mx)mx=bars[j].h;}
      const effStop=side>0?Math.max(stop0,mn):Math.min(stop0,mx);
      const hit=side>0?b.l<=effStop:b.h>=effStop;
      if(hit){
        const R=side>0?(effStop-entry)/risk:(entry-effStop)/risk;
        rows.push({sym,ts:bars[inTrade.i].ts,side,R,out:R>0?'win':'sl',
          sq:inTrade.sq});
        inTrade=null;
      }else if(i-inTrade.i>960){   // 40-day holding cap
        const R=side>0?(b.c-entry)/risk:(entry-b.c)/risk;
        rows.push({sym,ts:bars[inTrade.i].ts,side,R,out:'exp'});
        inTrade=null;
      }
      if(inTrade)continue;
    }
    // entry
    if(!Number.isFinite(atr[i])||!Number.isFinite(up[i])||!Number.isFinite(vSma[i]))
      {continue;}
    const bw=(up[i]-dn[i])/cSma[i];
    const sq=SQUEEZE?bw<=q20(win):true;
    const volOK=b.v>1.5*vSma[i];
    if(SIDE!=='short'&&b.c>up[i]&&volOK&&sq){
      const stop=b.c-ATRK*atr[i],risk=b.c-stop;
      if(risk>0)inTrade={side:1,i,entry:b.c,stop0:stop,risk,sq};
    }else if(SIDE!=='long'&&b.c<dn[i]&&volOK&&sq){
      const stop=b.c+ATRK*atr[i],risk=stop-b.c;
      if(risk>0)inTrade={side:-1,i,entry:b.c,stop0:stop,risk,sq};
    }
  }
}

const rows=[];
for(const s of SYMS){
  const bars=load(s);
  if(!bars){console.log(`  ${s}: no cache`);continue;}
  symTest(bars,s,rows);
}
const agg=rs=>({n:rs.length,w:rs.filter(r=>r.R>0).length,
  R:rs.reduce((a,r)=>a+r.R,0)});
const a=agg(rows);
console.log(`=== DONCHIAN N=${N} exit=${EXITN} atr=${ATRK} `+
  `squeeze=${SQUEEZE} side=${SIDE} | ${SYMS.length} sym ===`);
console.log(`trades=${a.n} | R=${a.R.toFixed(1)} | R/trade=${a.n?(a.R/a.n).toFixed(2):'-'}`+
  ` | WR=${a.n?(a.w/a.n*100).toFixed(0):'-'}%`);
for(const k of ['long','short','squeeze','year','sym']){
  const m={};
  for(const r of rows){
    const key=k==='long'?(r.side>0?'long':'-'):k==='short'?(r.side<0?'short':'-')
      :k==='squeeze'?String(r.sq):k==='sym'?r.sym:new Date(r.ts).getUTCFullYear();
    (m[key]=m[key]||[]).push(r);
  }
  console.log(`— ${k} —`);
  for(const[key,rs]of Object.entries(m)
      .sort((x,y)=>k==='sym'?y[1].reduce((a,r)=>a+r.R,0)-x[1].reduce((a,r)=>a+r.R,0):0)){
    if(key==='-')continue;
    const s=agg(rs);
    console.log(`  ${key}: n=${s.n} wr=${(s.w/s.n*100).toFixed(0)}% `+
      `R=${s.R.toFixed(1)} (${(s.R/s.n).toFixed(2)}R)`);
  }
}
