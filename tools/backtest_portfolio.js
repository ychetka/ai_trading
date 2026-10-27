#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// backtest_portfolio.js — portfolio simulator for Donchian breakout.
//
// Honest execution model (quant-partner spec):
//   entry  = Open[t+1] × (1 + slip + fee),   slip = max(10bps, 3%×ATR%)
//   exit   = effStop   × (1 − slip − fee)    (mirrored for shorts)
// Capacity: max S simultaneous positions; on contention — top by
//   score = (vol/SMA20vol) / bwPercentile × RS_btc(Δ24h alt/Δ24h btc).
// FIFO: profitable positions are never closed to make room for new signals.
// Risk: riskFrac equity fraction per slot (R-normalized trades).
//
// Flags: --n=168 --slots=8 --risk=0.0075 --atr=2.5 --side=both|long|short
//        --from=2021-01-01

const fs=require('fs'),path=require('path');
const CACHE=path.join(__dirname,'..','data','klines');
const arg=k=>(process.argv.find(a=>a.startsWith(`--${k}=`))||'').split('=')[1];
const FROM=Date.parse(arg('from')||'2021-01-01T00:00:00Z');
const N=+(arg('n')||168),EXITN=Math.max(4,Math.floor(N/2)),ATRK=+(arg('atr')||2.5);
const SLOTS=+(arg('slots')||8),RISKF=+(arg('risk')||0.0075);
const SQ=+(arg('sq')||0.2);   // squeeze gate: bw-percentile <= SQ
const TOPK=+(arg('topk')||20);
const TVWIN=+(arg('tvwin')||720); // 30d of bars for the turnover rank
const SIDE=arg('side')||'both';
const CLOSE=process.argv.includes('--closeentry');
const FEE=arg('fee')?+arg('fee'):0.00055;
const SLIPK=arg('slipk')?+arg('slipk'):0.03;
const SYMS=arg('syms')
  ?arg('syms').split(',').map(s=>{s=s.trim();return s.endsWith('USDT')?s:s+'USDT';})
  :fs.readdirSync(CACHE).filter(f=>f.endsWith(`_60_${FROM}.json`)).map(f=>f.split('_')[0]);

const SKIP=Date.parse(arg('skip')||'1970-01-02T00:00:00Z');
const load=sym=>{
  const f=path.join(CACHE,`${sym}_60_${FROM}.json`);
  if(!fs.existsSync(f))return null;
  const bars=JSON.parse(fs.readFileSync(f)).bars;
  return SKIP>0?bars.filter(b=>b.ts>=SKIP):bars;
};

const series={};
for(const s of SYMS){const b=load(s);if(b)series[s]={bars:b,idx:new Map(b.map((x,i)=>[x.ts,i]))};}
const btc=series['BTCUSDT'].bars;
const grid=btc.map(b=>b.ts);
const btcIdx=new Map(btc.map((x,i)=>[x.ts,i]));

// per-symbol precompute: up/dn, atr, vSma, bw-percentile (rolling 300 window)
function pre(bars){
  const n=bars.length;
  const atr=new Array(n).fill(NaN),vS=new Array(n).fill(NaN),
        up=new Array(n).fill(NaN),dn=new Array(n).fill(NaN),
        bwP=new Array(n).fill(NaN),tv=new Array(n).fill(NaN);
  let tS=0,vA=0,tvA=0;const trs=[],win=[];
  for(let i=0;i<n;i++){
    const b=bars[i];
    const tr=i?Math.max(b.h-b.l,Math.abs(b.h-bars[i-1].c),Math.abs(b.l-bars[i-1].c)):b.h-b.l;
    trs.push(tr);tS+=tr;vA+=b.v;tvA+=b.v*b.c;
    if(i>=14)tS-=trs[i-14];
    if(i>=20)vA-=bars[i-20].v;
    if(i>=TVWIN)tvA-=bars[i-TVWIN].v*bars[i-TVWIN].c;
    if(i>=14)atr[i]=tS/14;
    if(i>=20)vS[i]=vA/20;
    if(i>=TVWIN)tv[i]=tvA/TVWIN;
    if(i>=N){
      let mx=-Infinity,mn=Infinity,cm=0;
      for(let j=i-N;j<i;j++){if(bars[j].h>mx)mx=bars[j].h;if(bars[j].l<mn)mn=bars[j].l;cm+=bars[j].c;}
      up[i]=mx;dn[i]=mn;
      const bw=(mx-mn)/(cm/N);
      win.push(bw);if(win.length>300)win.shift();
      const cnt=win.filter(x=>x<=bw).length;
      bwP[i]=cnt/win.length;
    }
  }
  return{atr,vS,up,dn,bwP,tv};
}
for(const s in series)series[s].pre=pre(series[s].bars);

// rolling universe: on the 1st bar of each month, top-TOPK by 30d turnover.
// Applies only without --syms (a static list bypasses rotation).
const ROLLING=!arg('syms');
const elig=new Array(grid.length).fill(null);
if(ROLLING){
  const mOf=t=>{const d=new Date(t);return d.getUTCFullYear()*12+d.getUTCMonth();};
  const bounds=[];
  for(let gi=0;gi<grid.length;gi++){
    if(gi===0||mOf(grid[gi])!==mOf(grid[gi-1]))bounds.push(gi);}
  for(const bgi of bounds){
    const ts=grid[bgi],scored=[];
    for(const s in series){
      const S=series[s];let i=S.idx.get(ts);
      if(i===undefined){ // last bar <= ts
        let lo=0,hi=S.bars.length-1,ans=-1;
        while(lo<=hi){const m=(lo+hi)>>1;if(S.bars[m].ts<=ts){ans=m;lo=m+1;}else hi=m-1;}
        i=ans;
      }
      if(i<0)continue;
      const tv=S.pre.tv[i];
      if(Number.isFinite(tv)&&tv>0)scored.push([tv,s]);
    }
    scored.sort((a,b)=>b[0]-a[0]);
    elig[bgi]=new Set(scored.slice(0,TOPK).map(x=>x[1]));
  }
  let cur=null;
  for(let gi=0;gi<grid.length;gi++){if(elig[gi])cur=elig[gi];elig[gi]=cur;}
}

const slipOf=(pre_i,close)=>{
  const a=pre_i.atr/close;
  return SLIPK>0?Math.max(0.001,SLIPK*a):0;
};

// collect signals at bar t → candidates
function signalsAt(t,gi){
  const out=[],cur=ROLLING?elig[gi]:null;
  for(const s in series){
    if(ROLLING&&(!cur||!cur.has(s)))continue;
    const S=series[s],i=S.idx.get(t);
    if(i===undefined||i<N+1||i>=S.bars.length-1)continue;
    const p=S.pre,b=S.bars[i];
    if(!Number.isFinite(p.atr[i])||!Number.isFinite(p.up[i]))continue;
    const volR=b.v/p.vS[i];
    if(!(volR>1.5))continue;
    if(!(p.bwP[i]<=SQ))continue;
    const rs=(()=>{const bi=btcIdx.get(t);
      if(bi===undefined||bi<24||i<24)return 1;
      const dAlt=(b.c-S.bars[i-24].c)/S.bars[i-24].c,
            dBtc=(btc[bi].c-btc[bi-24].c)/btc[bi-24].c;
      return dBtc!==0?dAlt/dBtc:1;})();
    const score=volR/Math.max(p.bwP[i],0.05)*Math.abs(rs);
    const side=b.c>p.up[i]?1:b.c<p.dn[i]?-1:0;
    if(!side)continue;
    if(SIDE==='long'&&side<0)continue;
    if(SIDE==='short'&&side>0)continue;
    out.push({s,i,side,score,atr:p.atr[i]});
  }
  return out.sort((a,b)=>b.score-a.score);
}

let equity=1,peak=1,maxDD=0;
const open=[];              // {s,i,side,entry,stop0,risk,slip}
const done=[];
for(let gi=0;gi<grid.length;gi++){
  const t=grid[gi];
  // 1) exits on this hour's bars
  for(let k=open.length-1;k>=0;k--){
    const pos=open[k],S=series[pos.s],i=S.idx.get(t);
    if(i===undefined)continue;
    const b=S.bars[i];
    let mx=-Infinity,mn=Infinity;
    for(let j=Math.max(0,i-EXITN);j<i;j++){
      if(S.bars[j].l<mn)mn=S.bars[j].l;if(S.bars[j].h>mx)mx=S.bars[j].h;}
    const eff=pos.side>0?Math.max(pos.stop0,mn):Math.min(pos.stop0,mx);
    const hit=pos.side>0?b.l<=eff:b.h>=eff;
    const expired=i-pos.i>960;
    if(hit||expired){
      const raw=hit?eff:b.c;
      const slip=SLIPK>0?Math.max(0.001,SLIPK*S.pre.atr[i]/b.c):0;
      const exit=pos.side>0?raw*(1-slip-FEE):raw*(1+slip+FEE);
      const R=pos.side>0?(exit-pos.entry)/pos.risk:(pos.entry-exit)/pos.risk;
      if(!Number.isFinite(R)){console.error('NaN-R',{s:pos.s,i,entry:pos.entry,risk:pos.risk});}
      equity*=1+R*RISKF;
      done.push({s:pos.s,side:pos.side,R,ts:t});
      open.splice(k,1);
    }
  }
  // 2) new entries: --closeentry = fill at signal bar close (fast bot);
  //    otherwise at next bar open (pessimistic model)
  const ni=gi+1;
  if(ni>=grid.length&&!CLOSE)continue;
  const cand=signalsAt(t,gi);
  for(const c of cand){
    if(open.length>=SLOTS)break;
    if(open.some(p=>p.s===c.s))continue;
    const S=series[c.s],ei=CLOSE?c.i:S.idx.get(grid[ni]);
    if(ei===undefined)continue;
    const ob=S.bars[ei];
    const slip=slipOf({atr:c.atr},S.bars[c.i].c);
    const px=CLOSE?S.bars[c.i].c:ob.o;
    const entry=c.side>0?px*(1+slip+FEE):px*(1-slip-FEE);
    const stop0=c.side>0?entry-ATRK*c.atr:entry+ATRK*c.atr;
    const risk=Math.abs(entry-stop0);
    if(!(risk>0))continue;
    open.push({s:c.s,i:ei,side:c.side,entry,stop0,risk});
  }
  if(equity>peak)peak=equity;
  const dd=(peak-equity)/peak;if(dd>maxDD)maxDD=dd;
}

const wins=done.filter(r=>r.R>0).length;
const sumR=done.reduce((a,r)=>a+r.R,0);
const taken=done.length;
const yrs={};
for(const r of done){
  const y=new Date(r.ts).getUTCFullYear();
  yrs[y]=(yrs[y]||0)+r.R*RISKF;
}
console.log(`=== PORTFOLIO Donchian N=${N} slots=${SLOTS} risk=${RISKF*100}% `+
  `side=${SIDE} | ${Object.keys(series).length} sym ===`);
console.log(`trades taken=${taken} | WR=${taken?(wins/taken*100).toFixed(0):'-'}%`+
  ` | ΣR=${sumR.toFixed(1)} | R/trade=${taken?(sumR/taken).toFixed(3):'-'}`);
console.log(`equity=${equity.toFixed(2)}x (${((equity-1)*100).toFixed(0)}%) `+
  `| MaxDD=${(maxDD*100).toFixed(1)}%`);
console.log('— by year (equity effect, %) —');
for(const y in yrs)console.log(`  ${y}: ${(yrs[y]*100).toFixed(1)}%`);
