import test from 'node:test';
import assert from 'node:assert/strict';
import {financialUpdates} from '../lib/industry/financial-updates.mjs';
const url='https://ir.example.com/q3';
const release={entity:'EX',fiscalYear:2026,quarter:3,publishedAt:'2026-10-01',url};
const discovery={entities:{EX:{status:'ready',checkedAt:'2026-10-02T01:00:00Z',releases:[release]}}};
const point={periodEnd:'2026-09-30',value:12,publishedAt:'2026-10-01',sourceUrl:url,isEstimated:false};
const data=(p=point,status='ready')=>({definitions:[{id:'EX.revenue',entity:'EX',frequency:'quarterly',valueType:'reported'}],series:{'EX.revenue':{status,observations:[p]}}});
test('official publication without parsed observations is pending, not collected',()=>{
 assert.equal(financialUpdates(discovery,data({...point,sourceUrl:'https://ir.example.com/q2'}),[],'2026-10-02')[0].status,'published_pending');
});
test('matching source URL and publication establish previously verified ingestion',()=>{
 assert.equal(financialUpdates(discovery,data(),[],'2026-10-02')[0].status,'collected');
});
test('prior-year comparison inside a new release cannot be counted as the current quarter',()=>{
 assert.equal(financialUpdates(discovery,data({...point,periodEnd:'2025-09-30',fiscalPeriod:'FY2025 Q3'}),[],'2026-10-02')[0].status,'published_pending');
});
test('ingestion ledger requires matching report and actual observation, not metadata alone',()=>{
 const ledger=[{...release,periodEnd:point.periodEnd,parsedAt:'2026-10-02'}];
 assert.equal(financialUpdates(discovery,data({...point,sourceUrl:'https://cdn.example.com/file.pdf'}),ledger,'2026-10-02')[0].status,'collected');
 assert.equal(financialUpdates(discovery,{},ledger,'2026-10-02')[0].status,'published_pending');
});
test('source failures do not become unpublished and preserve last check success times',()=>{
 const broken={entities:{EX:{status:'cached',releases:[],lastSuccessfulAt:'2026-09-30',error:'403'}}};
 const row=financialUpdates(broken,data(point,'cached'),[],'2026-10-02')[0];
 assert.equal(row.status,'cached');assert.equal(row.lastSuccessfulAt,'2026-09-30');assert.equal(row.error,'403');
});
test('future announcement is not an actual published financial report',()=>{
 const upcoming={entities:{EX:{status:'ready',releases:[],upcoming:[{releaseAt:'2026-11-01',url}]}}};
 assert.equal(financialUpdates(upcoming,{},[],'2026-10-02')[0].status,'not_published');
 assert.equal(financialUpdates(upcoming,{},[],'2026-11-02')[0].status,'unknown');
});
test('calendar uses the event date, never the announcement publication date',()=>{
 const calendar={entities:{EX:{status:'ready',upcoming:[{publishedAt:'2026-09-30',eventAt:'2026-11-01',url}]}}};
 const row=financialUpdates(calendar,{},[],'2026-10-02')[0];assert.equal(row.status,'not_published');assert.equal(row.upcoming.releaseAt,'2026-11-01');
});
test('future observations and estimates cannot prove report ingestion',()=>{
 assert.equal(financialUpdates(discovery,data({...point,isEstimated:true}),[],'2026-10-02')[0].status,'published_pending');
 assert.equal(financialUpdates(discovery,data({...point,periodEnd:'2026-12-31'}),[],'2026-10-02')[0].status,'published_pending');
});
test('latest release wins and cached data remain a separate displayed state',()=>{
 const next={...release,url:'https://ir.example.com/q4',quarter:4,publishedAt:'2026-10-02'};
 const row=financialUpdates({entities:{EX:{status:'cached',releases:[release,next],error:'timeout'}}},data(point,'cached'),[],'2026-10-02')[0];
 assert.equal(row.release.quarter,4);assert.equal(row.status,'published_pending');assert.equal(row.dataStatus,'cached');
});
test('partial report ingestion lists the individual charts still missing that quarter',()=>{
 const d=data();d.definitions.push({id:'EX.cashflow',entity:'EX',frequency:'quarterly',valueType:'reported'});
 d.series['EX.cashflow']={observations:[{...point,periodEnd:'2026-06-30',sourceUrl:'https://ir.example.com/q2'}],status:'cached'};
 const row=financialUpdates(discovery,d,[],'2026-10-02')[0];assert.deepEqual(row.currentMetricIds,['EX.revenue']);assert.deepEqual(row.pendingMetricIds,['EX.cashflow']);
});
