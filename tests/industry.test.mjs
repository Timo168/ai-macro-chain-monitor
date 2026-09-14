import test from 'node:test';
import assert from 'node:assert/strict';
import {metricStats,chartRows,generateRecommendations,historyCompleteness,ruleReachability} from '../lib/industry/engine.mjs';
const def={id:'MSFT.gross_margin',entity:'MSFT',family:'gross_margin',unit:'%',frequency:'quarterly',normalUpdateDelayDays:65,recommendationEligible:true,valueType:'reported'};
const p=(periodEnd,value)=>({periodEnd,value,version:periodEnd,sourceUrl:'https://example.com',isEstimated:false});
test('margin changes use percentage points even with negative bases',()=>{
 const obs=[p('2025-06-30',40),p('2026-03-31',-5),p('2026-06-30',50)];
 const s=metricStats(def,obs,'2026-09-12');assert.equal(s.yoy,10);assert.equal(s.qoq,55);
 assert.equal(chartRows(def,obs,{range:'all',mode:'yoy'}).at(-1).value,10);
});
test('missing quarter stays missing instead of using the last available period',()=>{
 const s=metricStats({...def,unit:'亿美元'},[p('2025-06-30',100),p('2025-12-31',110),p('2026-06-30',150)],'2026-09-12');
 assert.equal(s.qoq,null);assert.equal(s.yoy,50);assert.equal(s.consecutiveDeterioration,0);
});
test('monthly revenue aggregates complete periods; missing months cannot become zero',()=>{
 const d={...def,unit:'亿新台币',frequency:'monthly',aggregation:'sum'};
 assert.equal(chartRows(d,[p('2026-01-31',10),p('2026-02-28',20),p('2026-03-31',30)],{range:'all',frequency:'quarterly'}).at(-1).value,60);
 assert.equal(chartRows(d,[p('2026-01-31',10),p('2026-03-31',30)],{range:'all',frequency:'quarterly'}).at(-1).value,null);
});
test('staleness depends on observation cadence rather than fetch time',()=>{
 assert.equal(metricStats(def,[p('2026-06-30',50)],'2026-09-12').freshness,'fresh');
 assert.equal(metricStats(def,[p('2025-06-30',50)],'2026-09-12').freshness,'stale');
});
test('demo and missing critical evidence never create allocation recommendations',()=>{
 const data={definitions:[{...def,valueType:'demo'}],series:{[def.id]:{status:'ready',observations:[p('2025-06-30',40),p('2026-06-30',50)]}}};
 const output=generateRecommendations(data,'2026-09-12');assert.equal(output.length,10);
 assert.ok(output.every(r=>r.level==='insufficient_data'&&r.positiveEvidence.length===0));
});
test('same data preserve recommendation identity and first generated timestamp',()=>{
 const data={definitions:[],series:{}};const prior=generateRecommendations(data,'2026-09-11');const next=generateRecommendations(data,'2026-09-12',prior);
 assert.equal(next[0].id,prior[0].id);assert.equal(next[0].generatedAt,prior[0].generatedAt);
});
test('historical gaps stay visible as missing observations',()=>{
 const rows=[p('2025-06-30',10),p('2025-12-31',12),p('2026-06-30',14)];
 const status=historyCompleteness(def,rows);
 assert.equal(status.observedPeriods,3);assert.equal(status.expectedPeriods,5);assert.deepEqual(status.missingPeriods,['2025-09-01','2026-03-01']);
});
test('recommendation coverage is based on required dimensions, not repeated cost series',()=>{
 const cost=(id,family)=>({id,entity:'US',family,unit:'美元',frequency:'monthly',normalUpdateDelayDays:65,recommendationEligible:true,valueType:'official'});
 const definitions=[cost('electricity','electricity'),cost('equipment','equipment_price'),cost('copper','copper'),cost('aluminum','aluminum')];
 const observations=[p('2025-08-31',100),p('2026-08-31',110)];
 const data={definitions,series:Object.fromEntries(definitions.map(d=>[d.id,{status:'ready',observations}]))};
 const recommendation=generateRecommendations(data,'2026-09-12').find(r=>r.targetId==='data_centers');
 assert.equal(recommendation.coverage,.25);assert.equal(recommendation.availableDimensionCount,1);
});
test('single-entity industries are not structurally blocked when independent dimensions exist',()=>{
 const definition=(id,entity,family,unit='%')=>({id,entity,family,unit,frequency:'quarterly',normalUpdateDelayDays:65,recommendationEligible:true,valueType:'reported'});
 const definitions=[definition('MSFT.capex','MSFT','capex','亿美元'),definition('TSM.revenue','TSM','datacenter_revenue','亿新台币'),definition('TSM.margin','TSM','gross_margin'),{...definition('TSM.power','台湾','electricity','美元'),frequency:'monthly'}];
 const quarterly=[p('2025-06-30',100),p('2026-06-30',110)];const monthly=[p('2025-06-30',100),p('2026-06-30',90)];
 const data={definitions,series:{'MSFT.capex':{status:'ready',observations:quarterly},'TSM.revenue':{status:'ready',observations:quarterly},'TSM.margin':{status:'ready',observations:[p('2025-06-30',50),p('2026-06-30',55)]},'TSM.power':{status:'ready',observations:monthly}}};
 assert.deepEqual(ruleReachability(definitions).find(r=>r.targetId==='foundry').unavailableDimensions,[]);
 assert.notEqual(generateRecommendations(data,'2026-09-12').find(r=>r.targetId==='foundry').level,'insufficient_data');
});
