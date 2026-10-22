#!/usr/bin/env node
// Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
// Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
// For commercial use, please contact the author.

// backtest_deep.js — deep-history validation of armed-longs with macro gates.
//
// Hypothesis v5.1: armed limit at mid(POC,OB) is profitable ONLY under
//   BTC bull regime (close4h>EMA200 && EMA50>EMA200) + panic.
//   In bear regime only extreme capitulation (Z<=-3.5) is allowed.
//
// History: /v5/market/kline paginated backwards from now to --from
// (2021-01-01), disk cache in data/klines/. No historical OI/funding —
// panic from price+volume: Δ24h<--panic or Z<=-2.5 && Vol>3×SMA48 (PTI proxy).
//
// Flags:
//   --from=2021-01-01   history start (UTC)
//   --syms=BTC,ETH,...  or the default list of long-listed majors
//   --pocwin=168        rolling-POC window (1H bars; 0 = cumulative like the old test)
//   --panic=-2          Δ24h threshold for the simple panic detector
//   --gate=NAME         bullpanic|bull|bear35|all — TOTAL filter (splits always computed)
//
// Output: regime×panic matrix, clustering into 48h episodes (N_eff),
// PnL on benchmark events 2021–2024.

const fs = require('fs');
const path = require('path');
const CACHE_DIR = path.join(__dirname, '..', 'data', 'klines');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const SWING_K=3, TOL_PCT=0.15, CLUSTER_AGE_MAX=96, SIM_BARS=96, BINS=40;
const IMP=1, SL_TICKS=2, TP2_PCT=3, EPISODE_H=48, MAX_PER_EPISODE=3;

const arg=(k)=>(process.argv.find(a=>a.startsWith(`--${k}=`))||'').split('=')[1];
const FROM=Date.parse(arg('from')||'2021-01-01T00:00:00Z');
const POCWIN=+(arg('pocwin')||168);
const PANIC=+(arg('panic')||-2);
const GATE=arg('gate')||'all';
const SYMS=(arg('syms')||'BTC,ETH,SOL,ADA,XRP,DOGE,LINK,LTC,BNB,AVAX,DOT,ATOM')
  .split(',').map(s=>s.trim()+'USDT');

const api = async (p) => {
  for(let t=0;t<4;t++){
    try{
      const r=await fetch('https://api.bybit.com'+p,{headers:{'User-Agent':'curl/8.0'}});
      const j=await r.json();
      if(j.retCode===0)return j.result;
      if(t===3)throw new Error(p+' -> '+j.retMsg);
    }catch(e){ if(t===3)throw e; await new Promise(r=>setTimeout(r,1500*(t+1))); }
  }
};

// Backward pagination: end walks back in 1000-bar blocks. Cache = whole request.
async function klinesDeep(sym, interval){
  const key=`${sym}_${interval}_${FROM}`;
  const file=path.join(CACHE_DIR,key+'.json');
  if(fs.existsSync(file)){
    const j=JSON.parse(fs.readFileSync(file));
    if(j.complete) return j.bars;
  }
  let end=Date.now(), bars=[];
  for(;;){
    const q=`/v5/market/kline?category=linear&symbol=${sym}&interval=${interval}`+
            `&start=${FROM}&end=${end}&limit=1000`;
    const res=await api(q);
    const list=(res.list||[]).map(r=>({ts:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]}));
    if(!list.length)break;
    const prev=bars.length;
    bars=bars.concat(list);
    const earliest=Math.min(...list.map(x=>x.ts));
    if(earliest<=FROM||bars.length===prev)break;   // reached start or listing came later
    end=earliest-1;
    if(list.length<1000&&earliest<=FROM+interval*3600e3)break;
  }
  bars.sort((a,b)=>a.ts-b.ts);
  // dedup by ts (page overlaps)
  const seen=new Set(); bars=bars.filter(b=>!seen.has(b.ts)&&seen.add(b.ts));
  const complete=bars.length&&bars[0].ts<=FROM+interval*3600e3*2;
  fs.writeFileSync(file,JSON.stringify({complete:!!complete,bars}));
  console.log(`  ${sym}: ${bars.length} bars ${interval}m`+
    ` (${new Date(bars[0]?.ts||0).toISOString().slice(0,10)} → ${new Date(bars[bars.length-1]?.ts||0).toISOString().slice(0,10)})`);
  return bars;
}

// ── SMC primitives (same as backtest_armed) ──────────────────────────
const detect=(bars)=>{
  const n=bars.length,swingAt=[],confirmed=[],clusters=[],events=[];
  for(let i=SWING_K;i<n-SWING_K;i++){
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
      if(bars[i].l<c.level&&bars[i].c>c.level){c.touches++;c.died=i;}
    }
  }
  return clusters;
};

// rolling-POC: once per bar, O(n*win)
const pocSeries=(bars)=>{
  const n=bars.length,out=new Array(n).fill(NaN);
  for(let end=20;end<n;end++){
    const s=POCWIN?Math.max(0,end-POCWIN+1):0;
    let hi=-Infinity,lo=Infinity;
    for(let i=s;i<=end;i++){if(bars[i].h>hi)hi=bars[i].h;if(bars[i].l<lo)lo=bars[i].l;}
    const step=(hi-lo)/BINS;if(!(step>0))continue;
    const vols=new Array(BINS).fill(0);
    for(let i=s;i<=end;i++){
      const tp=(bars[i].h+bars[i].l+bars[i].c)/3;
      let bi=Math.floor((tp-lo)/step);if(bi>=BINS)bi=BINS-1;if(bi<0)bi=0;
      vols[bi]+=bars[i].v;
    }
    let m=0;for(let i=1;i<BINS;i++)if(vols[i]>vols[m])m=i;
    out[end]=lo+(m+0.5)*step;
  }
  return out;
};

const obAt=(bars,end)=>{
  const s=Math.max(1,end-200);                  // OB searched within last ~200 bars
  for(let i=end-3;i>=s;i--){
    if(bars[i].c<bars[i].o){
      let mx=bars[i+1].c;
      for(let j=2;j<=3&&i+j<=end;j++)mx=Math.max(mx,bars[i+j].c);
      if((mx-bars[i].c)/bars[i].c*100>=IMP)return bars[i].l;
    }
  }
  return NaN;
};

// ── BTC regime on 4H + panic metrics on 1H ────────────────────────────
function btcFeatures(btc1h){
  // 1H: Δ24h, Z50, volSpike(SMA48), wick
  const f={};
  const closes=btc1h.map(b=>b.c),vols=btc1h.map(b=>b.v);
  let sMean=0,sSq=0,vMean=0;
  for(let i=0;i<btc1h.length;i++){
    const b=btc1h[i];
    sMean+=b.c;sSq+=b.c*b.c;vMean+=b.v;
    if(i>=50){sMean-=closes[i-50];sSq-=closes[i-50]*closes[i-50];}
    if(i>=48)vMean-=vols[i-48];
    let z=NaN;
    if(i>=50){
      const m=sMean/50,v=Math.max(0,sSq/50-m*m);
      z=(b.c-m)/Math.sqrt(v||1e-12);
    }
    f[b.ts]={
      chg24:i>=24?(b.c-closes[i-24])/closes[i-24]*100:NaN,
      z, volSpike:i>=48?b.v/(vMean/48):NaN,
      wick:(b.h-b.l)>0?(Math.min(b.o,b.c)-b.l)/(b.h-b.l):0,
    };
  }
  // 4H: 1H→4H aggregation, EMA50/200 on 4H closes
  const g={};for(const b of btc1h){const k=Math.floor(b.ts/(4*3600e3));
    (g[k]=g[k]||[]).push(b);}
  const h4=Object.keys(g).map(Number).sort((a,b)=>a-b)
    .map(k=>{const w=g[k];return{ts:k*4*3600e3,
      c:w[w.length-1].c};});
  let e50=h4[0]?.c||0,e200=h4[0]?.c||0;
  const regByTs={};
  for(let i=0;i<h4.length;i++){
    e50=h4[i].c*(2/51)+e50*(1-2/51);
    e200=h4[i].c*(2/201)+e200*(1-2/201);
    if(i<200)continue;
    const c=h4[i].c;
    regByTs[h4[i].ts]= (c>e200&&e50>e200)?'bull':(c<e200?'bear':'trans');
  }
  // map onto each 1H bar: take the last completed 4H bar
  const h4ts=Object.keys(regByTs).map(Number).sort((a,b)=>a-b);
  for(const b of btc1h){
    let lo=0,hi=h4ts.length-1,ans=-1;
    while(lo<=hi){const m=(lo+hi)>>1;
      if(h4ts[m]<b.ts){ans=m;lo=m+1;}else hi=m-1;}
    f[b.ts].regime=ans>=0?regByTs[h4ts[ans]]:undefined;
  }
  return f;
}

const floorTo=(v,s)=>Math.floor(v/s)*s;
const panicOf=(feat)=>{
  if(!feat)return 0;
  if(Number.isFinite(feat.z)&&feat.z<=-3.5)return 2;        // extreme
  if((Number.isFinite(feat.chg24)&&feat.chg24<PANIC)||
     (Number.isFinite(feat.z)&&feat.z<=-2.5&&feat.volSpike>=3))return 1;
  return 0;
};

(async()=>{
  console.log(`=== DEEP BACKTEST armed-long | from ${new Date(FROM).toISOString().slice(0,10)} | `+
    `pocwin=${POCWIN} | panic Δ24h<${PANIC}% | gate=${GATE} ===`);
  const btc=await klinesDeep('BTCUSDT',60);
  const bf=btcFeatures(btc);
  const rows=[];
  const tickMap={};   // rough tick sizes: stop precision is not critical for R
  const tickOf=await api('/v5/market/instruments-info?category=linear&limit=1000')
    .then(r=>{for(const i of r.list)tickMap[i.symbol]=+(i.priceFilter?.tickSize||0);return tickMap;});

  for(const sym of SYMS){
    const bars=await klinesDeep(sym,60);
    if(bars.length<400)continue;
    const tick=tickMap[sym]||0;
    const poc=pocSeries(bars);
    const clusters=detect(bars);
    let sig=0;
    for(const c of clusters){
      let run=0;
      const to=Math.min(bars.length-1,(c.died??bars.length)-1);
      for(let b=c.born;b<=to&&b-c.born<=CLUSTER_AGE_MAX;b++){
        const p=poc[b];
        const armed=Number.isFinite(p)&&bars[b].c>p&&c.level<p;
        if(!armed){run=0;continue;}
        if(++run!==1)continue;
        // fireArmed
        const feat=bf[bars[b].ts]||{};
        const regime=feat.regime||'?';
        const panic=panicOf(feat);
        const ob=obAt(bars,b);
        if(!(Number.isFinite(ob)&&ob<p)){rows.push({sym,ts:bars[b].ts,out:'degen',R:0,regime,panic});continue;}
        const limit=floorTo((p+ob)/2,tick),stop=floorTo(ob-SL_TICKS*tick,tick),
              tp1=floorTo(p,tick),tp2=floorTo(p*(1+TP2_PCT/100),tick),risk=limit-stop;
        if(risk<=0){rows.push({sym,ts:bars[b].ts,out:'degen',R:0,regime,panic});continue;}
        let out='open',R=0,filled=false;
        for(let j=b+1;j<Math.min(b+1+SIM_BARS,bars.length);j++){
          const x=bars[j];
          if(!filled){
            if(x.l<=stop){out='sl';R=-1;break;}
            if(x.l<=limit)filled=true;
            continue;
          }
          if(x.l<=stop){out='sl';R=-1;break;}
          if(x.h>=tp2){out='tp2';R=(tp2-limit)/risk;break;}
          if(x.h>=tp1){out='tp1';R=(tp1-limit)/risk;break;}
        }
        if(!filled&&out==='open'){out='nofil';R=0;}
        else if(out==='open')R=(bars[Math.min(b+SIM_BARS,bars.length)-1].c-limit)/risk;
        rows.push({sym,ts:bars[b].ts,out,R,regime,panic,
          btc24:feat.chg24,z:feat.z,vol:feat.volSpike});
        sig++;
      }
    }
    console.log(`  ${sym}: ${clusters.length} pools → ${sig} armed signals`);
  }

  // ── report ──
  const dec=rows.filter(r=>r.out!=='degen'&&r.out!=='nofil');
  const agg=rs=>({n:rs.length,w:rs.filter(r=>r.R>0).length,
    R:rs.reduce((a,r)=>a+r.R,0)});
  const gateOK=r=>
    GATE==='all'?true:
    GATE==='bull'?r.regime==='bull':
    GATE==='bullpanic'?r.regime==='bull'&&r.panic>=1:
    GATE==='bear35'?r.regime==='bear'&&r.panic===2:true;
  const gated=dec.filter(gateOK);
  const a=agg(gated);
  console.log(`\nTOTAL(${GATE}): sig=${gated.length} | R=${a.R.toFixed(1)} | `+
    `R/trade=${a.n?(a.R/a.n).toFixed(2):'-'} | WR=${a.n?(a.w/a.n*100).toFixed(0):'-'}%`);

  console.log('\n— regime × panic matrix (dec/R/WR) —');
  const cells={};
  for(const r of dec){
    const k=`${r.regime}/${['calm','panic','extreme'][r.panic]}`;
    (cells[k]=cells[k]||[]).push(r);
  }
  for(const[k,rs]of Object.entries(cells).sort((x,y)=>y[1].reduce((a,r)=>a+r.R,0)-x[1].reduce((a,r)=>a+r.R,0))){
    const s=agg(rs);
    console.log(`  ${k}: dec=${s.n} wr=${(s.w/s.n*100).toFixed(0)}% R=${s.R.toFixed(1)} (${(s.R/s.n).toFixed(2)}R)`);
  }

  // ── clustering into 48h episodes ──
  const win=EPISODE_H*3600e3;
  const eps=[];
  for(const r of [...dec].sort((a,b)=>a.ts-b.ts)){
    let ep=eps[eps.length-1];
    if(!ep||r.ts-ep.start>win){ep={start:r.ts,rows:[]};eps.push(ep);}
    ep.rows.push(r);
  }
  console.log(`\n— episodes (48h window): total=${eps.length}, of those panic>=1 —`);
  let tot3=0,totAll=0,pan=0;
  for(const e of eps){
    const pr=e.rows.filter(r=>r.panic>=1);
    if(!pr.length)continue;
    pan++;
    const top3=[...pr].sort((x,y)=>(y.z===x.z?0:Math.abs(y.z||0)-Math.abs(x.z||0)))
      .slice(0,MAX_PER_EPISODE);
    const r3=top3.reduce((s,r)=>s+r.R,0),rAll=pr.reduce((s,r)=>s+r.R,0);
    tot3+=r3;totAll+=rAll;
    console.log(`  ${new Date(e.start).toISOString().slice(0,13)}Z `+
      `${e.rows[0].regime}: trades=${pr.length} top3R=${r3.toFixed(1)} allR=${rAll.toFixed(1)}`);
  }
  console.log(`  TOTAL panic-episodes=${pan} | Σ top3R=${tot3.toFixed(1)} | Σ allR=${totAll.toFixed(1)}`);

  // ── benchmark events ──
  const bench=[['may-2021 china','2021-05-19'],['sep-2021 salvador','2021-09-07'],
    ['dec-2021 squeeze','2021-12-04'],['jan-2022 <40k','2022-01-21'],
    ['LUNA may-2022','2022-05-09'],['3AC jun-2022','2022-06-13'],
    ['FTX nov-2022','2022-11-08'],['SVB mar-2023','2023-03-10'],
    ['aug-2023 SpaceX','2023-08-17'],['jan-2024 Matrixport','2024-01-03'],
    ['apr-2024 Iran','2024-04-12'],['aug-2024 Black Monday','2024-08-05']];
  console.log('\n— benchmark episodes (±24h..+72h) —');
  for(const[name,d]of bench){
    const t0=Date.parse(d+'T00:00:00Z');
    const rs=dec.filter(r=>r.ts>=t0-864e5&&r.ts<=t0+3*864e5);
    const s=agg(rs);
    if(s.n)console.log(`  ${name}: dec=${s.n} wr=${(s.w/s.n*100).toFixed(0)}% R=${s.R.toFixed(1)}`);
  }
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
