import test from 'node:test';
import assert from 'node:assert/strict';
import {valueCompany,officialTtm,buildValuations} from '../lib/industry/valuation.mjs';
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
