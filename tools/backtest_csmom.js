#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// backtest_csmom.js — Cross-Sectional Momentum (relative strength) L/S.
//
// Hypothesis v6.0: retail buys what fell and shorts what rises; the
// durable edge is the opposite — long the strongest vs BTC, short the weakest.
//
// Signal at bar t: score_i = ROC_i(L) / σ_i(1h returns, L).
// Long top-K, short bottom-K. Rebalance every F hours, enter at next bar open.
// BTC gate: close < EMA200(1H) → shorts only (bear regime).
// Fee: taker 0.055% per side on each leg.
//
// Flags: --lb=24,72,168 --freq=24 --k=2 --longonly --from=2021-01-01
// Data: data/klines/*_60_*.json cache (built by backtest_deep.js).

const fs=require('fs'),path=require('path');
const CACHE=path.join(__dirname,'..','data','klines');
const arg=k=>(process.argv.find(a=>a.startsWith(`--${k}=`))||'').split('=')[1];
const FROM=Date.parse(arg('from')||'2021-01-01T00:00:00Z');
const LBS=(arg('lb')||'24,72,168').split(',').map(Number);
const FREQS=(arg('freq')||'24').split(',').map(Number);
const K=+(arg('k')||2), LONGONLY=!!process.argv.includes('--longonly');
const FEE=arg('fee')?+arg('fee'):0.00055;
const SLIPK=arg('slipk')?+arg('slipk'):0.03;   // slip=max(10bps,K*ATR/px); --slipk=0 → ideal execution
const NEXTOPEN=process.argv.includes('--nextopen'); // fill at open[t+1] instead of close[t]
const TOPK=arg('topk')?+arg('topk'):null;      // rolling top-K by 30d turnover
const SYMS=(arg('syms')
  ?arg('syms').split(',').map(s=>{s=s.trim();return s.endsWith('USDT')?s:s+'USDT';})
  :fs.readdirSync(CACHE).filter(f=>f.endsWith(`_60_${FROM}.json`)).map(f=>f.split('_')[0]));

const load=sym=>{
  const f=path.join(CACHE,`${sym}_60_${FROM}.json`);
  if(!fs.existsSync(f))return null;
  const j=JSON.parse(fs.readFileSync(f));
  return j.bars;
};

// ts→idx map + precompute atr14 and tv30 for frictions/rotation
const series={};
for(const s of SYMS){
  const b=load(s);if(!b)continue;
  const n=b.length,atr=new Array(n).fill(NaN),tv=new Array(n).fill(NaN);
  let tS=0,tvA=0;const trs=[];
  for(let i=0;i<n;i++){
    const x=b[i];
    const tr=i?Math.max(x.h-x.l,Math.abs(x.h-b[i-1].c),Math.abs(x.l-b[i-1].c)):x.h-x.l;
    trs.push(tr);tS+=tr;tvA+=x.v*x.c;
    if(i>=14)tS-=trs[i-14];
    if(i>=720)tvA-=b[i-720].v*b[i-720].c;
    if(i>=14)atr[i]=tS/14;
    if(i>=720)tv[i]=tvA/720;
  }
  series[s]={bars:b,idx:new Map(b.map((x,i)=>[x.ts,i])),atr,tv};
}
const btc=series['BTCUSDT'];
if(!btc){console.error('no BTC cache — run backtest_deep.js first');process.exit(1);}

// shared hourly grid (BTC bars as reference)
const grid=btc.bars.map(b=>b.ts);
// BTC EMA200(1H)
const ema200=grid.map((_,i)=>{
  const k=2/201;let e=btc.bars[0].c;
  for(let j=0;j<=i;j++)e=btc.bars[j].c*k+e*(1-k);
  return e;
});

const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const std=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)*(x-m))));};

// rolling universe: monthly re-rank of top-TOPK by 30d turnover (with --topk)
const mOf=t=>{const d=new Date(t);return d.getUTCFullYear()*12+d.getUTCMonth();};
function eligSet(ts){
  const scored=[];
  for(const s in series){
    const S=series[s];let i=S.idx.get(ts);
    if(i===undefined){let lo=0,hi=S.bars.length-1,ans=-1;
      while(lo<=hi){const m=(lo+hi)>>1;if(S.bars[m].ts<=ts){ans=m;lo=m+1;}else hi=m-1;}
      i=ans;}
    if(i<0)continue;
    const tv=S.tv[i];
    if(Number.isFinite(tv)&&tv>0)scored.push([tv,s]);
  }
  scored.sort((a,b)=>b[0]-a[0]);
  return new Set(scored.slice(0,TOPK).map(x=>x[1]));
}

function run(L,F){
  const pos=new Map();          // sym → {side:+1|-1, entry}
  let equity=1,peak=1,maxDD=0,fees=0,drag=0,turns=0;
  const curve=[];
  let cur=null,curM=-1;
  // leg drag: model price close[t], real fill differs.
  // entry: long buys px*(1+s), short sells px*(1−s); exit mirrored.
  // px = open[t+1] (nextopen) or close[t]. ≥0 = cost.
  const dragLeg=(sym,side,gi,entry)=>{
    const S=series[sym],i=S.idx.get(grid[gi]);
    if(i===undefined)return 0;
    const c=S.bars[i].c;
    const slip=SLIPK>0?Math.max(0.001,SLIPK*S.atr[i]/c):0;
    const px=NEXTOPEN&&i+1<S.bars.length?S.bars[i+1].o:c;
    const fill=entry?px*(1+side*(slip+FEE)):px*(1-side*(slip+FEE));
    return (entry?1:-1)*side*(fill-c)/c;
  };
  for(let gi=0;gi<grid.length;gi++){
    const ts=grid[gi];
    // PnL of open legs over this bar (close-to-close)
    for(const[sym,p]of pos){
      const s=series[sym];const i=s.idx.get(ts);
      if(i===undefined||i===0)continue;
      const r=(s.bars[i].c-s.bars[i-1].c)/s.bars[i-1].c;
      equity*=1+p.side*r/(2*K);   // equal share per leg: 2K legs
    }
    if(equity>peak)peak=equity;
    const dd=(peak-equity)/peak;if(dd>maxDD)maxDD=dd;
    if(gi%24===0)curve.push({ts,eq:equity});
    // rebalance at bar close: new positions from the next bar
    if(gi<L||gi%F!==0||gi>=grid.length-2)continue;
    if(TOPK){const m=mOf(ts);if(m!==curM){curM=m;cur=eligSet(ts);}}
    // ranking
    const scored=[];
    for(const s of SYMS){
      if(cur&&!cur.has(s))continue;
      const ser=series[s];if(!ser)continue;
      const i=ser.idx.get(ts);if(i===undefined||i-L<0)continue;
      const c=ser.bars;
      const roc=(c[i].c-c[i-L].c)/c[i-L].c;
      const rets=[];for(let j=i-L+1;j<=i;j++)rets.push((c[j].c-c[j-1].c)/c[j-1].c);
      const v=std(rets)||1e-9;
      scored.push({s,score:roc/v});
    }
    if(scored.length<6)continue;
    scored.sort((a,b)=>b.score-a.score);
    const bear=btc.bars[gi].c<ema200[gi];
    const longs=scored.slice(0,K).map(x=>x.s);
    const shorts=LONGONLY?[]:scored.slice(-K).map(x=>x.s);
    const want=new Map();
    if(!bear)for(const s of longs)want.set(s,1);
    for(const s of shorts)want.set(s,-1);
    // close legs not in the list: exit drag
    for(const[sym,p]of [...pos]){
      if(!want.has(sym)){
        const d=dragLeg(sym,p.side,gi,false);equity*=1-d/(2*K);drag+=d/(2*K);fees+=FEE/(2*K);
        pos.delete(sym);turns++;}
    }
    // open missing legs: entry drag (+ exit on flip)
    for(const[sym,side]of want){
      const cur=pos.get(sym);
      if(!cur){
        const d=dragLeg(sym,side,gi,true);equity*=1-d/(2*K);drag+=d/(2*K);fees+=FEE/(2*K);
        pos.set(sym,{side});turns++;
      }
      else if(cur.side!==side){
        const d1=dragLeg(sym,cur.side,gi,false),d2=dragLeg(sym,side,gi,true);
        equity*=1-(d1+d2)/(2*K);drag+=(d1+d2)/(2*K);fees+=2*FEE/(2*K);
        pos.set(sym,{side});turns++;
      }
    }
  }
  // rebalance yield: simple proxy — equity growth between steps
  const rets=[];for(let i=1;i<curve.length;i++)rets.push((curve[i].eq-curve[i-1].eq)/curve[i-1].eq);
  const ann=Math.sqrt(365);          // daily step of the curve
  const sharpe=std(rets)>0?mean(rets)/std(rets)*ann:0;
  const ret=(equity-1)*100;
  // yearly returns
  const years={};
  for(const p of curve){
    const y=new Date(p.ts).getUTCFullYear();
    (years[y]=years[y]||[]).push(p.eq);
  }
  const yr={};
  for(const y in years){
    const a=years[y];
    yr[y]=(a[a.length-1]/a[0]-1)*100;
  }
  return{L,F,ret,sharpe,maxDD:maxDD*100,equity,fees:fees*100,drag:drag*100,turns,yr};
}

console.log(`=== CS-MOMENTUM | K=${K} ${LONGONLY?'long-only':'L/S'} | fee=${FEE*1e4}bps slipk=${SLIPK}${NEXTOPEN?' nextopen':''}${TOPK?` topk=${TOPK}`:''} | ${Object.keys(series).length} sym ===`);
console.log('L(h)  F(h)  Ret%    Sharpe  MaxDD%   fees%   drag%   turns');
for(const L of LBS){for(const F of FREQS){
  const r=run(L,F);
  console.log(`${String(L).padEnd(5)} ${String(F).padEnd(5)} `+
    `${r.ret.toFixed(1).padStart(7)} ${r.sharpe.toFixed(2).padStart(7)} `+
    `${r.maxDD.toFixed(1).padStart(7)} ${r.fees.toFixed(1).padStart(7)} ${r.drag.toFixed(1).padStart(7)} ${r.turns}`);
  console.log('   by year: '+Object.entries(r.yr).map(([y,v])=>`${y}:${v.toFixed(0)}%`).join(' '));
}}
// benchmarks
const b0=btc.bars[0],b1=btc.bars[btc.bars.length-1];
console.log(`\nBTC buy&hold: ${((b1.c-b0.c)/b0.c*100).toFixed(1)}% over window`);
