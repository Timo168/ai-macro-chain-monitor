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

test('annually released quarterly data expire by verified publication rather than repeated fetching',()=>{
 const releaseDef={...def,frequency:'quarterly',freshnessBasis:'source_publication',sourceReleaseFrequency:'annual',sourceReleaseDelayDays:35};
 const observations=[{...p('2025-12-31',1991),publishedAt:'2026-07-07T11:00:00Z',fetchedAt:'2026-10-01'}];
 assert.equal(metricStats(releaseDef,observations,'2026-10-01').freshness,'fresh');
 assert.equal(metricStats(releaseDef,observations,'2027-09-01').freshness,'stale');
 assert.equal(metricStats(releaseDef,[{...observations[0],publishedAt:null}],'2026-10-01').freshness,'stale');
});

test('company-wide sales only supply demand within the declared business scope',()=>{
 const total={...def,id:'MU.company_revenue',entity:'MU',family:'company_revenue',unit:'亿美元',reportingScope:'company_total',researchTargets:['memory']};
 const observations=[p('2025-06-30',100),p('2026-06-30',110)];
 const data={definitions:[total],series:{[total.id]:{status:'ready',observations}}};
 const results=generateRecommendations(data,'2026-10-01');
 assert.ok(results.find(row=>row.targetId==='memory').positiveEvidence.some(item=>item.metricId===total.id&&item.dimension==='demand'));
 assert.ok(!results.find(row=>row.targetId==='overall').positiveEvidence.some(item=>item.metricId===total.id));
 assert.ok(ruleReachability([{...total,reportingScope:undefined}]).find(row=>row.targetId==='memory').unavailableDimensions.includes('demand'));
});
test('demo and missing critical evidence never create allocation recommendations',()=>{
 const data={definitions:[{...def,valueType:'demo'}],series:{[def.id]:{status:'ready',observations:[p('2025-06-30',40),p('2026-06-30',50)]}}};
 const output=generateRecommendations(data,'2026-09-12');assert.equal(output.filter(r=>r.researchScope==='industry').length,10);assert.equal(output.filter(r=>r.researchScope==='company_operating_sample').length,2);
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
test('project construction snapshots stay evidence-limited without a false trend',()=>{
 const projectDef={id:'PROJECT.construction_capacity',entity:'DOE/项目级公开样本',family:'construction_capacity',unit:'MW',frequency:'quarterly',normalUpdateDelayDays:90,recommendationEligible:true,valueType:'project_announcement'};
 const single=metricStats(projectDef,[p('2026-09-19',12000)],'2026-09-19');
 assert.equal(single.yoy,null);
 const historical=metricStats(projectDef,[p('2025-09-20',8000),p('2026-09-19',12000)],'2026-09-19');
 assert.equal(historical.yoy,50);
 const noObservation={...projectDef,id:'PROJECT.operational_capacity'};
 const data={definitions:[noObservation],series:{[noObservation.id]:{status:'no_observation',observations:[]}}};
 assert.ok(generateRecommendations(data,'2026-09-19').every(r=>r.level==='insufficient_data'));
});
test('sector proxies can supply a leading factor but never make the formal construction gate reachable',()=>{
 const proxy={id:'CENSUS.private_power_construction',entity:'美国',family:'grid_construction_spending',unit:'百万美元（季调年率）',frequency:'monthly',normalUpdateDelayDays:45,recommendationEligible:true,valueType:'proxy',proxyTargets:['power','overall']};
 const rows=[p('2025-08-31',100),p('2026-08-31',115)];
 const data={definitions:[proxy],series:{[proxy.id]:{status:'ready',observations:rows}}};
 const reachability=ruleReachability(data.definitions).find(r=>r.targetId==='power');
 const recommendation=generateRecommendations(data,'2026-09-12').find(r=>r.targetId==='power');
 assert.ok(reachability.unavailableDimensions.includes('construction'));
 assert.ok(recommendation.positiveEvidence.some(item=>item.metricId===proxy.id&&item.dimension==='construction'));
 assert.equal(recommendation.level,'insufficient_data');
});
test('project-level capacity samples stay out of formal reachability even when the source is official',()=>{
 const sample={id:'PROJECT.disclosed_capacity_sample',entity:'DOE/项目级公开样本',family:'construction_capacity',unit:'MW',frequency:'quarterly',normalUpdateDelayDays:90,recommendationEligible:true,valueType:'project_announcement',directness:'project_sample',scoringTier:'leading_only'};
 const rows=[p('2025-09-30',1000),p('2026-09-30',1500)];
 const data={definitions:[sample],series:{[sample.id]:{status:'ready',observations:rows}}};
 const reachability=ruleReachability(data.definitions).find(r=>r.targetId==='data_centers');
 const recommendation=generateRecommendations(data,'2026-09-30').find(r=>r.targetId==='data_centers');
 assert.ok(reachability.unavailableDimensions.includes('construction'));
 assert.ok(recommendation.positiveEvidence.some(item=>item.metricId===sample.id&&item.dimension==='construction'));
 assert.equal(recommendation.formalCoverage,0);
 assert.equal(recommendation.level,'insufficient_data');
});

test('issuer operating capacity respects explicit targets and development cannot become construction',()=>{
 const operating={id:'EQIX.operational_capacity',entity:'EQIX',family:'operational_capacity',unit:'MW',frequency:'quarterly',normalUpdateDelayDays:65,recommendationEligible:true,valueType:'reported',reportingScope:'operator_portfolio',researchTargets:['data_centers']};
 const development={...operating,id:'EQIX.development_capacity',family:'development_capacity',recommendationEligible:false};
 const reach=ruleReachability([operating,development]);
 assert.equal(reach.find(r=>r.targetId==='data_centers').unavailableDimensions.includes('construction'),false);
 assert.equal(reach.find(r=>r.targetId==='overall').unavailableDimensions.includes('construction'),true);
 assert.equal(ruleReachability([development]).find(r=>r.targetId==='data_centers').unavailableDimensions.includes('construction'),true);
});

test('52/53-week fiscal quarter ends do not produce false missing calendar quarters',()=>{
 const rows=['2024-11-01','2025-01-31','2025-05-02','2025-08-01','2025-10-31','2026-01-30','2026-05-01','2026-07-31'].map((date,index)=>p(date,100+index));
 assert.deepEqual(historyCompleteness(def,rows).missingPeriods,[]);
 assert.equal(chartRows(def,rows,{range:'all'}).length,8);
 assert.equal(historyCompleteness(def,rows.filter(point=>point.periodEnd!=='2025-05-02')).missingPeriods.length,1);
});
