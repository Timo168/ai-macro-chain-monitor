import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResearchPacket,modelPrompt} from '../lib/industry/research.mjs';

const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const definition={id:'MSFT.capex',entity:'MSFT',nameZh:'现金资本开支',sourceUrl:'https://example.org/filing',recommendationEligible:true,category:'capex',family:'capex',frequency:'quarterly',unit:'亿美元',valueType:'reported'};
const recommendation={targetId:'cloud',targetName:'AI云计算平台',level:'gradual_attention',confidence:'medium',coverage:1,formalCoverage:1,requiredDimensionCount:4,availableDimensionCount:4,reason:'当前已更新的结论',dataCutoffAt:'2026-09-30',positiveEvidence:[{metricId:definition.id,periodEnd:'2026-09-30',observationVersion:'unpublished',dimension:'investment',direction:'positive'}],negativeEvidence:[],neutralEvidence:[],missingMetrics:[],invalidationConditions:[]};
const base={definitions:[definition],series:{},recommendations:[recommendation]};
function packet(industry=base,macro={series:{}},policyRates={},decisions={},asOfDate='2026-07-31'){
 return buildResearchPacket(industry,macro,[],policyRates,decisions,{asOfDate});
}
const point=(periodEnd,publishedAt,value,version='known')=>({periodEnd,publishedAt,value,version,sourceUrl:'https://example.org/filing'});

test('historical cutoff filters unannounced facts from context, references and actual calculations',()=>{
 const history=[point('2026-06-30','2026-07-30',100),point('2026-09-30','2026-10-30',987654,'unpublished'),point('2026-06-30','2026-08-01',876543,'later-revision')];
 const p=packet({...base,series:{[definition.id]:{status:'ready',observations:history}}});
 assert.deepEqual(p.fullSiteContext.industryMetrics[0].observations.map(o=>o.value),[100]);
 assert.deepEqual(p.calculationInputs.series[definition.id].observations.map(o=>o.value),[100]);
 assert.deepEqual(p.observationManifest.map(o=>o.version),['known']);
 assert.ok(p.quantitative.sectorSignals[0].evidenceRefs.every(r=>r.observationVersion!=='unpublished'));
 assert.equal(p.quantitative.sectorSignals[0].score,null);
 assert.equal(p.quantitative.sectorSignals[0].stance,'insufficient_data');
 assert.equal(modelPrompt(p).includes('987654'),false);
 assert.equal(modelPrompt(p).includes('876543'),false);
 assert.equal(p.temporalBoundary.availabilityMode,'historical_point_in_time');
});

test('macro freshness uses the historical cutoff, not the machine date, and unknown publication is explicit',()=>{
 const p=packet(base,{series:{DFII10:{status:'ready',observations:[{date:'2026-01-09',publishedAt:'2026-01-09',value:1.5},{date:'2026-01-12',publishedAt:'2026-01-12',value:999}]},DGS10:{status:'ready',observations:[{date:'2026-01-09',value:888}]}}},{},{},'2026-01-10');
 const real=p.macroSignals.find(s=>s.id==='DFII10'),unknown=p.macroSignals.find(s=>s.id==='DGS10');
 assert.equal(real.latestValue,1.5);assert.equal(real.reasoningRole,'available_context');
 assert.equal(unknown.latestValue,null);assert.equal(unknown.reasoningRole,'excluded');
 assert.match(unknown.exclusionReason,/发布时间/);
 assert.equal(p.contextRefs.some(r=>r.metricId==='DGS10'),false);
});

test('precise publication and revision timestamps respect the end of the Beijing cutoff day',()=>{
 const p=packet({...base,series:{[definition.id]:{status:'ready',observations:[point('2026-06-30','2026-07-31T15:59:59Z',100),point('2026-06-30','2026-07-31T16:00:00Z',987654,'next-beijing-day'),{...point('2026-06-30','2026-07-01',876543,'later-revision'),revisionPublishedAt:'2026-08-01'}]}}});
 assert.deepEqual(p.observationManifest.map(o=>o.value),[100]);
 assert.equal(modelPrompt(p).includes('987654'),false);
 assert.equal(modelPrompt(p).includes('876543'),false);
});

test('current observations without source publication remain usable, while future dates never qualify',()=>{
 const p=packet({...base,series:{[definition.id]:{status:'ready',observations:[{periodEnd:today,value:100,version:'current-no-publication'}]}}},{series:{DFII10:{status:'ready',observations:[{date:today,value:1.5},{date:'2099-01-01',value:987654}]}}},{},{},today);
 assert.equal(p.macroSignals.find(s=>s.id==='DFII10').latestValue,1.5);
 assert.equal(p.macroSignals.find(s=>s.id==='DFII10').publicationStatus,'current_observation_only');
 assert.equal(p.fullSiteContext.industryMetrics[0].reasoningRole,'available_context');
 assert.equal(p.fullSiteContext.industryMetrics[0].publicationStatus,'current_observation_only');
 assert.equal(modelPrompt(p).includes('987654'),false);
 assert.equal(p.temporalBoundary.availabilityMode,'current_observation');
});

test('future publication timestamp is not visible during the current calendar day',()=>{
 const future=new Date(Date.now()+3600000).toISOString();
 const p=packet(base,{series:{DFII10:{status:'ready',observations:[{date:today,value:987654,publishedAt:future}]}}},{},{},today);
 assert.equal(p.macroSignals.find(s=>s.id==='DFII10').latestValue,null);
 assert.equal(p.contextRefs.some(r=>r.metricId==='DFII10'),false);
});

test('policy rate and policy event distinguish announced decisions from effective rates',()=>{
 const rates={series:[{id:'fed',name:'美联储',country:'美国',status:'ready',latestValue:99,latestObservationDate:'2026-12-01',observations:[{date:'2026-06-01',publishedAt:'2026-06-30',value:3.5},{date:'2026-12-01',publishedAt:'2027-01-01',value:99}]}]};
 const decisions={checks:[{bankId:'fed',decisionStatus:'verified'}],decisions:[{bankId:'fed',announcementDate:'2026-07-31',effectiveDate:'2026-08-01',midpoint:4,archive:{statementSha256:'announced'},statementUrl:'https://example.org/policy'},{bankId:'fed',announcementDate:'2026-08-15',effectiveDate:'2026-08-16',midpoint:98,archive:{statementSha256:'future'}}]};
 const p=packet(base,{},rates,decisions);
 assert.equal(p.policyRateSignals[0].latestValue,3.5);
 assert.equal(p.policyRateSignals[0].latestDate,'2026-06-01');
 assert.equal(p.fullSiteContext.policyDecisionEvents.length,1);
 assert.equal(p.fullSiteContext.policyDecisionEvents[0].effectiveStatus,'announced_not_effective');
 assert.equal(p.fullSiteContext.policyDecisionEvents[0].reference.periodEnd,'2026-07-31');
 assert.equal(p.fullSiteContext.policyDecisionEvents[0].reasoningRole,'background_only');
 const later=packet(base,{},rates,decisions,'2026-08-02');
 assert.equal(later.policyRateSignals[0].latestValue,4);
 assert.equal(later.policyRateSignals[0].decisionStatus,'verified');
});

test('future releases are removed while already disclosed forecast scenarios stay separate from actuals',()=>{
 const report={id:'known',title:'Published forecast',publisher:'Institute',publishedAt:'2026-07-01',sourceUrl:'https://example.org/report',version:'known-report',status:'ready',modelUseAllowed:true,facts:[{period:'2025',value:100,nature:'actual'},{period:'2030',value:200,nature:'forecast'},{period:'2030',value:987654,nature:'actual'}]};
 const p=packet({...base,events:[{id:'plan',date:'2026-07-01',isConfirmed:true,observationNature:'forecast',description:'计划2030年投产。'},{id:'future',date:'2026-08-01',isConfirmed:true,description:'987654'}],researchReports:[report,{...report,id:'unpublished',publishedAt:'2026-08-01',title:'987654'}]});
 assert.deepEqual(p.fullSiteContext.industryEvents.map(e=>e.id),['EVENT.plan']);
 assert.deepEqual(p.institutionalReports.map(r=>r.id),['known']);
 assert.deepEqual(p.institutionalReports[0].facts.map(f=>f.modelRole),['context','scenario_only']);
 assert.equal(p.contextRefs.some(r=>r.metricId==='EVENT.future'||r.metricId==='REPORT.unpublished'),false);
 assert.equal(modelPrompt(p).includes('987654'),false);
});

test('historical project status and capacity are taken from visible disclosures, never current metadata',()=>{
 const project={id:'project',name:'Project',status:'operational',announcedAt:'2026-01-01',powerCapacityMw:987654,statusHistory:[{date:'2026-06-01',status:'construction',capacityMw:100,sourceUrl:'https://example.org/old'},{date:'2026-08-01',status:'operational',capacityMw:200,sourceUrl:'https://example.org/new'}]};
 const p=packet({...base,projects:[project,{id:'future',announcedAt:'2026-08-01',status:'operational',powerCapacityMw:987654}]});
 assert.equal(p.fullSiteContext.projects.records.length,1);
 assert.equal(p.fullSiteContext.projects.records[0].status,'construction');
 assert.equal(p.fullSiteContext.projects.records[0].capacityMw,100);
 assert.equal(modelPrompt(p).includes('987654'),false);
});

test('invalid and future cutoff requests do not manufacture research',()=>{
 assert.throws(()=>packet(base,{},{},{},'2026-02-30'),/截止日无效/);
 assert.throws(()=>packet(base,{},{},{},'2099-01-01'),/不能在未来/);
});

test('restatements with unknown revision availability are excluded only from historical reconstruction',()=>{
 const restated={...point('2026-06-30','2026-07-01',876543,'restated-unknown'),isRestated:true,fetchedAt:'2026-08-15T10:00:00Z'};
 const historical=packet({...base,series:{[definition.id]:{status:'ready',observations:[restated]}}});
 assert.equal(historical.observationManifest.length,0);
 assert.equal(modelPrompt(historical).includes('876543'),false);
 const current=packet({...base,series:{[definition.id]:{status:'ready',observations:[restated]}}},{},{},{},today);
 assert.equal(current.observationManifest[0].value,876543);
});

test('one latest disclosed vintage per period is selected regardless of source ordering',()=>{
 const original=point('2026-06-30','2026-07-01',100,'original');
 const revised={...point('2026-06-30','2026-07-01',110,'revision'),isRestated:true,revisionPublishedAt:'2026-07-20'};
 const future={...revised,value:876543,version:'later',revisionPublishedAt:'2026-08-15'};
 for(const observations of [[future,revised,original],[original,revised,future]]){
  const p=packet({...base,series:{[definition.id]:{status:'ready',observations}}});
  assert.deepEqual(p.observationManifest.map(o=>[o.value,o.version]),[[110,'revision']]);
  assert.equal(p.calculationInputs.series[definition.id].observations.length,1);
 }
});

test('publication offsets compare actual instants and Beijing early-morning observations remain current',t=>{
 const historical=packet({...base,series:{[definition.id]:{status:'ready',observations:[point('2026-06-30','2026-08-01T00:00:00+14:00',100)]}}});
 assert.equal(historical.observationManifest[0].value,100,'next source calendar day is still within July 31 in Beijing');
 t.mock.method(Date,'now',()=>Date.parse('2026-07-31T17:00:00Z'));
 const current=packet(base,{series:{DFII10:{status:'ready',observations:[{date:'2026-08-01',publishedAt:'2026-08-01',value:1.5}]},DGS10:{status:'ready',observations:[{date:'2026-08-01',value:2}]}}},{},{},'2026-08-01');
 assert.equal(current.temporalBoundary.availabilityMode,'current_observation');
 assert.equal(current.macroSignals.find(s=>s.id==='DFII10').reasoningRole,'available_context');
 assert.equal(current.macroSignals.find(s=>s.id==='DGS10').reasoningRole,'available_context');
});

test('disclosed future dated plans remain scenario context without moving the actual data cutoff forward',()=>{
 const p=packet({...base,events:[{id:'future-plan',date:'2030-06-01',publishedAt:'2026-07-01',isConfirmed:true,observationNature:'forecast',description:'预计未来投产。'},{id:'future-actual',date:'2030-06-01',publishedAt:'2026-07-01',isConfirmed:true,observationNature:'actual',description:'987654'}]});
 assert.deepEqual(p.fullSiteContext.industryEvents.map(e=>e.id),['EVENT.future-plan']);
 assert.equal(p.fullSiteContext.industryEvents[0].observationNature,'forecast');
 assert.equal(p.fullSiteContext.industryEvents[0].reasoningRole,'background_only');
 assert.ok(p.contextRefs.some(ref=>ref.metricId==='EVENT.future-plan'&&ref.periodEnd==='2030-06-01'));
 assert.equal(p.dataCutoffAt,'2026-07-01');
 assert.equal(modelPrompt(p).includes('987654'),false);
});

test('an unfinished annual period cannot be presented as an actual full-year result',()=>{
 const report={id:'annual',publishedAt:'2026-07-01',sourceUrl:'https://example.org/report',version:'v1',status:'ready',modelUseAllowed:true,facts:[{period:'2025',value:100,nature:'actual'},{period:'2026',value:987654,nature:'actual'},{period:'2026',value:200,nature:'forecast'}]};
 const p=packet({...base,researchReports:[report]});
 assert.deepEqual(p.institutionalReports[0].facts.map(f=>[f.value,f.modelRole]),[[100,'context'],[200,'scenario_only']]);
 assert.equal(modelPrompt(p).includes('987654'),false);
});
