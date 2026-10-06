import test from 'node:test';
import assert from 'node:assert/strict';
import {valueCompany,officialTtm,buildValuations,valuationScenario} from '../lib/industry/valuation.mjs';
import {buildValuationHistory,disclosedDilutedEps} from '../lib/industry/valuation-history.mjs';
const field=(value,periodEnd='2026-06-30',currency='USD')=>({value,periodEnd,currency,unit:'USD',basis:'third_party_transcription',publishedAt:null});
function market(){return {prices:{MSFT:{status:'ready',currency:'USD',observations:[{date:'2026-10-02',close:10}],splits:[]}},finance:{MSFT:{status:'ready',fields:{shares:{...field(100),unit:'shares'},revenue:field(1000),netIncome:field(100),operatingCashFlow:field(200),capex:field(50),cash:field(300),debt:field(500)}}}};}
function industry(dates=['2025-09-30','2025-12-31','2026-03-31','2026-06-30']){return {definitions:[{id:'MSFT.revenue',entity:'MSFT',family:'revenue',currency:'USD',unit:'亿美元'}],series:{'MSFT.revenue':{status:'ready',observations:dates.map(periodEnd=>({periodEnd,value:1,publishedAt:'2026-07-30',sourceUrl:'https://official.example',version:'1'}))}}};}
test('ratios use disclosed shares and consistent dollar units',()=>{
 const c=valueCompany({},market(),'MSFT',{asOf:'2026-10-03'});assert.equal(c.marketCap,1000);assert.equal(c.pe,10);assert.equal(c.ps,1);assert.equal(c.fcfYield,15);assert.equal(c.netDebt,200);assert.equal(c.ev,1200);
});
test('official TTM sums four continuous real quarters at 1e8 conversion',()=>{
 const data=industry();assert.equal(officialTtm(data,'MSFT','revenue','2026-10-03').value,4e8);
 const c=valueCompany(data,market(),'MSFT',{asOf:'2026-10-03'});assert.equal(c.fields.revenue.basis,'official_quarter_sum');assert.equal(c.ps,1000/4e8);
 data.series['MSFT.revenue'].observations[1].isEstimated=true;assert.equal(officialTtm(data,'MSFT','revenue','2026-10-03'),null);
 assert.equal(officialTtm(industry(['2025-03-31','2025-09-30','2025-12-31','2026-06-30']),'MSFT','revenue','2026-10-03'),null);
});
test('older official quarters cannot replace newer TTM transcription',()=>{
 const data=industry();const m=market();m.finance.MSFT.fields.revenue=field(2000,'2026-09-30');assert.equal(valueCompany(data,m,'MSFT',{asOf:'2026-10-03'}).revenue,2000);
});
test('losses, zero profits, foreign currency and future publication are explicit gaps',()=>{
 const m=market();m.finance.MSFT.fields.netIncome.value=-100;assert.equal(valueCompany({},m,'MSFT',{asOf:'2026-10-03'}).pe,null);
 m.finance.MSFT.fields.revenue.currency='TWD';assert.equal(valueCompany({},m,'MSFT',{asOf:'2026-10-03'}).ps,null);
 m.finance.MSFT.fields.operatingCashFlow.publishedAt='2026-11-01';assert.equal(valueCompany({},m,'MSFT',{asOf:'2026-10-03'}).fcfYield,null);
});
test('mismatched period or cash-only balances never produce FCF yield / enterprise value',()=>{
 const m=market();m.finance.MSFT.fields.capex.periodEnd='2026-03-31';m.finance.MSFT.fields.debt.periodEnd='2026-03-31';
 let c=valueCompany({},m,'MSFT',{asOf:'2026-10-03'});assert.equal(c.fcfYield,null);assert.equal(c.ev,null);
 m.finance.MSFT.fields.debt.periodEnd='2026-06-30';m.finance.MSFT.fields.cash.scope='cash_only';c=valueCompany({},m,'MSFT',{asOf:'2026-10-03'});assert.equal(c.ev,null);assert.equal(c.netDebt,null);
});
test('stale price, stale shares, known split and ADR cannot silently estimate market cap',()=>{
 const m=market();m.prices.MSFT.observations[0].date='2026-09-01';assert.equal(valueCompany({},m,'MSFT',{asOf:'2026-10-03'}).marketCap,null);
 m.prices.MSFT.observations[0].date='2026-10-02';m.prices.MSFT.splits=[{date:'2026-09-01'}];assert.equal(valueCompany({},m,'MSFT',{asOf:'2026-10-03'}).marketCap,null);
 m.prices.MSFT.splits=[];m.finance.MSFT.fields.shares.periodEnd='2025-12-31';assert.equal(valueCompany({},m,'MSFT',{asOf:'2026-10-03'}).marketCap,null);
 m.prices.TSM=m.prices.MSFT;m.finance.TSM=m.finance.MSFT;const adr=valueCompany({},m,'TSM',{asOf:'2026-10-03'});assert.equal(adr.status,'scope_mismatch');assert.equal(adr.pe,null);
});
test('manual price is a marked local scenario, never alters provider observations',()=>{
 const m=market();const c=valueCompany({},m,'MSFT',{asOf:'2026-10-03',manualPrice:20});assert.equal(c.pe,20);assert.equal(c.isManual,true);assert.equal(m.prices.MSFT.observations[0].close,10);
});
test('peer comparison requires three companies within the same group',()=>{
 const m=market();const rows=buildValuations({},m,{asOf:'2026-10-03'}).companies;assert.equal(rows[0].peerMedianPs,null);
 for(const entity of ['GOOG','AMZN']){m.prices[entity]=m.prices.MSFT;m.finance[entity]=m.finance.MSFT;}
 const group=buildValuations({},m,{asOf:'2026-10-03'}).companies.find(p=>p.entity==='MSFT');assert.equal(group.peerCount,3);assert.equal(group.peerMedianPs,1);
});

test('historical P/E uses only previously published issuer EPS and never current TTM backfill',()=>{
 const m=market();m.prices.MSFT.observations=[
  {date:'2026-01-05',close:10},{date:'2026-01-06',close:11},{date:'2026-01-07',close:12}
 ];m.prices.MSFT.closeAdjustment='split_adjusted';m.prices.MSFT.closeBasisDate='2026-01-07';
 m.finance.MSFT.epsHistory={status:'ready',observations:[
  ['2025-03-31','2025-05-01',1],['2025-06-30','2025-08-01',1],['2025-09-30','2025-11-01',1],['2025-12-31','2026-01-05',1]
 ].map(([periodEnd,publishedAt,value],i)=>({periodEnd,publishedAt,availableAt:publishedAt,value,currency:'USD',unit:'USD per diluted share',sourceUrl:'https://issuer.example/'+i,version:'v'+i}))};
 assert.equal(disclosedDilutedEps(m,'MSFT','2026-01-05',{afterPublicationDay:true}),null);
 assert.equal(disclosedDilutedEps(m,'MSFT','2026-01-06',{afterPublicationDay:true}).value,4);
 const company={entity:'MSFT',status:'available',isManual:false,priceAt:'2026-01-07',price:12,pe:3,ps:null,fcfYield:null,marketCap:100,revenue:100,fields:{}};
 const h=buildValuationHistory(company,m,{asOf:'2026-01-07',recordedAt:'2026-01-07T12:00:00Z'});
 assert.equal(h.observations.length,2);assert.deepEqual(h.observations.map(p=>p.date),['2026-01-06','2026-01-07']);assert.equal(h.observations[0].pe,11/4);
});

test('history keeps real saved snapshots and withholds percentiles below sixty observations',()=>{
 const company={entity:'MSFT',status:'available',isManual:false,priceAt:'2026-10-02',price:10,pe:10,ps:1,fcfYield:5,marketCap:1000,revenue:1000,fields:{}};
 const h=buildValuationHistory(company,market(),{asOf:'2026-10-03',recordedAt:'2026-10-03T12:00:00Z',previous:{observations:[{date:'2026-09-01',recordedAt:'2026-09-01T12:00:00Z',origin:'live_snapshot',pe:99,ps:9,fcfYield:1}]}});
 assert.equal(h.metrics.pe.percentile,null);assert.equal(h.observations[0].pe,99);assert.equal(h.snapshotCount,2);
});

test('growth and margin scenario keeps market capitalization fixed and is not a target price',()=>{
 const c={status:'available',marketCap:1000,revenue:100,netIncome:10,freeCashFlow:8,ps:10,fcfYield:.8,fields:{revenue:{periodEnd:'2026-06-30'},netIncome:{periodEnd:'2026-06-30'},operatingCashFlow:{periodEnd:'2026-06-30'},capex:{periodEnd:'2026-06-30'}}};
 const s=valuationScenario(c,{revenueGrowthPct:20,netMarginPct:15,fcfMarginPct:10});
 assert.equal(s.status,'available');assert.equal(s.scenario.marketCap,1000);assert.equal(s.scenario.revenue,120);assert.equal(s.scenario.pe,1000/18);assert.match(s.method,/不是盈利预测/);
 assert.equal(valuationScenario(c,{revenueGrowthPct:-101}).status,'invalid_input');
});
