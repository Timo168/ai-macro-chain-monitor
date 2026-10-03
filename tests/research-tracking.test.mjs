import test from 'node:test';
import assert from 'node:assert/strict';
import {addMonths,buildTracking,baskets} from '../lib/industry/research-tracking.mjs';
function record({id='one',at='2026-01-01T18:00:00Z',score=20,tier='formal'}={}){return {id,recordId:id+'-'+at,origin:'live_archive',recordedAt:at,inputHash:'input-'+id,signals:[{targetId:'memory',targetName:'存储',tier,score,stance:'gradual_attention',factorModelVersion:'1'}]};}
function market({end='2026-08-01',drop=[],currency='USD'}={}){
 const points=[];for(let d=new Date('2026-01-01T00:00:00Z');d.toISOString().slice(0,10)<=end;d.setUTCDate(d.getUTCDate()+1)){const date=d.toISOString().slice(0,10);if(d.getUTCDay()===0||d.getUTCDay()===6||drop.includes(date))continue;points.push({date,adjustedClose:date<'2026-01-16'?100:date<'2026-01-23'?80:120});}
 return {prices:{MU:{status:'ready',currency,version:'mu1',observations:points},QQQ:{status:'ready',currency:'USD',version:'qqq1',observations:points.map(p=>({...p,adjustedClose:100}))}}};
}
test('calendar months clamp at month end and leap day',()=>{assert.equal(addMonths('2026-01-31',1),'2026-02-28');assert.equal(addMonths('2024-01-31',1),'2024-02-29');assert.equal(addMonths('2024-02-29',12),'2025-02-28');});
test('entry strictly follows archived UTC date, pending windows have no returns',()=>{
 const r=buildTracking([record()],market(),{asOf:'2026-01-10'});const w=r.cohorts[0].windows[0];
 assert.equal(w.entryAt,'2026-01-02');assert.equal(w.status,'pending');assert.equal(w.netReturn,undefined);assert.equal(r.byHorizon[0].meanNetReturn,null);
});
test('matured returns apply equal buy-and-hold weights, both-side fees and real drawdown',()=>{
 const r=buildTracking([record()],market(),{asOf:'2026-02-03'});const w=r.cohorts[0].windows[0];
 assert.equal(w.status,'matured');assert.equal(w.grossReturn,20);assert.equal(w.netReturn,19.76);assert.equal(w.benchmarkNetReturn,-0.2);assert.equal(w.excessReturn,19.96);assert.equal(w.maxDrawdown,-20.08);
 assert.equal(w.priceVersions.MU.version,'mu1');assert.equal(r.byHorizon[0].maturedCount,1);
});
test('two-asset basket is initial equal weights, not periodic rebalance',()=>{
 const checkpoint=record();checkpoint.signals[0].targetId='accelerators';const m=market();m.prices.NVDA=m.prices.MU;m.prices.AMD={...m.prices.QQQ,observations:m.prices.QQQ.observations.map(p=>({...p,adjustedClose:p.date<'2026-02-01'?100:80}))};
 const w=buildTracking([checkpoint],m,{asOf:'2026-02-03',costBps:0}).cohorts[0].windows[0];assert.equal(w.grossReturn,0);
});
test('missing, zero, FX, future and long gaps never become fabricated prices',()=>{
 const m=market();m.prices.MU.currency='TWD';assert.equal(buildTracking([record()],m,{asOf:'2026-02-03'}).cohorts[0].windows[0].status,'missing_prices');
 assert.equal(buildTracking([record({at:'2026-08-01T10:00:00Z'})],market(),{asOf:'2026-08-01'}).cohorts[0].windows[0].status,'awaiting_entry');
 const gap=market({drop:['2026-01-05','2026-01-06','2026-01-07','2026-01-08','2026-01-09','2026-01-12']});assert.equal(buildTracking([record()],gap,{asOf:'2026-02-03'}).cohorts[0].windows[0].status,'price_gap');
 const late=market();late.prices.MU.observations=late.prices.MU.observations.filter(p=>p.date>'2026-01-15');assert.equal(buildTracking([record()],late,{asOf:'2026-02-03'}).cohorts[0].windows[0].status,'price_gap');
});
test('only live saved conclusions create cohorts, same signals do not duplicate',()=>{
 const a=record(),b=record({id:'two',at:'2026-01-05T10:00:00Z'});const fake={...record(),origin:'reconstructed'};
 assert.equal(buildTracking([fake,a,b],market(),{asOf:'2026-02-03'}).cohorts.length,1);
 assert.equal(buildTracking([record({tier:'unavailable',score:null})],market()).cohorts.length,0);
});
test('completed windows, basket and costs remain frozen after later price revisions',()=>{
 const checkpoint=record(),m=market(),first=buildTracking([checkpoint],m,{asOf:'2026-02-03'});
 m.prices.MU.observations=m.prices.MU.observations.map(p=>({...p,adjustedClose:1000}));m.prices.MU.version='revised';
 const original=baskets.memory;try{baskets.memory=['MISSING'];const next=buildTracking([checkpoint],m,{asOf:'2026-03-03',costBps:100,prior:first});assert.deepEqual(next.cohorts[0].symbols,['MU']);assert.equal(next.cohorts[0].costBpsPerSide,10);assert.deepEqual(next.cohorts[0].windows[0],first.cohorts[0].windows[0]);}finally{baskets.memory=original;}
});
test('negative signals still show long basket performance, not invented shorts',()=>{
 const w=buildTracking([record({score:-30})],market(),{asOf:'2026-02-03',costBps:0}).cohorts[0].windows[0];assert.equal(w.grossReturn,20);
 assert.throws(()=>buildTracking([],{}, {costBps:-1}),/Invalid/);
});
test('ongoing returns use actual common observations and only entry fees',()=>{
 const r=buildTracking([record()],market(),{asOf:'2026-01-20'}),c=r.cohorts[0],p=c.progress;
 assert.equal(p.status,'ongoing');assert.equal(p.entryAt,'2026-01-02');assert.equal(p.observedAt,'2026-01-20');
 assert.equal(p.netReturn,-20.08);assert.equal(p.benchmarkNetReturn,-0.1);assert.equal(p.excessReturn,-19.98);
 assert.equal(p.feesApplied,'entry_only');assert.equal(c.windows[0].netReturn,undefined);
 assert.equal(p.observations.at(-1).netReturn,p.netReturn);assert.equal(c.entry.referencePrices.MU.adjustedClose,100);
});
test('entry is pinned, unavailable entry prices never move the date',()=>{
 const first=buildTracking([record()],market(),{asOf:'2026-01-10'}),m=market();
 m.prices.MU.observations=m.prices.MU.observations.filter(p=>p.date!=='2026-01-02');
 const next=buildTracking([record()],m,{asOf:'2026-01-20',prior:first}).cohorts[0];
 assert.deepEqual(next.entry,first.cohorts[0].entry);assert.equal(next.progress.status,'price_gap');assert.equal(next.progress.entryAt,'2026-01-02');assert.equal(next.progress.netReturn,undefined);
});
test('uniform dividend adjustment cannot mix current prices with old entry basis',()=>{
 const first=buildTracking([record()],market(),{asOf:'2026-01-10'}),m=market();
 m.prices.MU.version='dividend-adjustment';m.prices.MU.observations=m.prices.MU.observations.map(p=>({...p,adjustedClose:p.adjustedClose*0.8}));
 const next=buildTracking([record()],m,{asOf:'2026-01-20',prior:first}).cohorts[0];
 assert.equal(next.entry.referencePrices.MU.adjustedClose,100);assert.equal(next.progress.netReturn,-20.08);assert.equal(next.progress.priceVersions.MU.version,'dividend-adjustment');
});
test('pending legacy cohort entry migrates without changing the original date',()=>{
 const prior=buildTracking([record()],market(),{asOf:'2026-01-10'});delete prior.cohorts[0].entry;
 const next=buildTracking([record()],market(),{asOf:'2026-01-20',prior}).cohorts[0];assert.equal(next.entry.date,'2026-01-02');
});
test('source outage, stale prices and long ongoing gaps have explicit states',()=>{
 const m=market({end:'2026-01-09'});m.prices.MU.status='cached';
 const cached=buildTracking([record()],m,{asOf:'2026-01-10'}).cohorts[0].progress;assert.equal(cached.status,'cached');assert.equal(cached.observedAt,'2026-01-09');
 const stale=buildTracking([record()],m,{asOf:'2026-01-20'}).cohorts[0].progress;assert.equal(stale.status,'stale_prices');assert.equal(stale.observedAt,'2026-01-09');
 const missing=market({drop:['2026-01-05','2026-01-06','2026-01-07','2026-01-08','2026-01-09','2026-01-12']});
 assert.equal(buildTracking([record()],missing,{asOf:'2026-01-20'}).cohorts[0].progress.status,'price_gap');
});
test('six-month completion freezes daily path and both-side fees',()=>{
 const checkpoint=record(),m=market(),first=buildTracking([checkpoint],m,{asOf:'2026-07-03'});
 assert.equal(first.cohorts[0].progress.status,'completed');assert.equal(first.cohorts[0].progress.netReturn,first.cohorts[0].windows[2].netReturn);
 m.prices.MU.observations=m.prices.MU.observations.map(p=>({...p,adjustedClose:999}));
 const next=buildTracking([checkpoint],m,{asOf:'2026-08-01',prior:first});assert.deepEqual(next.cohorts[0].progress,first.cohorts[0].progress);
});
