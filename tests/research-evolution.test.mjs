import test from 'node:test';
import assert from 'node:assert/strict';
import {researchCheckpoint,appendCheckpoint,compareCheckpoints} from '../lib/industry/research-evolution.mjs';

function result({at='2026-10-01T10:00:00Z',score=20,leading=null,value=100,period='2026-06-30',freshness='fresh',role='formal',factor=22,macro=-2,rule='1',status='ready',version='v1'}={}){
 return {generatedAt:at,inputHash:'input-'+at,quantitative:{model:{version:rule},sectorSignals:[{targetId:'cloud',targetName:'云平台',score,leadingSignal:leading==null?null:{status:'available',score:leading},stance:score==null?'insufficient_data':'gradual_attention',factorModelVersion:rule,factorContributions:[{id:'demand',name:'实际需求',formalContribution:factor,contribution:factor,metricIds:['MSFT.revenue']}],macroOverlay:{score:macro}}]},evidence:{inputSnapshot:{fullSiteContext:{industryMetrics:[{metricId:'MSFT.revenue',name:'收入',unit:'亿美元',status,freshness,reasoningRole:role,observations:[{periodEnd:period,value,publishedAt:'2026-07-30',version,sourceUrl:'https://example.org/filing'}]}]}}}};
}
const checkpoint=options=>researchCheckpoint(result(options));
test('timestamp, raw version and usable cache rechecks preserve first-known time',()=>{
 const first=checkpoint(),later=checkpoint({at:'2026-10-02T10:00:00Z',status:'cached',version:'changed-raw-file'});
 assert.equal(first.id,later.id);
 const state=appendCheckpoint([first],later);
 assert.equal(state.appended,false);assert.equal(state.records.length,1);assert.equal(state.current.recordedAt,first.recordedAt);
});
test('A -> B -> A is retained as three distinct live records',()=>{
 const a=checkpoint(),b=checkpoint({score:25}),again=checkpoint({at:'2026-10-03T10:00:00Z'});
 const state=appendCheckpoint(appendCheckpoint([a],b).records,again);
 assert.equal(state.records.length,3);assert.equal(a.id,again.id);assert.notEqual(a.recordId,again.recordId);
});
test('an imported baseline cannot prevent the first prospective live cohort',()=>{
 const old={...checkpoint(),origin:'imported_archive'},current=checkpoint({at:'2026-10-03T10:00:00Z'});
 const state=appendCheckpoint([old],current);assert.equal(state.appended,true);assert.equal(state.records.length,2);assert.equal(state.current.origin,'live_archive');
});
test('new report links dates and scores with factor + macro + residual attribution',()=>{
 const changes=compareCheckpoints(checkpoint(),checkpoint({score:29,factor:28,macro:-1,value:120,period:'2026-09-30'}));
 const row=changes.sectors[0];assert.equal(row.delta,9);assert.equal(row.evidence[0].kind,'new_report');
 assert.equal(row.evidence[0].sourceUrl,'https://example.org/filing');assert.equal(row.evidence[0].previousPeriod,'2026-06-30');
 assert.equal(row.factors[0].delta+row.macroDelta+row.residualDelta,row.delta);
});
test('same-date revision and expiry remain distinguishable',()=>{
 assert.equal(compareCheckpoints(checkpoint(),checkpoint({value:101})).sectors[0].evidence[0].kind,'revision');
 const expiry=compareCheckpoints(checkpoint(),checkpoint({score:null,freshness:'stale',role:'excluded'})).sectors[0];
 assert.equal(expiry.expiredCount,1);assert.equal(expiry.delta,null);assert.match(expiry.reasons.join(' '),/超过更新窗口/);
});
test('formal versus leading scores and changed rule versions are not subtracted',()=>{
 const tier=compareCheckpoints(checkpoint(),checkpoint({score:null,leading:30})).sectors[0];assert.equal(tier.delta,null);assert.equal(tier.currentTier,'leading');
 const rule=compareCheckpoints(checkpoint(),checkpoint({score:21,rule:'2'})).sectors[0];assert.equal(rule.delta,null);assert.equal(rule.ruleChanged,true);
});
test('first record and unchanged latest meaningful comparison are explicit',()=>{
 assert.equal(compareCheckpoints(null,checkpoint()).status,'first_record');
 const changes=compareCheckpoints(checkpoint(),checkpoint({score:25}),{unchanged:true});assert.equal(changes.status,'unchanged');assert.equal(changes.sectors[0].delta,5);
});
