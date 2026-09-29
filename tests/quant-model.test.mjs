import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMacroOverlay,buildQuantitativeSignal,QUANT_MODEL_VERSION} from '../lib/industry/quant-model.mjs';

const periods=['2024-03-31','2024-06-30','2024-09-30','2024-12-31','2025-03-31','2025-06-30','2025-09-30','2025-12-31'];
const observations=values=>({observations:values.map((value,index)=>({periodEnd:periods[index],value,version:`v${index}`,sourceUrl:'https://example.com/source',fetchedAt:'2026-01-01'}))});
const definition=(id,entity,family,valueType='reported')=>({id,entity,family,frequency:'quarterly',normalUpdateDelayDays:65,valueType});
const definitions=[definition('MSFT.capex','MSFT','capex'),definition('MSFT.cloud','MSFT','cloud_revenue'),definition('MSFT.margin','MSFT','cloud_margin'),definition('US.power','US','electricity','official')];
const series={
 'MSFT.capex':observations([10,11,12,13,16,18,20,23]),
 'MSFT.cloud':observations([10,12,14,16,20,23,27,31]),
 'MSFT.margin':observations([20,20,21,21,23,24,25,27]),
 'US.power':observations([10,11,12,13,16,18,20,24])
};
const item=(metricId,direction,dimension)=>({metricId,observationVersion:'v7',periodEnd:'2025-12-31',direction,dimension,explanation:'test'});
const recommendation={
 targetId:'cloud',targetName:'AI云计算平台',level:'gradual_attention',coverage:1,missingMetrics:[],
 dimensions:[{id:'investment',name:'投资投入',state:'positive',metricIds:['MSFT.capex']},{id:'demand',name:'实际需求',state:'positive',metricIds:['MSFT.cloud']},{id:'profitability',name:'盈利兑现',state:'positive',metricIds:['MSFT.margin']},{id:'costs',name:'成本与约束',state:'negative',metricIds:['US.power']}],
 positiveEvidence:[item('MSFT.capex','positive','investment'),item('MSFT.cloud','positive','demand'),item('MSFT.margin','positive','profitability')],
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
 assert.ok(first.score!==null&&first.score>=-100&&first.score<=100);
 assert.ok(first.fundamentalScore!==null&&first.fundamentalScore>=-100&&first.fundamentalScore<=100);
 assert.equal(first.score,second.score,'duplicate entity/family evidence must not add weight');
 assert.deepEqual(first.factorContributions.map(item=>[item.id,item.contribution]),second.factorContributions.map(item=>[item.id,item.contribution]));
 assert.equal(first.factorContributions.length,4);
 assert.ok(first.dataQualityScore>0&&first.dataQualityScore<=100);
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

test('macro overlay is capped and requires more than one valid macro factor',()=>{
 const overlay=buildMacroOverlay(macro);
 assert.equal(overlay.applied,true);
 assert.ok(overlay.score>=-10&&overlay.score<=10);
 const incomplete=buildMacroOverlay(macro.slice(0,1));
 assert.equal(incomplete.applied,false);
 assert.equal(incomplete.score,0);
});
