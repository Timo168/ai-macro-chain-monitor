import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMacroOverlay,buildQuantitativeSignal,QUANT_MODEL_VERSION} from '../lib/industry/quant-model.mjs';

const periods=['2024-03-31','2024-06-30','2024-09-30','2024-12-31','2025-03-31','2025-06-30','2025-09-30','2025-12-31'];
const observations=values=>({observations:values.map((value,index)=>({periodEnd:periods[index],value,version:`v${index}`,sourceUrl:'https://example.com/source',fetchedAt:'2026-01-01'}))});
const definition=(id,entity,family,valueType='reported')=>({id,entity,family,frequency:'quarterly',normalUpdateDelayDays:65,valueType});
const definitions=[definition('MSFT.capex','MSFT','capex'),definition('MSFT.cloud','MSFT','cloud_revenue'),definition('GOOG.cloud','GOOG','cloud_revenue'),definition('MSFT.margin','MSFT','cloud_margin'),definition('US.power','US','electricity','official')];
const series={
 'MSFT.capex':observations([10,11,12,13,16,18,20,23]),
 'MSFT.cloud':observations([10,12,14,16,20,23,27,31]),
 'GOOG.cloud':observations([8,10,12,15,18,22,26,30]),
 'MSFT.margin':observations([20,20,21,21,23,24,25,27]),
 'US.power':observations([10,11,12,13,16,18,20,24])
};
const item=(metricId,direction,dimension)=>({metricId,observationVersion:'v7',periodEnd:'2025-12-31',direction,dimension,explanation:'test'});
const recommendation={
 targetId:'cloud',targetName:'AI云计算平台',level:'gradual_attention',coverage:1,missingMetrics:[],
 dimensions:[{id:'investment',name:'投资投入',state:'positive',metricIds:['MSFT.capex']},{id:'demand',name:'实际需求',state:'positive',metricIds:['MSFT.cloud','GOOG.cloud']},{id:'profitability',name:'盈利兑现',state:'positive',metricIds:['MSFT.margin']},{id:'costs',name:'成本与约束',state:'negative',metricIds:['US.power']}],
 positiveEvidence:[item('MSFT.capex','positive','investment'),item('MSFT.cloud','positive','demand'),item('GOOG.cloud','positive','demand'),item('MSFT.margin','positive','profitability')],
 negativeEvidence:[item('US.power','negative','costs')],neutralEvidence:[]
};
const macro=[
 {id:'DFII10',reasoningRole:'available_context',change:-10,changeUnit:'百分点',latestDate:'2026-01-01'},
 {id:'NFCI',reasoningRole:'available_context',change:-10,changeUnit:'指数点',latestDate:'2026-01-01'},
 {id:'PCEPILFE',reasoningRole:'available_context',change:-10,changeUnit:'%',latestDate:'2026-01-01'}
];

test('industry evidence factor model returns bounded, reproducible scored signals',()=>{
 const first=buildQuantitativeSignal(recommendation,{definitions,series,macroSignals:macro});
 const second=buildQuantitativeSignal({...recommendation,positiveEvidence:[...recommendation.positiveEvidence,recommendation.positiveEvidence[0]]},{definitions,series,macroSignals:macro});
 assert.equal(first.factorModelVersion,QUANT_MODEL_VERSION);
 assert.equal(first.scoringGate,'passed');
 assert.equal(first.calibration,'history_normalized');
 assert.equal(first.readiness.stage,'formal_research');
 assert.equal(first.readiness.investmentValidation,'not_started');
 assert.ok(first.score!==null&&first.score>=-100&&first.score<=100);
 assert.ok(first.fundamentalScore!==null&&first.fundamentalScore>=-100&&first.fundamentalScore<=100);
 assert.equal(first.score,second.score,'duplicate entity/family evidence must not add weight');
 assert.deepEqual(first.factorContributions.map(item=>[item.id,item.contribution]),second.factorContributions.map(item=>[item.id,item.contribution]));
 assert.equal(first.factorContributions.length,4);
 assert.ok(first.dataQualityScore>0&&first.dataQualityScore<=100);
});

test('complete same-issuer history takes precedence over a short extreme duplicate family',()=>{
 const duplicate=definition('MSFT.cloud_short','MSFT','cloud_revenue');
 const short={observations:series['MSFT.cloud'].observations.slice(-5).map((p,i)=>({...p,value:i===4?1000:p.value}))};
 const signal=buildQuantitativeSignal({...recommendation,positiveEvidence:[...recommendation.positiveEvidence,item(duplicate.id,'positive','demand')]},{definitions:[...definitions,duplicate],series:{...series,[duplicate.id]:short},macroSignals:macro});
 assert.equal(signal.scoringGate,'passed');
 const demand=signal.factorContributions.find(f=>f.id==='demand');assert.ok(demand.formalMetricIds.includes('MSFT.cloud'));assert.equal(demand.metricIds.includes(duplicate.id),false);
});

test('missing evidence and short histories suspend a score instead of turning them into zero',()=>{
 const missing=buildQuantitativeSignal({...recommendation,level:'insufficient_data',coverage:.75,missingMetrics:['PROJECT.construction_capacity']},{definitions,series,macroSignals:macro});
 assert.equal(missing.score,null);
 assert.equal(missing.scoringGate,'blocked_by_evidence');
 const shortSeries=Object.fromEntries(Object.entries(series).map(([id,row])=>[id,{observations:row.observations.slice(0,3)}]));
 const short=buildQuantitativeSignal(recommendation,{definitions,series:shortSeries,macroSignals:macro});
 assert.equal(short.score,null);
 assert.equal(short.scoringGate,'blocked_by_history');
 assert.ok(short.excludedMetricIds.includes('MSFT.capex'));
});

test('an incomplete target can expose a constrained leading score without opening its formal score',()=>{
 const leadingRecommendation={
  ...recommendation,targetId:'data_centers',targetName:'数据中心建设',level:'insufficient_data',coverage:.75,missingMetrics:['PROJECT.construction_capacity'],
  dimensions:[
   {id:'investment',name:'投资投入',state:'positive',metricIds:['MSFT.capex']},
   {id:'demand',name:'实际需求',state:'positive',metricIds:['MSFT.cloud','GOOG.cloud']},
   {id:'construction',name:'建设进度',state:'missing',metricIds:[]},
   {id:'costs',name:'成本与约束',state:'negative',metricIds:['US.power']}
  ],
  positiveEvidence:[item('MSFT.capex','positive','investment'),item('MSFT.cloud','positive','demand'),item('GOOG.cloud','positive','demand')],negativeEvidence:[item('US.power','negative','costs')],neutralEvidence:[]
 };
 const signal=buildQuantitativeSignal(leadingRecommendation,{definitions,series,macroSignals:macro});
 assert.equal(signal.score,null,'formal score must remain closed when construction evidence is absent');
 assert.equal(signal.scoringGate,'blocked_by_evidence');
 assert.equal(signal.leadingSignal.status,'available');
 assert.ok(signal.leadingSignal.score!==null&&signal.leadingSignal.score>=-100&&signal.leadingSignal.score<=100);
 assert.equal(signal.leadingSignal.availableFactorCount,3);
 assert.equal(signal.leadingSignal.requiredFactorCount,4);
 assert.match(signal.leadingSignal.limitation,/建设进度/);
});

test('proxy evidence can inform leading observation but cannot unlock a formal score',()=>{
 const proxyDefinition=definition('US.construction_proxy','US','grid_construction_spending','proxy');
 const proxyRecommendation={
  ...recommendation,targetId:'data_centers',targetName:'数据中心建设',level:'gradual_attention',coverage:1,missingMetrics:[],
  dimensions:[
   {id:'investment',name:'投资投入',state:'positive',metricIds:['MSFT.capex']},
   {id:'demand',name:'实际需求',state:'positive',metricIds:['MSFT.cloud','GOOG.cloud']},
   {id:'construction',name:'建设进度',state:'positive',metricIds:['US.construction_proxy']},
   {id:'costs',name:'成本与约束',state:'negative',metricIds:['US.power']}
  ],
  positiveEvidence:[item('MSFT.capex','positive','investment'),item('MSFT.cloud','positive','demand'),item('GOOG.cloud','positive','demand'),item('US.construction_proxy','positive','construction')],negativeEvidence:[item('US.power','negative','costs')],neutralEvidence:[]
 };
 const signal=buildQuantitativeSignal(proxyRecommendation,{definitions:[...definitions,proxyDefinition],series:{...series,'US.construction_proxy':observations([10,12,14,17,20,22,26,30])},macroSignals:macro});
 assert.equal(signal.score,null);
 assert.equal(signal.scoringGate,'blocked_by_directness');
 assert.equal(signal.leadingSignal.status,'available');
 assert.equal(signal.factorContributions.find(factor=>factor.id==='construction')?.formalContribution,null);
 assert.ok(signal.leadingSignal.score!==null);
});

test('a proxy demand metric cannot satisfy the leading direct-entity breadth rule',()=>{
 const proxyDefinition=definition('US.demand_proxy','US','computer_electronics_orders','proxy');
 const proxyRecommendation={
  ...recommendation,targetId:'data_centers',targetName:'数据中心建设',level:'insufficient_data',coverage:.75,missingMetrics:['PROJECT.construction_capacity'],
  dimensions:[
   {id:'investment',name:'投资投入',state:'positive',metricIds:['MSFT.capex']},
   {id:'demand',name:'实际需求',state:'positive',metricIds:['US.demand_proxy']},
   {id:'construction',name:'建设进度',state:'missing',metricIds:[]},
   {id:'costs',name:'成本与约束',state:'negative',metricIds:['US.power']}
  ],
  positiveEvidence:[item('MSFT.capex','positive','investment'),item('US.demand_proxy','positive','demand')],negativeEvidence:[item('US.power','negative','costs')],neutralEvidence:[]
 };
 const signal=buildQuantitativeSignal(proxyRecommendation,{definitions:[...definitions,proxyDefinition],series:{...series,'US.demand_proxy':observations([10,12,14,17,20,22,26,30])},macroSignals:macro});
 assert.equal(signal.leadingSignal.status,'insufficient_evidence');
 assert.equal(signal.leadingSignal.directDemandEntityCount,0);
 assert.equal(signal.leadingSignal.requiredDemandEntityCount,2);
 assert.match(signal.leadingSignal.limitation,/实际需求的直接证据覆盖 0\/2/);
});

test('a missing historical quarter cannot be promoted to normalized formal history',()=>{
 const gaps={...series,'MSFT.capex':{observations:series['MSFT.capex'].observations.filter(point=>point.periodEnd!=='2024-09-30')}};
 const signal=buildQuantitativeSignal(recommendation,{definitions,series:gaps,macroSignals:macro});
 assert.equal(signal.score,null);
 assert.equal(signal.factorContributions.find(factor=>factor.id==='investment').formalContribution,null);
 assert.ok(signal.readiness.blockers.some(blocker=>blocker.factorId==='investment'&&blocker.code==='history_gap'));
});

test('a complete recent eight-quarter window can recover from an older missing quarter',()=>{
 const extraPeriods=['2022-09-30','2022-12-31',...periods];
 const recovered=Object.fromEntries(Object.entries(series).map(([id,row])=>[id,{observations:[{periodEnd:extraPeriods[0],value:5,version:'older'},...row.observations]}]));
 const complete=buildQuantitativeSignal(recommendation,{definitions,series:recovered,macroSignals:macro});
 assert.equal(complete.scoringGate,'passed');
 assert.equal(complete.factorContributions[0].metricDiagnostics[0].history.windowStart,'2024-03-31');
 const recentGap={...recovered,'MSFT.capex':{observations:recovered['MSFT.capex'].observations.filter(point=>point.periodEnd!=='2025-06-30')}};
 const blocked=buildQuantitativeSignal(recommendation,{definitions,series:recentGap,macroSignals:macro});
 assert.equal(blocked.score,null);
 assert.ok(blocked.readiness.blockers.some(blocker=>blocker.code==='history_gap'&&blocker.remedy.includes('2025-06')));
});

test('monthly price levels require enough baselines for four annual comparisons',()=>{
 const monthlyDefinition={...definitions.at(-1),frequency:'monthly'};
 const dates=Array.from({length:16},(_,index)=>new Date(Date.UTC(2024,8+index+1,0)).toISOString().slice(0,10));
 const monthlySeries={observations:dates.map((periodEnd,index)=>({periodEnd,value:10+index,version:`monthly-${index}`}))};
 const full=buildQuantitativeSignal(recommendation,{definitions:[...definitions.slice(0,-1),monthlyDefinition],series:{...series,'US.power':monthlySeries}});
 assert.equal(full.scoringGate,'passed');
 const short=buildQuantitativeSignal(recommendation,{definitions:[...definitions.slice(0,-1),monthlyDefinition],series:{...series,'US.power':{observations:monthlySeries.observations.slice(-8)}}});
 assert.equal(short.score,null);
 const cost=short.readiness.blockers.find(blocker=>blocker.factorId==='costs');
 assert.equal(cost.actual,8);
 assert.equal(cost.required,16);
});

test('readiness lists construction and demand breadth failures together',()=>{
 const incomplete={...recommendation,targetId:'data_centers',level:'insufficient_data',coverage:.5,positiveEvidence:[item('MSFT.capex','positive','investment'),item('MSFT.cloud','positive','demand')],negativeEvidence:[],neutralEvidence:[]};
 const signal=buildQuantitativeSignal(incomplete,{definitions,series});
 assert.equal(signal.readiness.stage,'needs_evidence');
 assert.ok(signal.readiness.blockers.some(blocker=>blocker.factorId==='construction'&&blocker.code==='missing_evidence'));
 assert.ok(signal.readiness.blockers.some(blocker=>blocker.code==='demand_breadth'&&blocker.actual===1&&blocker.required===2));
});

test('annual-release sources retain publication-based review deadlines',()=>{
 const annualReleaseDefinition={...definitions[0],freshnessBasis:'source_publication',sourceReleaseFrequency:'annual',sourceReleaseDelayDays:35};
 const annualReleaseSeries={observations:series['MSFT.capex'].observations.map(point=>({...point,publishedAt:'2026-07-15'}))};
 const onlyPublication={...recommendation,positiveEvidence:[item('MSFT.capex','positive','investment')],negativeEvidence:[]};
 const signal=buildQuantitativeSignal(onlyPublication,{definitions:[annualReleaseDefinition],series:{'MSFT.capex':annualReleaseSeries}});
 assert.equal(signal.validUntil,'2027-08-20');
});

test('sharp deceleration while growth stays positive weakens rather than strengthens its positive factor',()=>{
 const slowing={...series,'MSFT.capex':observations([100,100,100,100,200,220,240,120])};
 const accelerating={...series,'MSFT.capex':observations([100,100,100,100,120,125,130,140])};
 const slow=buildQuantitativeSignal(recommendation,{definitions,series:slowing});
 const fast=buildQuantitativeSignal(recommendation,{definitions,series:accelerating});
 const slowFactor=slow.factorContributions.find(factor=>factor.id==='investment');
 const fastFactor=fast.factorContributions.find(factor=>factor.id==='investment');
 assert.ok(slowFactor.formalContribution>0,'rule-approved growth direction stays positive');
 assert.ok(slowFactor.formalContribution<fastFactor.formalContribution,'growth falling from 140% to 20% must not look stronger than acceleration');
});

test('company-total alias families are coalesced while business-segment revenue keeps its own scope',()=>{
 const totalRevenue=definition('MSFT.total_quarter','MSFT','company_revenue');
 const monthlyAlias=definition('MSFT.total_month','MSFT','revenue');
 const gross=definition('MSFT.company_gross','MSFT','company_gross_margin');
 const grossAlias=definition('MSFT.gross','MSFT','gross_margin');
 const added=[item(totalRevenue.id,'positive','demand'),item(gross.id,'positive','profitability')];
 const additionalSeries={...series,[totalRevenue.id]:series['MSFT.cloud'],[monthlyAlias.id]:series['MSFT.cloud'],[gross.id]:series['MSFT.margin'],[grossAlias.id]:series['MSFT.margin']};
 const baseline=buildQuantitativeSignal({...recommendation,positiveEvidence:[...recommendation.positiveEvidence,...added]},{definitions:[...definitions,totalRevenue,gross],series:additionalSeries});
 const duplicated=buildQuantitativeSignal({...recommendation,positiveEvidence:[...recommendation.positiveEvidence,...added,item(monthlyAlias.id,'positive','demand'),item(grossAlias.id,'positive','profitability')]},{definitions:[...definitions,totalRevenue,monthlyAlias,gross,grossAlias],series:additionalSeries});
 assert.equal(duplicated.score,baseline.score);
 assert.equal(duplicated.factorContributions.find(factor=>factor.id==='demand').sourceGroupCount,3,'cloud-segment and company-total revenues keep distinct scopes');
 assert.equal(duplicated.factorContributions.find(factor=>factor.id==='profitability').sourceGroupCount,2,'cloud margin and company gross margin keep distinct scopes');
});

test('macro overlay is capped and requires more than one valid macro factor',()=>{
 const overlay=buildMacroOverlay(macro);
 assert.equal(overlay.applied,true);
 assert.ok(overlay.score>=-10&&overlay.score<=10);
 const incomplete=buildMacroOverlay(macro.slice(0,1));
 assert.equal(incomplete.applied,false);
 assert.equal(incomplete.score,0);
});
