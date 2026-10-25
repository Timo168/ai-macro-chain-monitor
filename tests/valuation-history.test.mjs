import test from 'node:test';
import assert from 'node:assert/strict';
import {buildValuationHistory} from '../lib/industry/valuation-history.mjs';

const field=(value,extra={})=>({value,periodEnd:'2026-06-30',publishedAt:'2026-07-30',version:'finance-v1',currency:'USD',...extra});
function company(extra={}){return {entity:'MSFT',status:'available',isManual:false,priceAt:'2026-10-02',price:100,pe:20,ps:5,fcfYield:2,peBasis:'market_cap_over_ttm_income',priceVersion:'quote-v1',fields:{shares:field(10),netIncome:field(50),revenue:field(200),operatingCashFlow:field(30),capex:field(10)},...extra};}
function market(extra={}){return {prices:{MSFT:{status:'ready',currency:'USD',observations:[{date:'2026-10-02',close:100}],...extra}},finance:{MSFT:{status:'ready'}}};}
function run(c=company(),options={},m=market()){return buildValuationHistory(c,m,{asOf:'2026-10-02',recordedAt:'2026-10-02T22:00:00Z',...options});}

test('weekend checks count a closing quote once and retain its original capture',()=>{
 const friday=run();
 const saturday=run(company(),{previous:friday,asOf:'2026-10-03',recordedAt:'2026-10-03T12:00:00Z'});
 const sunday=run(company(),{previous:saturday,asOf:'2026-10-04',recordedAt:'2026-10-04T12:00:00Z'});
 assert.equal(sunday.count,1);assert.equal(sunday.metrics.pe.count,1);
 assert.equal(sunday.observations[0].date,'2026-10-02');
 assert.equal(sunday.snapshots.length,1);assert.deepEqual(sunday.snapshots[0],friday.snapshots[0]);
 assert.equal(sunday.currentSnapshot.asOf,'2026-10-04');
});

test('same-day fresh closing value replaces chart sample while retaining both revisions',()=>{
 const early=run(company({price:99,pe:19.8,ps:4.95,priceVersion:'early'}));
 const fresh=run(company(),{previous:early,recordedAt:'2026-10-02T23:00:00Z'});
 assert.equal(fresh.count,1);assert.equal(fresh.observations[0].pe,20);
 assert.equal(fresh.currentSnapshot.pe,fresh.observations[0].pe);
 assert.equal(fresh.snapshots.length,2);assert.equal(fresh.snapshots[0].price,99);
 assert.equal(fresh.snapshots[1].priceVersion,'quote-v1');
 const replay=run(company({status:'partial',priceAt:null,pe:null,ps:null,fcfYield:null}),{previous:fresh,recordedAt:'2026-10-02T22:30:00Z'});
 assert.equal(replay.observations[0].pe,19.8);
 assert.equal(replay.snapshots.length,2,'replay must not destroy later archived versions');
});

test('legacy date-keyed observations migrate without modifying original records',()=>{
 const seed=run().snapshots[0];
 const originals=[{...seed,date:'2026-10-03',asOf:undefined,recordedAt:'2026-10-03T10:00:00Z'},{...seed,date:'2026-10-04',asOf:undefined,recordedAt:'2026-10-04T10:00:00Z'}];
 const previous=JSON.parse(JSON.stringify({version:'valuation-history-1.0.0',observations:originals}));
 const before=JSON.stringify(previous);
 const migrated=run(company(),{previous,asOf:'2026-10-04',recordedAt:'2026-10-04T12:00:00Z'});
 assert.equal(migrated.count,1);assert.equal(migrated.metrics.pe.count,1);
 assert.deepEqual(migrated.snapshots,previous.observations);assert.equal(JSON.stringify(previous),before);
 assert.equal(migrated.observations[0].date,'2026-10-02');
 assert.equal(migrated.snapshots[0].date,'2026-10-03');
});

test('late financial disclosure changes the current snapshot without rewriting an earlier quote day',()=>{
 const friday=run();const next=company({pe:10,ps:2.5,fcfYield:4});
 for(const p of Object.values(next.fields)){p.publishedAt='2026-10-03';p.version='finance-v2';}
 const sunday=run(next,{previous:friday,asOf:'2026-10-04',recordedAt:'2026-10-04T12:00:00Z'});
 assert.equal(sunday.observations[0].pe,20);assert.equal(sunday.currentSnapshot.pe,10);
 assert.equal(sunday.currentSnapshot.historyEligible,false);
 assert.deepEqual(sunday.currentSnapshot.excludedMetrics,['pe','ps','fcfYield']);
 assert.equal(sunday.snapshots.length,2);
 const monday=run({...next,priceAt:'2026-10-05'},{previous:sunday,asOf:'2026-10-05',recordedAt:'2026-10-05T22:00:00Z'},market({observations:[{date:'2026-10-05',close:100}]}));
 assert.deepEqual(monday.observations.map(p=>[p.date,p.pe]),[['2026-10-02',20],['2026-10-05',10]]);
 assert.equal(monday.currentSnapshot.historyEligible,true);
});

test('missing publication dates use first retained input version, never period-end as availability',()=>{
 const unknown=company();for(const p of Object.values(unknown.fields)){p.publishedAt=null;p.fetchedAt='2026-10-03T09:00:00Z';}
 const first=run(unknown,{asOf:'2026-10-03',recordedAt:'2026-10-03T12:00:00Z'});
 assert.equal(first.count,0);assert.equal(first.currentSnapshot.historyEligible,false);
 const later=structuredClone(unknown);later.priceAt='2026-10-05';for(const p of Object.values(later.fields))p.fetchedAt='2026-10-06T09:00:00Z';
 const next=run(later,{previous:first,asOf:'2026-10-06',recordedAt:'2026-10-06T12:00:00Z'},market({observations:[{date:'2026-10-05',close:100}]}));
 assert.equal(next.count,1);assert.equal(next.observations[0].date,'2026-10-05');
 assert.equal(next.currentSnapshot.metricAvailability.pe.availableAt,'2026-10-03');
 assert.equal(next.currentSnapshot.historyEligible,true);
});

test('a new unverified financial revision cannot borrow the old version availability',()=>{
 const old=run();const next=company({pe:10});next.fields.netIncome={...next.fields.netIncome,publishedAt:null,version:'new-unknown',value:100,fetchedAt:'2026-10-04T08:00:00Z'};
 const h=run(next,{previous:old,asOf:'2026-10-04',recordedAt:'2026-10-04T12:00:00Z'});
 assert.equal(h.observations[0].pe,20);assert.equal(h.observations[0].ps,5);
 assert.equal(h.observations[0].metricSources.pe.snapshotIndex,0);
 assert.deepEqual(h.currentSnapshot.excludedMetrics,['pe']);
 assert.equal(h.snapshots[0].pe,20,'the old auditable ratio must remain recoverable');
});

test('date-only publication is usable only from the next date',()=>{
 const c=company();c.fields.netIncome.publishedAt='2026-10-02';
 const h=run(c);assert.equal(h.observations[0].pe,null);assert.equal(h.currentSnapshot.metricAvailability.pe.availableAt,'2026-10-03');
});

test('a restatement without revision availability cannot reuse the original announcement date',()=>{
 const c=company({pe:10});c.fields.netIncome={...c.fields.netIncome,value:100,isRestated:true,version:'restatement-v2',fetchedAt:'2026-10-04T10:00:00Z'};
 const h=run(c,{previous:run(),asOf:'2026-10-04',recordedAt:'2026-10-04T12:00:00Z'});
 assert.equal(h.observations[0].pe,20);assert.equal(h.currentSnapshot.pe,10);
 assert.deepEqual(h.currentSnapshot.excludedMetrics,['pe']);
});

test('failure preserves last successful observations, and invalid scopes never add snapshots',()=>{
 const good=run();
 for(const c of [company({status:'scope_mismatch'}),company({isManual:true}),company({priceAt:'2026-10-10'}),company({priceAt:'2026-09-01'})]){
  const h=run(c,{previous:good});assert.equal(h.snapshots.length,1);assert.equal(h.currentSnapshot,null);assert.equal(h.metrics.pe.percentile,null);
 }
 const failed=run(company({pe:null,ps:null,fcfYield:null}),{previous:good},market({status:'fetch_failed'}));
 assert.equal(failed.status,'cached');assert.equal(failed.observations[0].pe,20);assert.equal(failed.currentSnapshot,null);
 const foreign=run(company(),{},market({currency:'TWD'}));assert.equal(foreign.count,0);
});

test('sixty recorded checks of one quote never unlock a historical percentile',()=>{
 const p=run().snapshots[0];const observations=Array.from({length:60},(_,i)=>({...p,recordedAt:`2026-10-02T22:${String(i).padStart(2,'0')}:00Z`}));
 const h=run(company(),{previous:{observations},recordedAt:'2026-10-02T23:59:00Z'});
 assert.equal(h.count,1);assert.equal(h.metrics.pe.count,1);assert.equal(h.metrics.pe.percentile,null);
 assert.equal(h.snapshots.length,60);
});

test('EPS reconstruction uses its publication boundary and survives an upstream outage',()=>{
 const m=market({observations:[{date:'2026-10-01',close:100},{date:'2026-10-02',close:100}]});
 m.finance.MSFT.epsHistory={status:'ready',observations:[['2025-09-30','2025-11-01'],['2025-12-31','2026-02-01'],['2026-03-31','2026-05-01'],['2026-06-30','2026-10-01']].map(([periodEnd,publishedAt])=>({periodEnd,publishedAt,value:1,currency:'USD',unit:'USD per diluted share',version:periodEnd}))};
 const unavailable=company({priceAt:null,pe:null,ps:null,fcfYield:null});
 const first=run(unavailable,{},m);assert.equal(first.count,1);assert.equal(first.observations[0].date,'2026-10-02');assert.equal(first.observations[0].pe,25);
 m.prices.MSFT.status='fetch_failed';
 const failed=run(unavailable,{previous:first,asOf:'2026-10-03',recordedAt:'2026-10-03T12:00:00Z'},m);
 assert.equal(failed.observations[0].pe,25);assert.equal(failed.status,'cached');
});
