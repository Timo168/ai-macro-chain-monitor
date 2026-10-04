import test from 'node:test';
import assert from 'node:assert/strict';
import {generateRecommendations} from '../lib/industry/engine.mjs';
import {buildQuantitativeSignal} from '../lib/industry/quant-model.mjs';
import {buildResearchPacket,modelPrompt} from '../lib/industry/research.mjs';

// Synthetic source observations exercise calculation boundaries; they are not
// company data and are never written to collectors, caches, or public output.
const asOf='2026-08-15';
const periods=['2024-09-30','2024-12-31','2025-03-31','2025-06-30','2025-09-30','2025-12-31','2026-03-31','2026-06-30'];
const samples=[
 {entity:'AMKR',targetId:'packaging_operations',revenueFamily:'advanced_products_revenue',reportingScope:'advanced_products'},
 {entity:'ENTG',targetId:'semiconductor_materials',revenueFamily:'company_revenue',reportingScope:'company_total'}
];
function fixture(){
 const definitions=[],series={};
 for(const sample of samples){
  for(const [suffix,family,values,unit] of [
   ['capex','capex',[10,11,12,13,16,18,21,25],'亿美元'],
   ['revenue',sample.revenueFamily,[100,110,120,130,155,180,212,250],'亿美元'],
   ['gross_margin','gross_margin',[20,21,22,23,26,28,31,35],'%']
  ]){
   const id=sample.entity+'.'+suffix;
   const definition={id,entity:sample.entity,nameZh:suffix,category:'semiconductors',family,unit,frequency:'quarterly',valueType:'reported',recommendationEligible:true,normalUpdateDelayDays:65,sourceName:'Synthetic official filing fixture',sourceUrl:'https://example.org/'+id,reportingScope:suffix==='revenue'?sample.reportingScope:'company_total',researchTargets:[sample.targetId]};
   definitions.push(definition);
   series[id]={status:'ready',observations:values.map((value,index)=>({metricId:id,periodEnd:periods[index],value,version:id+'-v'+index,publishedAt:new Date(Date.parse(periods[index])+25*86400000).toISOString(),fetchedAt:'2026-08-01T00:00:00Z',sourceUrl:definition.sourceUrl,isEstimated:false,isRestated:false}))};
  }
 }
 return {definitions,series};
}
function score(data,targetId){
 const recommendation=generateRecommendations(data,asOf).find(item=>item.targetId===targetId);
 return {recommendation,signal:buildQuantitativeSignal(recommendation,{definitions:data.definitions,series:data.series})};
}

test('continuous disclosed histories unlock exactly three operating-sample factors with medium confidence',()=>{
 const data=fixture();
 for(const sample of samples){
  const {recommendation,signal}=score(data,sample.targetId);
  assert.equal(recommendation.requiredDimensionCount,3);
  assert.equal(recommendation.formalAvailableDimensionCount,3);
  assert.equal(recommendation.confidence,'medium');
  assert.equal(signal.scoringGate,'passed');
  assert.ok(Number.isFinite(signal.score));
  assert.deepEqual(signal.factorContributions.map(f=>f.id),['investment','demand','profitability']);
  assert.equal(signal.readiness.formalDemandEntityCount,1);
  assert.equal(signal.readiness.requiredDemandEntityCount,1);
  assert.ok(signal.factorContributions.every(f=>f.basis==='normalized_history'));
  assert.equal(signal.researchScope,'company_operating_sample');
  assert.ok(signal.scopeBoundary.includes(sample.entity==='AMKR'?'Amkor':'Entegris'));
  assert.equal(signal.readiness.investmentValidation,'not_started');
 }
});

test('single-company operating evidence cannot unlock broad packaging, resources, or overall industry conclusions',()=>{
 const data=fixture();
 for(const targetId of ['packaging','materials','overall']){
  const {recommendation,signal}=score(data,targetId);
  assert.equal(recommendation.level,'insufficient_data');
  assert.equal(signal.score,null);
  assert.deepEqual([...recommendation.positiveEvidence,...recommendation.negativeEvidence,...recommendation.neutralEvidence],[]);
  assert.ok(signal.factorContributions.every(f=>!f.metricIds.some(id=>id.startsWith('AMKR.')||id.startsWith('ENTG.'))));
 }
});

test('materials cost ratios remain background and cannot double count the gross-margin factor',()=>{
 const data=fixture(),baseline=score(data,'packaging_operations').signal;
 const id='AMKR.material_cost_ratio';
 data.definitions.push({id,entity:'AMKR',nameZh:'材料成本占收入',category:'semiconductors',family:'material_cost_ratio',unit:'%',frequency:'quarterly',valueType:'reported',recommendationEligible:true,researchTargets:['packaging_operations'],normalUpdateDelayDays:65});
 data.series[id]={status:'ready',observations:data.series['AMKR.gross_margin'].observations.map((point,index)=>({...point,metricId:id,value:60-index*3,version:'cost-'+index}))};
 const next=score(data,'packaging_operations');
 assert.equal(next.signal.score,baseline.score);
 assert.deepEqual(next.signal.factorContributions,baseline.factorContributions);
 assert.equal(next.signal.factorContributions.some(f=>f.id==='costs'),false);
 assert.equal([...next.recommendation.positiveEvidence,...next.recommendation.negativeEvidence,...next.recommendation.neutralEvidence].some(item=>item.metricId===id),false);
});

test('failed or unconfigured revenue cannot be rescued by residual numerical histories',()=>{
 for(const sample of samples){
  for(const status of ['fetch_failed','not_configured','pending','no_observation','authorization_required']){
   const data=fixture();data.series[sample.entity+'.revenue'].status=status;
   const {recommendation,signal}=score(data,sample.targetId);
   assert.equal(recommendation.level,'insufficient_data',status);
   assert.equal(signal.score,null,status);
   assert.equal(signal.readiness.formalDemandEntityCount,0,status);
  }
  const cached=fixture();cached.series[sample.entity+'.revenue'].status='cached';
  assert.equal(score(cached,sample.targetId).signal.scoringGate,'passed','valid explicitly cached history remains usable');
 }
});

test('short, internally gapped, estimated and stale histories retain formal scoring gates',()=>{
 for(const sample of samples){
  for(const failure of ['short','gap','estimated','stale']){
   const data=fixture(),series=data.series[sample.entity+'.revenue'];
   if(failure==='short')series.observations=series.observations.slice(-7);
   if(failure==='gap')series.observations=series.observations.filter(point=>point.periodEnd!=='2025-12-31');
   if(failure==='estimated')series.observations.at(-1).isEstimated=true;
   if(failure==='stale')series.observations=series.observations.filter(point=>point.periodEnd<='2025-12-31');
   const {signal}=score(data,sample.targetId);
   assert.equal(signal.score,null,sample.entity+' '+failure);
   assert.notEqual(signal.scoringGate,'passed');
   if(['short','gap'].includes(failure))assert.ok(signal.readiness.blockers.some(item=>item.factorId==='demand'&&['short_history','history_gap'].includes(item.code)));
  }
 }
});

test('the reasoning packet preserves operating-sample scope and boundary instead of widening its claim',()=>{
 const data=fixture();data.recommendations=generateRecommendations(data,asOf);
 const packet=buildResearchPacket(data,{series:{}},[],{},{},{asOfDate:asOf});
 const prompt=modelPrompt(packet);
 for(const sample of samples){
  const signal=packet.quantitative.sectorSignals.find(item=>item.targetId===sample.targetId);
  assert.equal(signal.scoringGate,'passed');
  assert.equal(signal.confidence,'medium');
  assert.equal(signal.researchScope,'company_operating_sample');
  assert.ok(signal.scopeBoundary.length>40);
  assert.ok(prompt.includes(signal.scopeBoundary));
  assert.ok(signal.evidenceRefs.every(ref=>ref.metricId.startsWith(sample.entity+'.')));
 }
 assert.equal(packet.quantitative.overall.score,null);
 assert.equal(packet.marketRegime,'insufficient_evidence','company samples alone cannot establish an industry-wide regime');
});
