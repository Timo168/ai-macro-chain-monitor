import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResearchValidation} from '../lib/industry/research-validation.mjs';
import {addMonths} from '../lib/industry/research-tracking.mjs';

// Synthetic immutable ledger / follow-up fixtures test audit boundaries only.
function pair({id='one',at='2026-01-01T12:00:00Z',entry='2026-01-02',months=1,score=20,tier='formal',version='v1',targetId='memory',evaluatedAt=null,macroScore=5}={}){
 const exit=addMonths(entry,months),record={recordId:id,recordedAt:at,inputHash:'hash-'+id,origin:'live_archive',signals:[{targetId,targetName:targetId,score,tier,factorModelVersion:version,macroScore}]};
 const cohort={id:id+':'+targetId,checkpointId:id,inputHash:record.inputHash,recordedAt:at,targetId,targetName:targetId,tier,score,basketVersion:'basket-1',symbols:['MU'],benchmark:'QQQ',costBpsPerSide:10,entry:{date:entry},windows:[{months,status:'matured',entryAt:entry,maturityAt:exit,exitAt:exit,evaluatedAt:evaluatedAt??exit,grossReturn:20,netReturn:999,benchmarkReturn:5,benchmarkNetReturn:999,excessReturn:999,maxDrawdown:-12,priceVersions:{MU:{version:'mu-v1',status:'ready'},QQQ:{version:'qqq-v1',status:'ready'}}}]};
 return {record,cohort};
}
const run=(pairs,options={})=>buildResearchValidation(pairs.map(row=>row.record),{cohorts:pairs.map(row=>row.cohort)},{asOf:'2026-10-05',registeredAt:'2026-01-01T00:00:00+08:00',...options});

test('unfinished real cohorts produce no invented returns or win rate',()=>{
 const fixture=pair();fixture.cohort.windows[0]={months:1,status:'pending'};
 const result=run([fixture]);assert.equal(result.status,'awaiting_maturity');assert.equal(result.groups.length,0);assert.equal(result.counts.pendingWindows,1);assert.equal(result.counts.acceptedWindows,0);assert.equal(result.winRate,undefined);
});
test('only exact real ledger and immutable price lineage matches are accepted',()=>{
 for(const change of [p=>p.record.origin='imported_archive',p=>p.cohort.inputHash='other',p=>p.cohort.recordedAt='2026-01-01T00:00:00Z',p=>p.cohort.score=99,p=>p.cohort.factorModelVersion='different',p=>delete p.cohort.windows[0].priceVersions.MU.version,p=>p.cohort.windows[0].priceVersions.MU.status='fetch_failed']){
  const fixture=pair();change(fixture);assert.equal(run([fixture]).counts.acceptedWindows,0);
 }
 const cached=pair();cached.cohort.windows[0].priceVersions.MU.status='cached';assert.equal(run([cached]).counts.acceptedWindows,1);
});
test('future evaluation, wrong maturity, missing gross and delayed entry are rejected',()=>{
 for(const change of [p=>p.cohort.windows[0].evaluatedAt='2026-11-01',p=>p.cohort.windows[0].maturityAt='2026-02-03',p=>delete p.cohort.windows[0].grossReturn,p=>p.cohort.windows[0].benchmarkReturn=null,p=>p.cohort.windows[0].exitAt='2026-02-15',p=>p.cohort.windows[0].evaluatedAt='2026-01-01']){
  const fixture=pair();change(fixture);assert.equal(run([fixture]).windows.length,0);
 }
 assert.equal(run([pair({entry:'2026-01-15'})]).windows.length,0);
 assert.throws(()=>run([],{asOf:'2026-02-30'}),/valid asOf/);
});
test('cost stress is recomputed from frozen gross returns and not already net results',()=>{
 const result=run([pair()]),costs=result.windows[0].costScenarios;
 assert.equal(costs.find(row=>row.costBpsPerSide===0).netReturn,20);
 assert.equal(costs.find(row=>row.costBpsPerSide===10).netReturn,19.7601);
 assert.equal(costs.find(row=>row.costBpsPerSide===10).excessReturn,14.97);
 assert.ok(costs.every((row,index)=>!index||row.netReturn<costs[index-1].netReturn));
 assert.equal(result.windows[0].archivedMaxDrawdown,-12);assert.equal(costs[0].maxDrawdown,undefined);
 assert.equal(result.groups[0].costScenarios[1].meanNetReturn,19.7601);
});
test('sampling rejects overlaps across bands, regimes and registration phases',()=>{
 const first=pair({score:-50,macroScore:-6}),second=pair({id:'two',at:'2026-01-15T12:00:00Z',entry:'2026-01-16',score:50,macroScore:6});
 const result=run([second,first],{registeredAt:'2026-01-10T00:00:00+08:00'});
 assert.equal(result.windows.length,1);assert.equal(result.windows[0].checkpointId,'one');assert.equal(result.windows[0].evaluationPhase,'exploratory');
 assert.equal(result.excluded[0].reason,'overlapping_window');
});
test('different target, model, tier, horizon and basket are never pooled',()=>{
 const base=pair(),version=pair({id:'v2',version:'v2'}),tier=pair({id:'leading',tier:'leading'}),target=pair({id:'other',targetId:'cloud'}),horizon=pair({id:'m3',months:3}),basket=pair({id:'basket'});basket.cohort.basketVersion='basket-2';
 const result=run([base,version,tier,target,horizon,basket]);assert.equal(result.groups.length,6);assert.equal(result.windows.length,6);
 assert.ok(result.groups.every(group=>group.count===1));
});
test('registration distinguishes exploratory from prospective without relabeling old results',()=>{
 const early=pair(),late=pair({id:'late',at:'2026-03-01T12:00:00Z',entry:'2026-03-02'});
 const result=run([early,late],{registeredAt:'2026-02-01T00:00:00+08:00'});
 assert.equal(result.groups.length,2);assert.equal(result.counts.prospectiveWindows,1);assert.equal(result.counts.exploratoryWindows,1);
 assert.equal(run([early],{registeredAt:null}).status,'exploratory_only');assert.equal(run([early],{registeredAt:null}).registrationStatus,'not_registered');
 assert.equal(run([early],{registeredAt:'2027-01-01'}).registrationStatus,'not_registered');
});
test('date-only saved evaluation cannot leak into an earlier same-day training signal',()=>{
 const early=pair({evaluatedAt:'2026-03-01'}),late=pair({id:'late',at:'2026-03-01T12:00:00Z',entry:'2026-03-02'});
 const result=run([early,late]);assert.equal(result.windows[1].walkForward.trainingCount,0);
 early.cohort.windows[0].evaluatedAt='2026-02-28';assert.equal(run([early,late]).windows[1].walkForward.trainingCount,1);
});
test('training only uses same archived tier/model/horizon prior outcomes actually known then',()=>{
 const a=pair(),wrong=pair({id:'wrong',version:'v2'}),futureSave=pair({id:'futureSave',at:'2026-03-01T12:00:00Z',entry:'2026-03-02',evaluatedAt:'2026-10-01'}),latest=pair({id:'latest',at:'2026-06-01T12:00:00Z',entry:'2026-06-02'});
 const result=run([a,wrong,futureSave,latest]),window=result.windows.find(row=>row.checkpointId==='latest');
 assert.equal(window.walkForward.trainingCount,1);assert.deepEqual(window.walkForward.trainingWindowIds,['one:memory:1']);assert.equal(window.walkForward.priorMeanExcessReturnAt10Bps,null);
});
test('fixed score band boundaries and missing archived environment remain explicit',()=>{
 const rows=[-45,-15,0,15,45].map((score,index)=>pair({id:'band'+index,version:'version'+index,score,macroScore:null}));
 const result=run(rows);assert.deepEqual(result.windows.map(row=>row.scoreBand),['strong_negative','negative','neutral','positive','strong_positive']);
 assert.ok(result.windows.every(row=>row.marketRegime==='unknown'));assert.ok(result.groups.every(group=>group.sampleAdequacy==='insufficient_sample'));
});
test('negative scores observe long baskets rather than invented short profits',()=>{
 const fixture=pair({score:-60});fixture.cohort.windows[0].grossReturn=20;
 assert.equal(run([fixture]).windows[0].costScenarios[0].netReturn,20);
});
test('duplicate or ambiguous archive identities cannot double count samples',()=>{
 const fixture=pair(),duplicate=structuredClone(fixture);assert.equal(run([fixture,duplicate]).counts.acceptedWindows,0);
 const result=buildResearchValidation([fixture.record],{cohorts:[fixture.cohort,fixture.cohort]},{asOf:'2026-10-05'});assert.equal(result.windows.length,1);assert.equal(result.excluded[0].reason,'duplicate_frozen_window');
});
test('verification never mutates frozen follow-ups and is reproducible',()=>{
 const fixture=pair(),before=JSON.stringify(fixture);assert.deepEqual(run([fixture]),run([fixture]));assert.equal(JSON.stringify(fixture),before);
});
