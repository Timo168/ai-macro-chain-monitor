import test from 'node:test';
import assert from 'node:assert/strict';
import {buildInfrastructureGeography,projectStateCode,projectSourceStatus,selectProjectCapacityEstimate,selectProjectCapacityRange,regionalMarketSnapshot,heatBucket,heatExtent,geographyHistory,STATE_NAMES} from '../lib/industry/geography.mjs';

const project=(id,stateCode,status='construction',extra={})=>({id,name:id,country:'美国',stateCode,status,sourceUrls:[`https://energy.gov/${id}`],lastVerifiedAt:'2026-11-01T00:00:00Z',isEstimated:false,...extra});
const point=(periodEnd,value,extra={})=>({periodEnd,value,sourceUrl:'https://www.eia.gov/data',fetchedAt:'2026-11-01T00:00:00Z',version:'v1',...extra});
function dataset(){return {projects:[],definitions:[],series:{},sources:[]};}
function addSeries(data,id,observations,status='ready'){
 data.definitions.push({id,unit:id.endsWith('_sales')?'MWh':'美分/kWh',sourceName:'EIA',sourceUrl:'https://www.eia.gov/electricity'});
 data.series[id]={status,observations,lastSuccessfulAt:'2026-11-01T00:00:00Z'};
}

test('maps disclosed US states including older English names; does not locate company or foreign totals',()=>{
 assert.equal(Object.keys(STATE_NAMES).length,51);
 assert.equal(projectStateCode({country:'美国',region:'Indiana'}),'IN');
 assert.equal(projectStateCode({country:'United States',region:'Tennessee'}),'TN');
 assert.equal(projectStateCode({country:'USA',stateCode:'tx'}),'TX');
 assert.equal(projectStateCode({country:'美国',region:'密苏里州'}),'MO');
 assert.equal(projectStateCode({country:'加拿大',stateCode:'CA'}),null);
 assert.equal(projectStateCode({country:'美国',region:'unknown'}),null);
 assert.equal(projectStateCode({stateCode:'CA'}),null);
 const data=dataset();addSeries(data,'EIA.US.industrial',[point('2026-09-30',8)]);
 addSeries(data,'MSFT.capex',[point('2026-09-30',100)]);
 const rows=buildInfrastructureGeography(data).rows;
 assert.equal(rows.length,51);assert.ok(rows.every(row=>row.projectCount===null&&row.price.value===null));
});

test('deduplicates project IDs, keeps unlocated records, and distinguishes no sample from no matching stage',()=>{
 const data=dataset();data.projects=[project('a','TX'),project('a','TX','operational',{lastVerifiedAt:'2026-11-02'}),project('b','OH'),project('c','XX')];
 addSeries(data,'EIA.VA.industrial',[point('2026-09-30',7)]);
 const result=buildInfrastructureGeography(data,{statuses:['operational']});
 assert.equal(result.summary.projectCount,3);assert.equal(result.summary.mappedProjectCount,2);
 assert.equal(result.unlocatedProjects[0].id,'c');
 assert.equal(result.rows.find(row=>row.code==='TX').projectCount,1);
 assert.equal(result.rows.find(row=>row.code==='OH').projectCount,0);
 assert.equal(result.rows.find(row=>row.code==='VA').projectCount,null);
 assert.equal(result.rows.find(row=>row.code==='OH').statusCounts.construction,1);
 assert.equal(result.rows.find(row=>row.code==='OH').matchedProjects.length,0);
});

test('capacity heat combines explicit comparable actual disclosures and preserves missing/mixed bases',()=>{
 const data=dataset();data.projects=[
  project('construction','OH','construction',{powerCapacityMw:10000,capacityKind:'data_center_planned_capacity'}),
  project('planning','OH','planning',{powerCapacityMw:2000,capacityKind:'data_center_planned_capacity'}),
  project('power','OH','construction',{powerCapacityMw:15000,capacityKind:'onsite_generation_capacity'}),
  project('unknown','OH','construction',{powerCapacityMw:1000}),
  project('estimated','OH','construction',{powerCapacityMw:900,capacityKind:'data_center_planned_capacity',isEstimated:true}),
  project('operating','OH','operational',{powerCapacityMw:300,capacityKind:'operational_data_center_capacity'}),
  project('campus','OH','partially_operational',{powerCapacityMw:1000,capacityKind:'data_center_planned_capacity'}),
  project('undisclosed','AZ','operational'),
 ];
 const result=buildInfrastructureGeography(data);
 const ohio=result.rows.find(row=>row.code==='OH');
 assert.equal(ohio.constructionMw,10000);assert.equal(ohio.operationalMw,300);
 assert.equal(ohio.capacityUnknownCount,2);
 assert.equal(ohio.capacityGroups.find(group=>group.kind==='onsite_generation_capacity').value,15000);
 assert.equal(result.rows.find(row=>row.code==='AZ').operationalMw,null);
 assert.equal(buildInfrastructureGeography(data,{statuses:['operational']}).rows.find(row=>row.code==='OH').constructionMw,null);
});

const capacityEstimate=(valueMw,extra={})=>({id:'epoch-it-current',sourceType:'institutional_estimate',capacityKind:'it_power',scope:'current',valueMw,asOfDate:'2026-09-30',publishedAt:'2026-10-01',sourceName:'Epoch AI',sourceUrl:'https://epoch.ai/data/ai-data-centers/directory/example',status:'ready',fetchedAt:'2026-11-01T00:00:00Z',...extra});
const capacityNow='2026-11-12T10:00:00Z';

test('selects one latest institutional IT estimate per project and retains ready/cached provenance',()=>{
 const item=project('a','TX','operational',{capacityEvidence:[
  capacityEstimate(152,{asOfDate:'2026-02-24'}),
  capacityEstimate(178,{status:'cached',error:'timeout',lastSuccessfulAt:'2026-11-02T00:00:00Z'}),
  capacityEstimate(220,{scope:'planned',targetDate:'2027-12-31'}),
  capacityEstimate(900,{capacityKind:'grid_interconnection_capacity'}),
 ]});
 const selected=selectProjectCapacityEstimate(item,{now:capacityNow});
 assert.equal(selected.valueMw,178);assert.equal(selected.status,'cached');assert.equal(selected.error,'timeout');
 assert.equal(selectProjectCapacityEstimate(item,{scope:'planned',now:capacityNow}).valueMw,220);
 assert.equal(selectProjectCapacityEstimate({...item,capacityEvidence:[capacityEstimate(178),capacityEstimate(179,{fetchedAt:'2026-11-03T00:00:00Z'})]},{now:capacityNow}).valueMw,179);
});

test('future-current, unavailable, invalid and untraceable estimates never become map values',()=>{
 const rejected=[
  {asOfDate:'2027-01-01'}, {asOfDate:null}, {asOfDate:'2026-02-30'},
  {publishedAt:'2027-01-01'}, {publishedAt:'invalid'}, {sourceType:'official'},
  {status:'not_published'}, {status:'fetch_failed'}, {status:'not_configured'},
  {status:'cached',fetchedAt:undefined,lastSuccessfulAt:undefined}, {status:'cached',lastSuccessfulAt:'2027-01-01'},
  {valueMw:null}, {valueMw:-1}, {valueMw:Infinity}, {capacityKind:'compute_capacity'},
  {sourceUrl:'javascript:alert(1)'}, {sourceName:''},
 ];
 for(const extra of rejected){
  const item=project('a','TX','operational',{capacityEvidence:[capacityEstimate(100,extra)]});
  assert.equal(selectProjectCapacityEstimate(item,{now:capacityNow}),null,JSON.stringify(extra));
  const data=dataset();data.projects=[item];
  assert.equal(buildInfrastructureGeography(data,{now:capacityNow}).rows.find(row=>row.code==='TX').estimatedOperationalMw,null);
 }
 assert.equal(selectProjectCapacityEstimate({capacityEvidence:[capacityEstimate(100,{scope:'planned',asOfDate:'2027-01-01',publishedAt:'2027-01-01'})]},{scope:'planned',now:capacityNow}),null);
 assert.equal(selectProjectCapacityEstimate({capacityEvidence:[capacityEstimate(100,{scope:'planned',asOfDate:'2027-01-01'})]},{scope:'planned',now:capacityNow}),null);
 assert.equal(selectProjectCapacityEstimate({capacityEvidence:[capacityEstimate(100,{scope:'planned',targetDate:'2028-Q1'})]},{scope:'planned',now:capacityNow}).targetDate,'2028-Q1');
 assert.equal(selectProjectCapacityEstimate({capacityEvidence:[capacityEstimate(100)]},{now:'invalid'}),null);
});

test('capacity heat keeps official, current IT estimates, and future IT plans in independent totals',()=>{
 const data=dataset();data.projects=[
  project('operating','TX','operational',{powerCapacityMw:200,capacityKind:'operational_data_center_capacity',capacityEvidence:[capacityEstimate(152,{asOfDate:'2026-02-24'}),capacityEstimate(178,{status:'cached'}),capacityEstimate(250,{scope:'planned',targetDate:'2027-01-01'})]}),
  project('partial','TX','partially_operational',{capacityEvidence:[capacityEstimate(50)]}),
  project('construction','TX','construction',{powerCapacityMw:1000,capacityKind:'data_center_planned_capacity',capacityEvidence:[capacityEstimate(30),capacityEstimate(400,{scope:'planned',targetDate:'2028-Q1'})]}),
  project('cancelled','TX','cancelled',{capacityEvidence:[capacityEstimate(70),capacityEstimate(700,{scope:'planned',targetDate:'2027-01-01'})]}),
  project('missing','TX','operational'),
 ];
 const before=JSON.stringify(data),row=buildInfrastructureGeography(data,{now:capacityNow}).rows.find(row=>row.code==='TX');
 assert.equal(row.operationalMw,200);assert.equal(row.constructionMw,1000);
 assert.equal(row.estimatedOperationalMw,228);assert.equal(row.estimatedPlannedMw,650);
 assert.deepEqual({count:row.estimatedOperational.count,eligible:row.estimatedOperational.eligibleProjectCount,missing:row.estimatedOperational.missingCount,cached:row.estimatedOperational.cachedCount},{count:2,eligible:3,missing:1,cached:1});
 assert.deepEqual(row.estimatedOperational.items.map(item=>item.projectId),['operating','partial']);
 assert.deepEqual(row.estimatedOperational.sourceNames,['Epoch AI']);
 assert.equal(row.estimatedOperational.oldestAsOfDate,'2026-09-30');assert.equal(row.estimatedOperational.newestAsOfDate,'2026-09-30');
 assert.equal(JSON.stringify(data),before);
 assert.equal(buildInfrastructureGeography(data,{statuses:['construction'],now:capacityNow}).rows.find(row=>row.code==='TX').estimatedOperationalMw,null);
});

test('institution capacity heat preserves zero, missing, source dates and project identity',()=>{
 const data=dataset();data.projects=[
  project('meta-mesa','AZ','operational',{owner:'Meta',city:'Mesa'}),
  project('google-mesa','AZ','operational',{owner:'Google',city:'Mesa',capacityEvidence:[capacityEstimate(183,{asOfDate:'2026-06-30'})]}),
  project('zero','AZ','operational',{capacityEvidence:[capacityEstimate(0,{asOfDate:'2026-09-30'})]}),
  project('undisclosed','ID','operational'),
 ];
 const rows=buildInfrastructureGeography(data,{now:capacityNow}).rows,az=rows.find(row=>row.code==='AZ');
 assert.equal(selectProjectCapacityEstimate(data.projects[0],{now:capacityNow}),null);
 assert.equal(az.estimatedOperationalMw,183);assert.equal(az.estimatedOperational.count,2);
 assert.equal(az.estimatedOperational.missingCount,1);
 assert.equal(az.estimatedOperational.oldestAsOfDate,'2026-06-30');assert.equal(az.estimatedOperational.newestAsOfDate,'2026-09-30');
 assert.equal(rows.find(row=>row.code==='ID').estimatedOperationalMw,null);
 assert.equal(rows.find(row=>row.code==='CA').estimatedOperationalMw,null);
 assert.equal(selectProjectCapacityEstimate(data.projects[2],{now:capacityNow}).valueMw,0);
});

test('institution source readiness never changes the separately sourced official project status',()=>{
 const data=dataset(),item=project('a','TX','operational',{capacityEvidence:[capacityEstimate(178)]});
 data.sources=[{url:item.sourceUrls[0],status:'fetch_failed',error:'official source unreachable'},{url:item.capacityEvidence[0].sourceUrl,status:'ready'}];
 assert.equal(projectSourceStatus(item,data).status,'cached');
 assert.equal(projectSourceStatus(item,data).sources.length,1);
 assert.equal(selectProjectCapacityEstimate(item,{now:capacityNow}).status,'ready');
});

test('facility estimates remain independent from IT power and official MW, including source revisions',()=>{
 const data=dataset();data.projects=[
  project('temple','TX','operational',{powerCapacityMw:300,capacityKind:'operational_data_center_capacity',capacityEvidence:[
   capacityEstimate(178),capacityEstimate(198,{id:'facility-old',capacityKind:'facility_power',asOfDate:'2026-02-24'}),
   capacityEstimate(231,{id:'facility-current',capacityKind:'facility_power',status:'cached'}),
   capacityEstimate(350,{id:'facility-planned',capacityKind:'facility_power',scope:'planned',targetDate:'2028-Q1'}),
  ]}),
  project('mesa','AZ','operational',{capacityEvidence:[capacityEstimate(240,{capacityKind:'facility_power',sourceName:'Cleanview'})]}),
  project('future','AZ','construction',{capacityEvidence:[capacityEstimate(900,{capacityKind:'facility_power'})]}),
 ];
 const rows=buildInfrastructureGeography(data,{now:capacityNow}).rows,tx=rows.find(row=>row.code==='TX'),az=rows.find(row=>row.code==='AZ');
 assert.equal(tx.operationalMw,300);assert.equal(tx.estimatedOperationalMw,178);assert.equal(tx.estimatedFacilityMw,231);
 assert.equal(tx.estimatedFacility.count,1);assert.equal(tx.estimatedFacility.cachedCount,1);
 assert.equal(tx.estimatedPlannedMw,null);
 assert.equal(az.estimatedFacilityMw,240);assert.equal(az.estimatedOperationalMw,null);
 assert.deepEqual(az.estimatedFacility.sourceNames,['Cleanview']);
 assert.equal(selectProjectCapacityEstimate(data.projects[0],{capacityKind:'facility_power',now:capacityNow}).id,'facility-current');
 assert.equal(selectProjectCapacityEstimate(data.projects[0],{capacityKind:'facility_power',scope:'planned',now:capacityNow}).targetDate,'2028-Q1');
 assert.throws(()=>selectProjectCapacityEstimate(data.projects[0],{capacityKind:'grid_interconnection_capacity',now:capacityNow}));
});

test('capacity ranges remain visible evidence without becoming exact facility heat-map values',()=>{
 const data=dataset();data.projects=[project('kansas','MO','operational',{capacityEvidence:[capacityEstimate(null,{capacityKind:'facility_power',upperBoundMw:200,valueQualifier:'less_than',note:'机构报告的上限'})]})];
 const row=buildInfrastructureGeography(data,{now:capacityNow}).rows.find(item=>item.code==='MO');
 assert.equal(row.estimatedFacilityMw,null);assert.equal(row.estimatedFacility.count,0);assert.equal(row.estimatedFacility.missingCount,1);
 assert.equal(data.projects[0].capacityEvidence[0].upperBoundMw,200);
 assert.equal(selectProjectCapacityEstimate(data.projects[0],{capacityKind:'facility_power',now:capacityNow}),null);
 assert.equal(selectProjectCapacityRange(data.projects[0],{now:capacityNow}).upperBoundMw,200);
});

test('range selection uses the newest comparable bound and does not mix scopes or capacity kinds',()=>{
 const bound=extra=>capacityEstimate(null,{id:'range',capacityKind:'facility_power',upperBoundMw:200,valueQualifier:'less_than',...extra});
 const item=project('kansas','MO','operational',{capacityEvidence:[bound({asOfDate:'2026-06-30',upperBoundMw:300}),bound({status:'cached',lastSuccessfulAt:'2026-11-02'}),bound({capacityKind:'it_power',upperBoundMw:150}),bound({scope:'planned',upperBoundMw:400,targetDate:'2028-Q1'})]});
 const before=JSON.stringify(item),selected=selectProjectCapacityRange(item,{now:capacityNow});
 assert.equal(selected.upperBoundMw,200);assert.equal(selected.status,'cached');
 assert.equal(selectProjectCapacityRange(item,{capacityKind:'it_power',now:capacityNow}).upperBoundMw,150);
 assert.equal(selectProjectCapacityRange(item,{scope:'planned',now:capacityNow}).targetDate,'2028-Q1');
 assert.equal(selectProjectCapacityRange({...item,capacityEvidence:[bound({}),bound({upperBoundMw:190,fetchedAt:'2026-11-03'})]},{now:capacityNow}).upperBoundMw,190);
 assert.equal(JSON.stringify(item),before);
});

test('range evidence cannot bypass publication, source, cache or numeric-bound validation',()=>{
 const rejected=[{asOfDate:'2027-01-01'},{asOfDate:null},{asOfDate:'2026-02-30'},{publishedAt:'2027-01-01'},
  {sourceUrl:'javascript:alert(1)'},{sourceName:''},{sourceType:'official'},
  {status:'fetch_failed'},{status:'not_published'},{status:'not_configured'},
  {status:'cached',fetchedAt:undefined,lastSuccessfulAt:undefined},{status:'cached',lastSuccessfulAt:'2027-01-01'},
  {upperBoundMw:null},{upperBoundMw:0},{upperBoundMw:-1},{upperBoundMw:Infinity},{valueQualifier:'approximately'},{valueMw:150}];
 for(const extra of rejected){
  const item=project('a','MO','operational',{capacityEvidence:[capacityEstimate(null,{capacityKind:'facility_power',upperBoundMw:200,valueQualifier:'less_than',...extra})]});
  assert.equal(selectProjectCapacityRange(item,{now:capacityNow}),null,JSON.stringify(extra));
 }
 assert.equal(selectProjectCapacityRange({capacityEvidence:[]},{now:'invalid'}),null);
});

test('official construction compute capacity is mapped separately from DOE planning capacity and estimates',()=>{
 const data=dataset();data.projects=[
  project('hyperion','LA','construction',{powerCapacityMw:5000,capacityKind:'compute_capacity',capacityEvidence:[capacityEstimate(1632,{scope:'planned',targetDate:'2028-Q1'})]}),
  project('el-paso','TX','construction',{powerCapacityMw:1000,capacityKind:'compute_capacity'}),
  project('planning','TX','planning',{powerCapacityMw:2000,capacityKind:'compute_capacity'}),
  project('estimate','TX','construction',{powerCapacityMw:300,capacityKind:'compute_capacity',isEstimated:true}),
  project('portsmouth','OH','construction',{powerCapacityMw:10000,capacityKind:'data_center_planned_capacity'}),
 ];
 const rows=buildInfrastructureGeography(data,{now:capacityNow}).rows,la=rows.find(row=>row.code==='LA'),tx=rows.find(row=>row.code==='TX'),oh=rows.find(row=>row.code==='OH');
 assert.equal(la.officialComputeMw,5000);assert.equal(tx.officialComputeMw,1000);
 assert.equal(la.estimatedPlannedMw,1632);assert.equal(la.constructionMw,null);
 assert.equal(oh.constructionMw,10000);assert.equal(oh.officialComputeMw,null);
 assert.equal(buildInfrastructureGeography(data,{statuses:['operational'],now:capacityNow}).rows.find(row=>row.code==='LA').officialComputeMw,null);
});

test('state heat prices use one exact month, do not carry latest values backward or forward',()=>{
 const data=dataset();
 addSeries(data,'EIA.TX.industrial',[point('2026-08-31',6),point('2026-09-30',7)]);
 addSeries(data,'EIA.OH.industrial',[point('2026-08-31',9)]);
 addSeries(data,'EIA.TX.industrial_sales',[point('2026-09-30',800)]);
 const shared=buildInfrastructureGeography(data);
 assert.equal(shared.month,'2026-08');assert.equal(shared.latestCommonMonth,'2026-08');
 const latest=buildInfrastructureGeography(data,{month:'2026-09'});
 assert.equal(latest.rows.find(row=>row.code==='TX').price.value,7);
 const ohio=latest.rows.find(row=>row.code==='OH');
 assert.equal(ohio.price.value,null);assert.equal(ohio.price.latest.value,9);assert.equal(ohio.price.status,'no_observation');
 assert.equal(latest.rows.find(row=>row.code==='TX').sales.value,800);
 assert.equal(latest.rows.find(row=>row.code==='TX').sales.unit,'MWh');
 const prior=buildInfrastructureGeography(data,{month:'2026-08'});
 assert.deepEqual(prior.rows.filter(row=>row.price.value!==null).map(row=>row.price.value),[9,6]);
 assert.ok(buildInfrastructureGeography(data,{month:'2025-01'}).rows.every(row=>row.price.value===null));
 assert.ok(buildInfrastructureGeography(data,{month:'nonsense'}).rows.every(row=>row.price.value===null));
});

test('preserves zero, null, revisions, source status and retrieval metadata',()=>{
 const data=dataset();
 addSeries(data,'EIA.TX.industrial',[point('2026-09-30',5),point('2026-09-30',0,{fetchedAt:'2026-11-02'})],'cached');
 addSeries(data,'EIA.OH.industrial',[point('2026-09-30',null)],'fetch_failed');
 addSeries(data,'EIA.VA.industrial',[],'not_configured');
 data.series['EIA.OH.industrial'].error='Source unreachable';
 const rows=buildInfrastructureGeography(data).rows;
 const tx=rows.find(row=>row.code==='TX').price;
 assert.equal(tx.value,0);assert.equal(tx.status,'cached');assert.equal(tx.fetchedAt,'2026-11-02');
 assert.equal(tx.lastSuccessfulAt,'2026-11-01T00:00:00Z');assert.equal(tx.sourceName,'EIA');
 assert.equal(rows.find(row=>row.code==='OH').price.status,'fetch_failed');
 assert.equal(rows.find(row=>row.code==='OH').price.error,'Source unreachable');
 assert.equal(rows.find(row=>row.code==='VA').price.status,'not_configured');
});

test('commercial and industrial series are independent, no source mutation during aggregation',()=>{
 const data=dataset();addSeries(data,'EIA.TX.commercial',[point('2026-09-30',12)]);addSeries(data,'EIA.TX.industrial',[point('2026-09-30',7)]);
 data.projects=[project('a','TX')];const before=JSON.stringify(data);
 assert.equal(buildInfrastructureGeography(data,{sector:'commercial'}).rows.find(row=>row.code==='TX').price.value,12);
 assert.equal(buildInfrastructureGeography(data,{sector:'industrial'}).rows.find(row=>row.code==='TX').price.value,7);
 assert.equal(JSON.stringify(data),before);
 assert.throws(()=>buildInfrastructureGeography(data,{sector:'residential'}));
});

test('disjoint state histories fall back to the newest period with visibly partial coverage',()=>{
 const data=dataset();addSeries(data,'EIA.TX.industrial',[point('2026-09-30',7)]);addSeries(data,'EIA.OH.industrial',[point('2026-08-31',9)]);
 addSeries(data,'EIA.VA.industrial',[],'not_configured');
 const result=buildInfrastructureGeography(data);
 assert.equal(result.latestCommonMonth,null);assert.equal(result.month,'2026-09');
 assert.equal(result.rows.find(row=>row.code==='TX').price.value,7);
 assert.equal(result.rows.find(row=>row.code==='OH').price.value,null);
 assert.equal(result.rows.find(row=>row.code==='VA').price.status,'not_configured');
 const california=result.rows.find(row=>row.code==='CA');
 assert.equal(california.name,'加利福尼亚州');assert.equal(california.projectCount,null);
 assert.deepEqual(california.projects,[]);assert.deepEqual(california.statusCounts,{});
 assert.equal(california.price.status,'not_configured');assert.equal(california.sales.status,'not_configured');
});

test('failed project checks retain historic record and report cached status',()=>{
 const data=dataset(),item=project('a','TX');
 assert.equal(projectSourceStatus(item,data).status,'historical');
 data.sources=[{url:'https://energy.gov/a',status:'fetch_failed',checkedAt:'2026-11-02',error:'timeout'}];
 const cached=projectSourceStatus(item,data);
 assert.equal(cached.status,'cached');assert.equal(cached.error,'timeout');assert.equal(cached.lastVerifiedAt,item.lastVerifiedAt);
 data.sources[0].status='ready';assert.equal(projectSourceStatus(item,data).status,'ready');
 data.sources[0].status='not_configured';assert.equal(projectSourceStatus(item,data).status,'not_configured');
});

test('regional comparisons use a common timestamp and never infer state values',()=>{
 const series=(id,observations,status='available',kind='load')=>({id,kind,status,observations,unit:'MW'});
 const data={regions:[{id:'ercot',name:'ERCOT',series:[series('a',[{date:'2026-11-10T10:00:00Z',value:40000},{date:'2026-11-10T11:00:00Z',value:42000}])]},{id:'pjm',name:'PJM',series:[series('b',[{date:'2026-11-10T10:00:00Z',value:80000}])]}]};
 const result=regionalMarketSnapshot(data);
 assert.equal(result.date,'2026-11-10T10:00:00Z');assert.deepEqual(result.rows.map(row=>row.value),[40000,80000]);
 assert.equal(result.rows[0].latest.value,42000);assert.ok(result.rows.every(row=>!Object.hasOwn(row,'stateCode')));
 const latest=regionalMarketSnapshot(data,{date:'2026-11-10T11:00:00Z'});
 assert.deepEqual(latest.rows.map(row=>row.value),[42000,null]);
 assert.equal(regionalMarketSnapshot(data,{kind:'wholesale_price'}).rows[0].status,'not_configured');
});

test('missing regional prices keep unpublished/failure boundaries and are not converted to zero',()=>{
 const data={regions:[{id:'ercot',name:'ERCOT',series:[{id:'a',kind:'wholesale_price',status:'not_published',observations:[]}]},{id:'pjm',name:'PJM',series:[{id:'b',kind:'wholesale_price',status:'cached',observations:[{date:'2026-10-27',value:63.91}]}]}]};
 const result=regionalMarketSnapshot(data,{kind:'wholesale_price'});
 assert.equal(result.date,'2026-10-27');assert.deepEqual(result.rows.map(row=>row.value),[null,63.91]);
 assert.deepEqual(result.rows.map(row=>row.status),['not_published','cached']);
});

test('equal interval heat scale handles equal observations, zero and unknown distinctly',()=>{
 assert.deepEqual(heatExtent([null,undefined,0,5,10,NaN]),{min:0,max:10,count:3});
 assert.deepEqual([0,3,6,10].map(value=>heatBucket(value,[0,10])),[0,1,2,3]);
 assert.equal(heatBucket(null,[0,10]),null);assert.equal(heatBucket(3,[3,3]),1);
 assert.equal(heatExtent([null]),null);assert.equal(heatBucket(0,[0]),1);
});

test('monthly history clips to whole selected month, deduplicates revisions and exposes missing months',()=>{
 const rows=geographyHistory([{date:'2026-10-31',value:99},{date:'2026-06-30',value:3},{date:'2026-06-30',value:4},{date:'2026-08-31',value:6},{date:'2026-09-30',value:7},{date:'2024-08-31',value:1}],{frequency:'monthly',cutoff:'2026-09',limit:4});
 assert.deepEqual(rows,[{date:'2026-06-30',value:4,gap:false},{date:'2026-07-01',value:null,gap:true},{date:'2026-08-31',value:6,gap:false},{date:'2026-09-30',value:7,gap:false}]);
 assert.equal(geographyHistory([{date:'2023-01-31',value:1},{date:'2026-09-30',value:2}],{frequency:'monthly'}).length,1);
});

test('hourly history uses seven elapsed days, clips future observations and breaks gaps',()=>{
 const points=[{date:'2026-11-01T10:00:00Z',value:1},{date:'2026-11-03T10:00:00Z',value:2},{date:'2026-11-03T11:00:00Z',value:3},{date:'2026-11-10T08:00:00Z',value:4},{date:'2026-11-10T10:00:00Z',value:5},{date:'2026-11-10T11:00:00Z',value:99}];
 const rows=geographyHistory(points,{frequency:'hourly',cutoff:'2026-11-10T10:00:00Z'});
 assert.deepEqual(rows.filter(row=>!row.gap).map(row=>row.value),[3,4,5]);
 assert.ok(rows.every(row=>Date.parse(row.date)>Date.parse('2026-11-03T10:00:00Z')&&Date.parse(row.date)<=Date.parse('2026-11-10T10:00:00Z')));
 assert.ok(rows.some(row=>row.date==='2026-11-10T09:00:00.000Z'&&row.value===null&&row.gap));
 assert.equal(geographyHistory([{date:'2026-11-10T12:00:00+02:00',value:1},{date:'2026-11-10T10:00:00Z',value:2}],{frequency:'hourly'}).length,1);
});

test('daily history is a 90-day window, preserves nulls and does not invent non-trading-day gaps',()=>{
 const rows=geographyHistory([{date:'2026-01-01',value:1},{date:'2026-10-23',value:2},{date:'2026-10-26',value:null},{date:'2026-10-27',value:0},{date:'2026-10-28',value:99}],{frequency:'daily',cutoff:'2026-10-27'});
 assert.deepEqual(rows,[{date:'2026-10-23',value:2,gap:false},{date:'2026-10-26',value:null,gap:false},{date:'2026-10-27',value:0,gap:false}]);
 assert.deepEqual(geographyHistory([{date:'2026-10-27',value:1}],{frequency:'daily',cutoff:'invalid'}),[]);
 assert.throws(()=>geographyHistory([],{frequency:'daily',limit:0}));
});
