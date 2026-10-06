import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResearchRobustness} from '../lib/industry/research-robustness.mjs';
import {generateRecommendations} from '../lib/industry/engine.mjs';
import {buildQuantitativeSignal,factorWeights,QUANT_MODEL_VERSION} from '../lib/industry/quant-model.mjs';

// Entirely synthetic observations exercise recomputation; never used in output.
const periods=['2024-09-30','2024-12-31','2025-03-31','2025-06-30','2025-09-30','2025-12-31','2026-03-31','2026-06-30'];
function inputs(){
 const definitions=[],series={};
 for(const [family,values,unit] of [['capex',[10,11,12,13,16,18,21,25],'亿美元'],['advanced_products_revenue',[100,110,120,130,155,180,212,250],'亿美元'],['gross_margin',[20,21,22,23,24,24.5,25,25.5],'%']]){
  const id='AMKR.'+family,definition={id,entity:'AMKR',nameZh:family,family,unit,frequency:'quarterly',normalUpdateDelayDays:65,valueType:'reported',recommendationEligible:true,reportingScope:'advanced_products',researchTargets:['packaging_operations'],sourceUrl:'https://example.org/'+id};definitions.push(definition);
  series[id]={status:'ready',observations:values.map((value,index)=>({periodEnd:periods[index],value,version:'v'+index,publishedAt:new Date(Date.parse(periods[index])+25*86400000).toISOString(),sourceUrl:definition.sourceUrl}))};
 }
 return {definitions,series,asOfDate:'2026-08-15',factorModelVersion:QUANT_MODEL_VERSION,macroSignals:[]};
}
const sample=result=>result.targets.find(row=>row.targetId==='packaging_operations');

test('robustness requires archived inputs and does not recalculate obsolete model versions',()=>{
 assert.equal(buildResearchRobustness(null).status,'not_available');
 assert.equal(buildResearchRobustness({...inputs(),factorModelVersion:'obsolete'}).status,'model_version_mismatch');
});
test('same archived inputs reproduce the official score without mutating them',()=>{
 const fixture=inputs(),before=JSON.stringify(fixture),result=buildResearchRobustness(fixture,{inputHash:'source-hash'}),recommendation=generateRecommendations(fixture,fixture.asOfDate).find(row=>row.targetId==='packaging_operations');
 assert.equal(result.inputHash,'source-hash');assert.equal(sample(result).baselineScore,buildQuantitativeSignal(recommendation,fixture).score);
 assert.deepEqual(result,buildResearchRobustness(fixture,{inputHash:'source-hash'}));assert.equal(JSON.stringify(fixture),before);
 assert.equal(sample(result).scenarioCount,10);assert.equal(sample(result).inputRefs.length,3);assert.ok(sample(result).inputRefs.every(ref=>ref.historyHash.length===64));
});
test('fixed weight shocks truly renormalize target weights and recompute the score',()=>{
 const fixture=inputs(),record=generateRecommendations(fixture,fixture.asOfDate).find(row=>row.targetId==='packaging_operations');
 const signal=buildQuantitativeSignal(record,{...fixture,sensitivityWeightMultipliers:{investment:1.2}});
 const weight=signal.factorContributions.find(row=>row.id==='investment').weight;
 assert.equal(weight,Number((factorWeights.investment*1.2/(factorWeights.investment*1.2+factorWeights.demand+factorWeights.profitability)).toFixed(4)));
 const scenario=sample(buildResearchRobustness(fixture)).scenarios.find(row=>row.id==='weight:investment:1.2');assert.equal(scenario.score,signal.score);
 assert.ok(sample(buildResearchRobustness(fixture)).scenarios.filter(row=>row.type==='factor_weight').some(row=>row.delta!==0));
 assert.throws(()=>buildQuantitativeSignal(record,{...fixture,sensitivityWeightMultipliers:{investment:10}}),/Sensitivity/);
 assert.throws(()=>buildQuantitativeSignal(record,{...fixture,sensitivityWeightMultipliers:{investment:.8,demand:1.2}}),/Sensitivity/);
});
test('metric removal recomputes production gates while retaining all required factors',()=>{
 const result=sample(buildResearchRobustness(inputs()));
 assert.equal(result.baselineEligible,true);assert.equal(result.status,'evidence_dependent');
 for(const scenario of result.scenarios.filter(row=>row.type==='remove_metric')){assert.equal(scenario.score,null);assert.equal(scenario.eligibilityLost,true);assert.ok(scenario.blockingFactors.length>=1);assert.equal(scenario.delta,null);}
});
test('removing one company removes all of its evidence and never creates independent entities',()=>{
 const result=sample(buildResearchRobustness(inputs())),scenario=result.scenarios.find(row=>row.type==='remove_entity');
 assert.equal(scenario.entity,'AMKR');assert.equal(scenario.eligible,false);assert.equal(scenario.score,null);
 assert.ok(scenario.blockingFactors.includes('investment'));assert.ok(scenario.blockingFactors.includes('demand'));assert.ok(scenario.blockingFactors.includes('profitability'));
});
test('short and gapped histories cannot become scored through sensitivity testing',()=>{
 for(const missingIndex of [0,5]){
  const fixture=inputs();fixture.series['AMKR.capex'].observations.splice(missingIndex,1);
  const result=sample(buildResearchRobustness(fixture));assert.equal(result.baselineScore,null);assert.equal(result.status,'insufficient_evidence');assert.equal(result.scoreRange,null);
  assert.ok(result.scenarios.filter(row=>row.type==='factor_weight').every(row=>row.score===null));
 }
});
