import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalResearchPacket,createLocalResearchPrompt} from '../lib/industry/local-research.mjs';
import {validateModelAnalysis} from '../lib/industry/research.mjs';

const ref=(metricId,version='v1',periodEnd='2026-06-30')=>({metricId,observationVersion:version,periodEnd,sourceUrl:'https://example.com/source',sourcePublishedAt:'2026-07-20'});
function fixture(){
 const refs=[{...ref('CAPEX'),dimension:'investment',direction:'positive'},{...ref('CASH'),dimension:'profitability',direction:'negative'},{...ref('DEMAND'),dimension:'demand',direction:'positive'}];
 const sector={targetId:'cloud',targetName:'云平台',stance:'gradual_attention',confidence:'medium',score:20,fundamentalScore:25,reason:'需求正面但盈利承压。',dataCutoffAt:'2026-06-30',evidenceRefs:refs,missingMetrics:['orders'],invalidationConditions:['需求与盈利持续走弱时重新评估。'],factorContributions:refs.map(item=>({id:item.dimension,state:item.direction,formalMetricIds:[item.metricId],formalContribution:1,basis:'normalized_history'})),readiness:{blockers:[]}};
 const overall={...sector,targetId:'overall',targetName:'整体',stance:'insufficient_data',confidence:'low',score:null,missingMetrics:['construction']};
 const metrics=refs.map((r,index)=>({metricId:r.metricId,name:r.metricId+'指标',unit:'亿美元',status:'ready',reasoningRole:'available_context',publicationStatus:'source_publication_known',observations:[{periodEnd:r.periodEnd,version:r.observationVersion,value:100+index,publishedAt:'2026-07-20',sourceUrl:r.sourceUrl}]}));
 const context={...ref('DFII10'),sourceUrl:'https://example.com/rate'};
 return {quantitative:{sectorSignals:[sector,overall],overall},marketRegime:'mixed_evidence',temporalBoundary:{asOfDate:'2026-08-01'},fullSiteContext:{industryMetrics:metrics},macroSignals:[{id:'DFII10',name:'实际收益率',unit:'%',status:'cached',reasoningRole:'available_context',reference:context,latestValue:2,comparisonDate:'2026-05-31',comparisonValue:1.5,change:.5,changeUnit:'百分点'}],contextRefs:[context],institutionalReports:[]};
}

test('local packet keeps every target, exact values, opposite evidence, gaps and conditions without mutation',()=>{
 const packet=fixture(),before=JSON.stringify(packet),compact=createLocalResearchPacket(packet);
 assert.equal(JSON.stringify(packet),before);
 assert.deepEqual(compact.targets.map(target=>[target.targetId,target.stance,target.confidence]),packet.quantitative.sectorSignals.map(target=>[target.targetId,target.stance,target.confidence]));
 assert.equal(compact.evidence.length,3,'shared target references are stored once');
 assert.equal(compact.sources.length,2);
 assert.equal(compact.conditions.length,1);
 assert.deepEqual(compact.targets[0].missingMetricIds,['orders']);
 assert.deepEqual(compact.targets[0].evidence.map(item=>item[2]).sort(),['negative','positive','positive']);
 assert.equal(compact.evidence[0][0].observationVersion,'v1');
 assert.equal(compact.evidence[0][0].periodEnd,'2026-06-30');
 assert.equal(compact.evidence[0][2],100);
 assert.equal(compact.evidence[0][3],'亿美元');
 assert.equal(compact.background[0][5],'cached');
 assert.match(createLocalResearchPrompt(packet),/所有2个targets/);
 compact.targets[0].missingMetricIds.push('mutated');
 assert.deepEqual(packet.quantitative.sectorSignals[0].missingMetrics,['orders']);
});

test('local input never substitutes latest value for the exact revision and never sends excluded values',()=>{
 const packet=fixture();
 packet.fullSiteContext.industryMetrics[0].observations=[{version:'v2',periodEnd:'2026-06-30',value:999999}];
 packet.macroSignals[0].reasoningRole='excluded';packet.macroSignals[0].latestValue=987654;packet.macroSignals[0].exclusionReason='已过期';
 const compact=createLocalResearchPacket(packet),prompt=createLocalResearchPrompt(packet);
 assert.equal(compact.evidence[0][2],null);
 assert.equal(compact.evidence[0][0].observationVersion,'v1');
 assert.deepEqual(compact.excluded,[['DFII10','cached','已过期']]);
 assert.equal(prompt.includes('987654'),false);
 assert.equal(prompt.includes('999999'),false);
 assert.equal(compact.background.length,0);
});

test('model selection does not discard the only opposite evidence or add a proxy as direct evidence',()=>{
 const packet=fixture(),sector=packet.quantitative.sectorSignals[0];
 sector.evidenceRefs.unshift({...ref('CHEAP_COST'),dimension:'profitability',direction:'positive'});
 sector.leadingEvidenceRefs=[{...ref('PROXY'),dimension:'demand',direction:'positive'}];
 const compact=createLocalResearchPacket(packet);
 assert.ok(compact.targets[0].evidence.some(row=>row[2]==='negative'));
 assert.equal(compact.evidence.some(row=>row[0].metricId==='PROXY'),false);
});

test('permission and actual versus forecast boundaries survive local report compression',()=>{
 const packet=fixture(),forecast=ref('REPORT.public','report-v1','2030');
 packet.contextRefs.push(forecast);
 const report={title:'Permitted report',status:'ready',modelUseAllowed:true,unit:'TWh',scope:'global',boundary:'情景不能补齐评分',facts:[{reference:forecast,label:'预测用电',value:100,nature:'forecast',modelRole:'scenario_only'}]};
 packet.institutionalReports=[report,{...report,title:'DENIED_REPORT',modelUseAllowed:false,facts:[{...report.facts[0],label:'DENIED_FACT',value:998877}]}];
 const compact=createLocalResearchPacket(packet),prompt=createLocalResearchPrompt(packet);
 assert.equal(compact.background.at(-1)[4],'scenario_only');
 assert.equal(compact.background.at(-1)[7].nature,'forecast');
 assert.equal(prompt.includes('998877'),false);
 assert.equal(prompt.includes('DENIED_FACT'),false);
});

test('empty seed is rejected and local prompt does not bypass original output validation',()=>{
 assert.throws(()=>createLocalResearchPacket({quantitative:{sectorSignals:[]}}),/空种子包/);
 const packet=fixture();createLocalResearchPrompt(packet);
 assert.throws(()=>validateModelAnalysis({overallStance:'positive_allocation',marketRegime:'mixed_evidence',confidence:'high',sectorViews:[]},packet,{requireScenarios:true}),/量化证据门槛/);
 assert.throws(()=>validateModelAnalysis({overallStance:'insufficient_data',summary:'证据不足',marketRegime:'mixed_evidence',confidence:'low',sectorViews:[]},packet,{requireScenarios:true}),/遗漏/);
});
