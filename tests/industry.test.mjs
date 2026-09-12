import test from 'node:test';
import assert from 'node:assert/strict';
import {metricStats,chartRows,generateRecommendations} from '../lib/industry/engine.mjs';
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
