#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// backtest_armed.js — retrospective test of EQL/EQH setups on Bybit 1H.
//
// Modes:
//   --mode=armed    anticipatory limit: LIMIT=mid(POC,OB), SL=OB−2t, TP1=POC
//   --mode=sweep    entry at the sweep-bar close, SL below sweep low, TP1=POC
//   --mode=sweep2   same, but only on the 2nd shelf pierce (multi-sweep)
// Flags:
//   --short         mirror: bars are inverted → EQL becomes EQH,
//                   all math (armed/sweep) works for shorts
//   --minmembers=N  armed only on pools with >=N touches
//   --bars=500 --top=50
//
// Conservative: within one bar the stop is checked before the take.
// Fees/slippage not included (reality is worse).
// Runtime guards (buyPct, OI, spread) are not reproduced.

const CONC=5, SWING_K=3, TOL_PCT=0.15;
const MIN_TURN=10e6, CLUSTER_AGE_MAX=96, REARM=3;
const IMP=1, SL_TICKS=2, TP2_PCT=3, SIM_BARS=96, BINS=40;
const NON_CRYPTO = new Set(`XAUUSDT XAUTUSDT XAGUSDT XPTUSDT XPDUSDT CLUSDT HGUSDT
SPXUSDT SPCXUSDT NDQUSDT DJIUSDT SNDKUSDT SOXLUSDT SOXSUSDT SKHYUSDT
SKHYNIXUSDT MSTRUSDT MRVLUSDT BZUSDT PLTRUSDT COINUSDT HOODUSDT AAPLUSDT
TSLAUSDT NVDAUSDT MSFTUSDT AMZNUSDT GOOGLUSDT METAUSDT AMDUSDT INTCUSDT
MUUSDT NFLXUSDT AVGOUSDT ORCLUSDT QCOMUSDT TXNUSDT SHOPUSDT UBERUSDT
PYPLUSDT SQUSDT ABNBUSDT BKNGUSDT DASHUSDT MELIUSDT SEUSDT BABAUSDT
JDUSDT PDDUSDT BIDUUSDT NIOUSDT XPEVUSDT LIUSDT TCOMUSDT FUTUUSDT
BEKEUSDT TMEUSDT BILIUSDT IQUSDT ZTOUSDT CRUSDT`.split(/\s+/));

const api = async (path) => {
  const r = await fetch('https://api.bybit.com' + path,
    { headers: { 'User-Agent': 'curl/8.0' } });
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(path + ' -> ' + j.retMsg);
  return j.result;
};
const klines = async (sym, limit) =>
  (await api(`/v5/market/kline?category=linear&symbol=${sym}&interval=60&limit=${limit}`))
    .list.map(r => ({ ts:+r[0], o:+r[1], h:+r[2], l:+r[3], c:+r[4], v:+r[5] }))
         .sort((a,b)=>a.ts-b.ts);
const neg = bars => bars.map(x=>
  ({ts:x.ts,o:-x.o,h:-x.l,l:-x.h,c:-x.c,v:x.v}));

const pocAt = (bars, end) => {
  const w = bars.slice(0, end + 1);
  let hi=-Infinity, lo=Infinity;
  for (const x of w) { if (x.h>hi) hi=x.h; if (x.l<lo) lo=x.l; }
  const step=(hi-lo)/BINS; if (!(step>0)) return NaN;
  const vols=new Array(BINS).fill(0);
  for (const x of w) {
    const tp=(x.h+x.l+x.c)/3;
    let bi=Math.floor((tp-lo)/step);
    if (bi>=BINS) bi=BINS-1; if (bi<0) bi=0; vols[bi]+=x.v;
  }
  let mi=0;
  for (let i=1;i<BINS;i++) if (vols[i]>vols[mi]) mi=i;
  return lo+(mi+0.5)*step;
};

const obAt = (bars, end) => {
  for (let i=end-3; i>=1; i--) {
    if (bars[i].c<bars[i].o) {
      let mx=bars[i+1].c;
      for (let j=2;j<=3&&i+j<=end;j++) mx=Math.max(mx,bars[i+j].c);
      if ((mx-bars[i].c)/bars[i].c*100>=IMP) return bars[i].l;
    }
  }
  return NaN;
};

const detect = (bars, survive=false) => {
  const n=bars.length, swingAt=[], confirmed=[], clusters=[], events=[];
  for (let i=SWING_K;i<n-SWING_K;i++){
    let lo=true;
    for(let k=1;k<=SWING_K;k++)
      if(bars[i-k].l<=bars[i].l||bars[i+k].l<=bars[i].l)lo=false;
    if(lo)swingAt[i]=bars[i].l;
  }
  const close=(a,b)=>Math.abs(a-b)/((a+b)/2)*100<=TOL_PCT;
  for(let i=0;i<n;i++){
    const s=i-SWING_K;
    if(swingAt[s]!==undefined){
      const p=swingAt[s];
      for(const prev of confirmed){
        if(!close(prev.p,p))continue;
        let cl=clusters.find(c=>c.died===undefined&&c.members.some(m=>m.i===prev.i));
        if(cl){cl.members.push({i:s,p});
               cl.level=cl.members.reduce((x,m)=>x+m.p,0)/cl.members.length;}
        else clusters.push({level:(prev.p+p)/2,members:[{i:prev.i,p},{i:s,p}],
                            born:i,died:undefined,fired:false,touches:0});
        break;
      }
      confirmed.push({i:s,p});
    }
    for(const c of clusters){
      if(c.died!==undefined)continue;
      if(i-c.born>CLUSTER_AGE_MAX){c.died=i;continue;}
      if(bars[i].c<c.level){c.died=i;continue;}
      if(bars[i].l<c.level&&bars[i].c>c.level){
        c.touches++; c.fired=true;
        events.push({bar:i,ts:bars[i].ts,type:'eql_sweep',
                     level:c.level,sweepLow:bars[i].l,touch:c.touches,
                     members:c.members.length});
        if(!survive)c.died=i;
      }
    }
  }
  return {events,clusters};
};

const armedAt = (bars, c, i) => {
  if (i<c.born||(c.died!==undefined&&i>=c.died)||i-c.born>CLUSTER_AGE_MAX)
    return false;
  const p=pocAt(bars,i);
  return Number.isFinite(p)&&bars[i].c>p&&c.level<p;
};

const floorTo=(v,s)=>Math.floor(v/s)*s;

const arg=(k)=>(process.argv.find(a=>a.startsWith(`--${k}=`))||'').split('=')[1];
const flag=(k)=>process.argv.includes(`--${k}`);
const BARS=+(arg('bars')||500), TOP=+(arg('top')||50);
const MODE=arg('mode')||'armed';           // armed|sweep|sweep2
const SHORT=flag('short');                  // EQH mirror
const MINMEM=+(arg('minmembers')||0);
const MINDIST=+(arg('mindist')||0);        // min pool↔POC distance, %
const MINWICK=+(arg('minwick')||0);        // min sweep-bar wick share (0-1)
const BTCLT=arg('btclt')?+arg('btclt'):null;     // enter only if BTC Δ24h < X%

(async () => {
  const tickers=(await api('/v5/market/tickers?category=linear')).list;
  const cands=tickers
    .filter(t=>/^[A-Z0-9]+USDT$/.test(t.symbol)&&!NON_CRYPTO.has(t.symbol))
    .filter(t=>+t.turnover24h>=MIN_TURN)
    .sort((a,b)=>+b.turnover24h-+a.turnover24h)
    .slice(0,TOP).map(t=>t.symbol);
  const instr=(await api('/v5/market/instruments-info?category=linear&limit=1000')).list;
  const tickOf={};
  for(const i of instr) tickOf[i.symbol]=+(i.priceFilter?.tickSize||0);

  // macro regime: BTC 24h/7d drift + position vs EMA200(1H)
  const btcBars=await klines('BTCUSDT',BARS);
  const btcChg={},btc7d={},btcTrend={};
  {
    const k=2/201; let ema=btcBars[0].c;
    for(let i=0;i<btcBars.length;i++){
      ema=btcBars[i].c*k+ema*(1-k);
      if(i>=24)btcChg[btcBars[i].ts]=(btcBars[i].c-btcBars[i-24].c)/btcBars[i-24].c*100;
      if(i>=168)btc7d[btcBars[i].ts]=(btcBars[i].c-btcBars[i-168].c)/btcBars[i-168].c*100;
      if(i>=200)btcTrend[btcBars[i].ts]=btcBars[i].c>ema?'above EMA200':'below EMA200';
    }
  }

  const stats={}, rows=[];
  for(let i=0;i<cands.length;i+=CONC){
    const res=await Promise.allSettled(cands.slice(i,i+CONC).map(async sym=>{
      const tick=tickOf[sym]; if(!tick) return;
      let bars=await klines(sym,BARS);
      if(SHORT) bars=neg(bars);
      const {events,clusters}=detect(bars,MODE==='sweep2');
      if(MODE==='armed'){
        for(const c of clusters){
          if(c.members.length<MINMEM)continue;
          let run=0;
          for(let b=c.born;b<bars.length-1;b++){
            if(armedAt(bars,c,b)){run++;
              if(run===1) fireArmed(sym,bars,c,b,tick);
            } else run=0;
          }
        }
      } else if(MODE==='reclaim'){
        for(const e of events.filter(e=>e.type==='eql_sweep'))
          fireReclaim(sym,bars,e,tick);
      } else {
        for(const e of events.filter(e=>e.type==='eql_sweep')){
          if(MODE==='sweep2'&&e.touch!==2)continue;
          fireSweep(sym,bars,e,tick);
        }
      }
    }));
    for(const r of res)if(r.status==='rejected')console.log('ERR:',r.reason?.message||r.reason);
  }

  console.log(`\n=== BACKTEST ${MODE}${SHORT?' (SHORT/EQH)':''}`+
    `${MINMEM?` minmembers=${MINMEM}`:''} | ${BARS} bars, ${cands.length} symbols ===`);
  const t=agg(rows);
  printSplit('by symbol (top by R)',symRows(),20);
  console.log(`\nTOTAL: signals=${rows.length} filled=${t.dec}`+
    ` | tp1=${t.tp1} tp2=${t.tp2} sl=${t.sl} open=${t.open} nofil=${t.nofil}`);
  console.log(`total R: ${t.R.toFixed(1)} | per trade: ${t.dec?(t.R/t.dec).toFixed(2):'-'}R | win rate: ${t.dec?(t.wins/t.dec*100).toFixed(0):'-'}%`);

  split('pool touch count',r=>r.members>=3?'3+':'2');
  split('pool↔POC distance, % of price',r=>{
    const d=r.dist; return d<1?'<1':d<2?'1-2':d<4?'2-4':'>4';
  });
  if(MODE!=='armed')
    split('sweep-bar lower wick, % of range',r=>r.wick===undefined?'-':r.wick>=0.5?'≥50%':'<50%');
  split('symbol trend Δ24h',r=>r.chg24<-3?'<-3%':'≥-3%');
  split('macro: BTC Δ24h',r=>r.btc24===undefined?'no data':r.btc24<-2?'<-2%':r.btc24>2?'>+2%':'flat');
  split('macro: BTC Δ7d',r=>r.btc7d===undefined?'no data':r.btc7d<-5?'<-5%':r.btc7d>5?'>+5%':'flat');
  split('macro: BTC vs EMA200(1H)',r=>r.btcTrend||'no data');
  split('combo: trend×Δ24h',r=>{
    if(!r.btcTrend||r.btc24===undefined)return 'no data';
    const p=r.btc24<-2?'panic':r.btc24>2?'euphoria':'flat';
    return `${r.btcTrend} / ${p}`;
  });

  function agg(rs){
    const a={dec:0,tp1:0,tp2:0,sl:0,open:0,nofil:0,degen:0,R:0,wins:0};
    for(const r of rs){
      if(r.out==='degen')a.degen++;
      else if(r.out==='open')a.open++;
      else if(r.out==='nofil')a.nofil++;
      else{a.dec++;a[r.out]++;a.R+=r.R;if(r.out!=='sl')a.wins++;}
    }
    return a;
  }
  function symRows(){
    const m={};
    for(const r of rows){
      const s=m[r.sym]||(m[r.sym]={sig:0,dec:0,wins:0,sl:0,R:0});
      s.sig++;
      if(r.out==='tp1'||r.out==='tp2'||r.out==='sl'){s.dec++;s.R+=r.R;
        if(r.out==='sl')s.sl++;else s.wins++;}
    }
    return Object.entries(m).sort((a,b)=>b[1].R-a[1].R);
  }
  function printSplit(label,data,lim){
    console.log(`sym          sig  dec  wins sl   R`);
    for(const[s,x]of data.slice(0,lim))
      console.log(`${s.padEnd(12)} ${String(x.sig).padEnd(4)} ${String(x.dec).padEnd(4)} ${String(x.wins).padEnd(4)} ${String(x.sl).padEnd(4)} ${x.R.toFixed(1)}`);
  }
  function split(label,keyfn){
    const m={};
    for(const r of rows){
      const k=keyfn(r);
      const s=m[k]||(m[k]={sig:0,dec:0,wins:0,R:0});
      s.sig++;
      if(r.out==='tp1'||r.out==='tp2'||r.out==='sl'){s.dec++;s.R+=r.R;
        if(r.out!=='sl')s.wins++;}
    }
    console.log(`\n— ${label}`);
    for(const[k,s]of Object.entries(m))
      console.log(`  ${k}: sig=${s.sig} dec=${s.dec} wr=${s.dec?(s.wins/s.dec*100).toFixed(0):'-'}% R=${s.R.toFixed(1)}`);
  }

  function row(sym,bars,i,out,R,c,poc,extra){
    const chg24=i>=24?(bars[i].c-bars[i-24].c)/bars[i-24].c*100:0;
    rows.push({sym,out,R,chg24,btc24:btcChg[bars[i].ts],
      btc7d:btc7d[bars[i].ts],btcTrend:btcTrend[bars[i].ts],
      members:c?c.members.length:0,
      dist:(c&&Number.isFinite(poc))?Math.abs(poc-c.level)/Math.abs(bars[i].c)*100:0,
      ...(extra||{})});
    const s=stats[sym]||(stats[sym]=[]);
    s.push({out,R});
  }

  // armed: anticipatory limit at mid(POC,OB)
  function fireArmed(sym,bars,c,i,tick){
    const ob=obAt(bars,i), poc=pocAt(bars,i);
    if(BTCLT!==null&&!(btcChg[bars[i].ts]<BTCLT))return;
    if(MINDIST&&Number.isFinite(poc)&&
       Math.abs(poc-c.level)/Math.abs(bars[i].c)*100<MINDIST)return;
    if(!(Number.isFinite(ob)&&Number.isFinite(poc)&&ob<poc)){
      row(sym,bars,i,'degen',0,c,poc);return;}
    const limit=floorTo((poc+ob)/2,tick), stop=floorTo(ob-SL_TICKS*tick,tick);
    const tp1=floorTo(poc,tick);
    const tp2=floorTo(poc*(1+(SHORT?-1:1)*TP2_PCT/100),tick);
    const risk=limit-stop;
    if(risk<=0){row(sym,bars,i,'degen',0,c,poc);return;}
    let out='open',R=0,filled=false;
    for(let j=i+1;j<Math.min(i+1+SIM_BARS,bars.length);j++){
      const b=bars[j];
      if(!filled){
        if(b.l<=stop){out='sl';R=-1;break;}
        if(b.l<=limit)filled=true;
        continue;
      }
      if(b.l<=stop){out='sl';R=-1;break;}
      if(b.h>=tp2){out='tp2';R=(tp2-limit)/risk;break;}
      if(b.h>=tp1){out='tp1';R=(tp1-limit)/risk;break;}
    }
    if(!filled&&out==='open'){out='nofil';R=0;}
    else if(out==='open')
      R=(bars[Math.min(i+SIM_BARS,bars.length)-1].c-limit)/risk;
    row(sym,bars,i,out,R,c,poc);
  }

  // sweep/sweep2: market entry at the sweep-bar close
  function fireSweep(sym,bars,e,tick){
    const i=e.bar, poc=pocAt(bars,i);
    if(BTCLT!==null&&!(btcChg[bars[i].ts]<BTCLT))return;
    const b0=bars[i];
    const wick=(b0.h-b0.l)>0?(Math.min(b0.o,b0.c)-b0.l)/(b0.h-b0.l):0;
    const ex={wick};
    if(MINWICK&&wick<MINWICK)return;
    if(!Number.isFinite(poc)||poc<=bars[i].c){row(sym,bars,i,'degen',0,e,poc,ex);return;}
    const limit=floorTo(bars[i].c,tick);
    const stop=floorTo(e.sweepLow-SL_TICKS*tick,tick);
    const tp1=floorTo(poc,tick);
    const tp2=floorTo(poc*(1+(SHORT?-1:1)*TP2_PCT/100),tick);
    const risk=limit-stop;
    if(risk<=0){row(sym,bars,i,'degen',0,e,poc,ex);return;}
    let out='open',R=(bars[Math.min(i+SIM_BARS,bars.length)-1].c-limit)/risk;
    for(let j=i+1;j<Math.min(i+1+SIM_BARS,bars.length);j++){
      const b=bars[j];
      if(b.l<=stop){out='sl';R=-1;break;}
      if(b.h>=tp2){out='tp2';R=(tp2-limit)/risk;break;}
      if(b.h>=tp1){out='tp1';R=(tp1-limit)/risk;break;}
    }
    row(sym,bars,i,out,R,e,poc,ex);
  }

  // reclaim: sweep → reclaim above the level → limit on level retest,
  // stop below sweep low, target POC. Wyckoff spring/retest.
  function fireReclaim(sym,bars,e,tick){
    const i=e.bar, poc=pocAt(bars,i);
    if(BTCLT!==null&&!(btcChg[bars[i].ts]<BTCLT))return;
    const b0=bars[i];
    const wick=(b0.h-b0.l)>0?(Math.min(b0.o,b0.c)-b0.l)/(b0.h-b0.l):0;
    const ex={wick};
    if(MINWICK&&wick<MINWICK)return;
    if(!Number.isFinite(poc)||poc<=b0.c){row(sym,bars,i,'degen',0,e,poc,ex);return;}
    const limit=floorTo(e.level,tick);
    const stop=floorTo(e.sweepLow-SL_TICKS*tick,tick);
    const tp1=floorTo(poc,tick);
    const tp2=floorTo(poc*(1+(SHORT?-1:1)*TP2_PCT/100),tick);
    const risk=limit-stop;
    if(risk<=0||tp1<=limit){row(sym,bars,i,'degen',0,e,poc,ex);return;}
    let out='open',R=0,filled=false;
    for(let j=i+1;j<Math.min(i+1+SIM_BARS,bars.length);j++){
      const b=bars[j];
      if(!filled){
        if(b.l<=stop){out='sl';R=-1;break;}
        if(b.l<=limit)filled=true;
        continue;
      }
      if(b.l<=stop){out='sl';R=-1;break;}
      if(b.h>=tp2){out='tp2';R=(tp2-limit)/risk;break;}
      if(b.h>=tp1){out='tp1';R=(tp1-limit)/risk;break;}
    }
    if(!filled&&out==='open'){out='nofil';R=0;}
    else if(out==='open')
      R=(bars[Math.min(i+SIM_BARS,bars.length)-1].c-limit)/risk;
    row(sym,bars,i,out,R,e,poc,ex);
  }
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
