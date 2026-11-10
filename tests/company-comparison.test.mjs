import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildCompanyComparison,companyColor,comparisonBarGeometry,comparisonDefinitions,comparisonSnapshot,coreCapexTotal,quarterSummary,reportQuarter} from '../lib/industry/company-comparison.mjs';

const definition=(entity,extras={})=>({id:entity+'.capex',entity,family:'capex',frequency:'quarterly',unit:'亿美元',currency:'USD',nameZh:'现金资本开支',sourceName:'公司财报',sourceUrl:'https://example.org/'+entity,isComparableAcrossEntities:true,...extras});
const point=(periodEnd,value,extras={})=>({periodEnd,value,periodStart:periodEnd.slice(0,4)+'-01-01',version:'v1',fiscalPeriod:'FY'+periodEnd.slice(0,4)+' Q'+Math.ceil(Number(periodEnd.slice(5,7))/3),sourceUrl:'https://example.org/report',...extras});
const data=(defs,rows)=>({definitions:defs,series:Object.fromEntries(defs.map(def=>[def.id,{status:'ready',observations:rows[def.id]??[]}]))});
const opts={entities:['MSFT','AMZN'],mode:'value',range:'all'};

test('canonical company definitions do not double count Oracle or splice alternate margin scopes',()=>{
 const defs=[definition('ORCL'),definition('ORCL',{id:'ORCL.cash_ppe_capex'}),definition('ETN',{id:'ETN.gross_margin',family:'gross_margin'}),definition('ETN',{id:'ETN.company_gross_margin',family:'gross_margin'})];
 const input=data(defs,{'ORCL.capex':[point('2026-08-31',10)],'ETN.gross_margin':[point('2026-06-30',25)]});
 assert.deepEqual(comparisonDefinitions(input,'capex').map(def=>def.id),['ORCL.capex']);
 assert.deepEqual(comparisonDefinitions(input,'gross_margin').map(def=>def.id),['ETN.company_gross_margin']);
 const model=buildCompanyComparison(input,{entities:['ORCL'],mode:'normalized',range:'all'});
 assert.equal(model.commonBase,'2026Q3');assert.equal(model.rows[0].values['ORCL.capex'],100);
});
test('default quarter is latest jointly observed quarter, not each company latest',()=>{
 const input=data([definition('MSFT'),definition('AMZN')],{'MSFT.capex':[point('2026-03-31',10),point('2026-06-30',20),point('2026-09-30',30)],'AMZN.capex':[point('2026-03-31',12),point('2026-06-30',15)]});
 const model=buildCompanyComparison(input,opts);
 assert.equal(model.defaultQuarter,'2026Q2');assert.equal(model.latestQuarter,'2026Q3');
 const snapshot=comparisonSnapshot(model,'2026Q3',input);
 assert.deepEqual(snapshot.map(entry=>[entry.entity,entry.value]),[['MSFT',30],['AMZN',null]]);assert.equal(snapshot[1].missingReason,'该季度缺少观测');
 assert.deepEqual(comparisonSnapshot(model,'2026Q2',input).map(entry=>[entry.entity,entry.value]),[['MSFT',20],['AMZN',15]]);
});
test('fiscal dates group by actual period end and remain attached to the selected point',()=>{
 const input=data([definition('MSFT'),definition('ORCL')],{'MSFT.capex':[point('2026-06-30',10,{periodStart:'2026-04-01',fiscalPeriod:'FY2026 Q4'})],'ORCL.capex':[point('2026-05-31',9,{periodStart:'2026-03-01',fiscalPeriod:'FY2026 Q4'}),point('2026-08-31',15,{periodStart:'2026-06-01',fiscalPeriod:'FY2027 Q1'})]});
 const model=buildCompanyComparison(input,{...opts,entities:['MSFT','ORCL']});
 assert.equal(model.defaultQuarter,'2026Q2');
 const snapshot=comparisonSnapshot(model,'2026Q2',input);
 assert.equal(snapshot.find(entry=>entry.entity==='ORCL').value,9);assert.equal(snapshot.find(entry=>entry.entity==='ORCL').point.periodEnd,'2026-05-31');
 assert.equal(comparisonSnapshot(model,'2026Q3',input).find(entry=>entry.entity==='MSFT').value,null);
 assert.equal(reportQuarter('2026-13-01'),null);assert.equal(reportQuarter('2026-02-31'),null);
});
test('zero and negative observations participate in common quarters and sort numerically before missing values',()=>{
 const defs=['A','B','C','D'].map(entity=>definition(entity));
 const input=data(defs,{'A.capex':[point('2026-06-30',-4)],'B.capex':[point('2026-06-30',0)],'C.capex':[point('2026-06-30',10)]});
 const model=buildCompanyComparison(input,{...opts,entities:['A','B','C','D']});
 assert.deepEqual(comparisonSnapshot(model,'2026Q2',input).map(entry=>[entry.entity,entry.value]),[['C',10],['B',0],['A',-4],['D',null]]);
 assert.equal(model.commonQuarters.length,0);
 assert.equal(buildCompanyComparison(input,{...opts,entities:['A','B','C']}).defaultQuarter,'2026Q2');
 const geometry=comparisonBarGeometry(-4,[-4,0,10,null]);assert.equal(geometry.start,0);assert.ok(geometry.width>0);assert.equal(comparisonBarGeometry(0,[-4,0,10]).width,0);
});
test('merged timelines retain quarters missing from every company and never connect across an omitted quarter',()=>{
 const input=data([definition('MSFT'),definition('AMZN')],{'MSFT.capex':[point('2026-03-31',10),point('2026-09-30',30)],'AMZN.capex':[point('2026-03-31',12),point('2026-09-30',32)]});
 const model=buildCompanyComparison(input,opts);
 assert.deepEqual(model.quarters,['2026Q1','2026Q2','2026Q3']);assert.equal(model.rows[1].values['MSFT.capex'],null);assert.equal(model.rows[1].values['AMZN.capex'],null);
 assert.deepEqual(model.coverage[0].missingQuarters,['2026Q2']);
 assert.match(readFileSync(new URL('../app/industry/company-comparison.tsx',import.meta.url),'utf8'),/connectNulls=\{false\}/);
});
test('all companies use one display window and old companies do not shift the recent window backward',()=>{
 const input=data([definition('MSFT'),definition('AMZN')],{'MSFT.capex':[point('2024-03-31',10),point('2026-09-30',30)],'AMZN.capex':[point('2022-03-31',12),point('2023-03-31',15)]});
 const model=buildCompanyComparison(input,{...opts,range:'8q'});
 assert.equal(model.rows.length,8);assert.equal(model.quarters[0],'2024Q4');assert.equal(model.quarters.at(-1),'2026Q3');
 assert.ok(model.rows.every(row=>row.values['AMZN.capex']===null));assert.ok(model.availableRanges.includes('3'));
});
test('normalization permits distinct money units but requires a shared positive starting quarter',()=>{
 const input=data([definition('MSFT'),definition('AMZN',{unit:'亿日元',currency:'JPY'})],{'MSFT.capex':[point('2026-03-31',0),point('2026-06-30',20),point('2026-09-30',10)],'AMZN.capex':[point('2026-03-31',5),point('2026-06-30',40),point('2026-09-30',80)]});
 assert.equal(buildCompanyComparison(input,opts).compatible,false);
 const model=buildCompanyComparison(input,{...opts,mode:'normalized'});
 assert.equal(model.compatible,true);assert.equal(model.commonBase,'2026Q2');assert.deepEqual(model.rows[1].values,{'MSFT.capex':100,'AMZN.capex':100});assert.deepEqual(model.rows[2].values,{'MSFT.capex':50,'AMZN.capex':200});
 assert.equal(model.rows[0].values['AMZN.capex'],null);assert.equal(comparisonSnapshot(model,'2026Q1',input)[0].missingReason,'早于共同起点');
});
test('an unavailable selected company is retained and prevents fabricated normalized common history',()=>{
 const input=data([definition('MSFT'),definition('AMZN')],{'MSFT.capex':[point('2026-06-30',10)]});
 input.series['AMZN.capex'].status='not_configured';
 const model=buildCompanyComparison(input,{...opts,mode:'normalized'});
 assert.equal(model.definitions.length,2);assert.equal(model.commonBase,null);assert.ok(model.rows.every(row=>Object.values(row.values).every(value=>value===null)));
 assert.equal(comparisonSnapshot(model,'2026Q2',input).find(entry=>entry.entity==='AMZN').sourceStatus,'未配置来源');
});
test('shared unit text cannot hide conflicting currencies; percentage units ignore incidental currency metadata',()=>{
 let input=data([definition('MSFT',{unit:'百万',currency:'USD'}),definition('AMZN',{unit:'百万',currency:'JPY'})],{});
 assert.equal(buildCompanyComparison(input,opts).compatible,false);assert.equal(buildCompanyComparison(input,{...opts,mode:'yoy'}).compatible,true);
 input=data([definition('MSFT',{unit:'%',currency:'USD'}),definition('AMZN',{unit:'%',currency:'JPY'})],{});
 assert.equal(buildCompanyComparison(input,opts).compatible,true);
});
test('transforms reuse chartRows: percent changes are points and nonpositive money bases stay missing',()=>{
 let input=data([definition('MSFT',{unit:'%'})],{'MSFT.capex':[point('2025-06-30',-5),point('2026-06-30',10)]});
 let model=buildCompanyComparison(input,{...opts,entities:['MSFT'],mode:'yoy'});
 assert.equal(model.unit,'个百分点');assert.equal(model.rows.at(-1).values['MSFT.capex'],15);
 input=data([definition('MSFT')],{'MSFT.capex':[point('2025-06-30',0),point('2026-06-30',10)]});
 model=buildCompanyComparison(input,{...opts,entities:['MSFT'],mode:'yoy'});assert.equal(model.rows.at(-1).values['MSFT.capex'],null);assert.equal(comparisonSnapshot(model,'2026Q2',input)[0].missingReason,'缺少可比基期');
});
test('company colors do not change with selection or sorting and coverage ranges remain explicit',()=>{
 assert.equal(companyColor('ORCL'),'#d38067');assert.notEqual(companyColor('ORCL'),companyColor('MSFT'));
 assert.equal(quarterSummary(['2024Q1','2024Q2','2024Q3','2025Q1']),'2024Q1—2024Q3、2025Q1');
 const empty=buildCompanyComparison({definitions:[],series:{}},opts);assert.deepEqual(empty.rows,[]);assert.equal(empty.defaultQuarter,null);
});
test('five-company capex totals use only the selected common quarter and never replace a missing value with zero',()=>{
 const companies=['MSFT','GOOG','META','AMZN','ORCL'];
 const defs=companies.map(entity=>definition(entity));
 const input=data(defs,Object.fromEntries(companies.map((entity,index)=>[entity+'.capex',[point('2026-06-30',index),...(entity==='ORCL'?[]:[point('2026-09-30',10+index)])]])));
 const model=buildCompanyComparison(input,{...opts,entities:companies});
 assert.equal(coreCapexTotal(model,'2026Q2').value,10);assert.equal(coreCapexTotal(model,'2026Q3').value,null);assert.deepEqual(coreCapexTotal(model,'2026Q3').missingEntities,['ORCL']);
 assert.equal(coreCapexTotal(buildCompanyComparison(input,{...opts,entities:companies.slice(1)}),'2026Q2'),null);
 assert.equal(coreCapexTotal(buildCompanyComparison(input,{...opts,entities:companies,mode:'normalized'}),'2026Q2'),null);
});
test('source failure, missing source and unpublished states stay explicit in the selected-quarter detail',()=>{
 const input=data([definition('MSFT'),definition('AMZN')],{'MSFT.capex':[point('2026-06-30',10)]});
 input.series['MSFT.capex'].status='cached';input.series['MSFT.capex'].error='unavailable';delete input.series['AMZN.capex'];
 let snapshot=comparisonSnapshot(buildCompanyComparison(input,opts),'2026Q2',input);
 assert.equal(snapshot[0].status,'获取失败 · 展示缓存');assert.equal(snapshot[1].status,'该季度缺少观测 · 待接入');
 input.series['AMZN.capex']={status:'no_observation',observations:[]};snapshot=comparisonSnapshot(buildCompanyComparison(input,opts),'2026Q2',input);assert.equal(snapshot[1].status,'该季度缺少观测 · 暂无观测');
 input.series['AMZN.capex'].status='not_published';snapshot=comparisonSnapshot(buildCompanyComparison(input,opts),'2026Q2',input);assert.equal(snapshot[1].status,'该季度缺少观测 · 尚未发布');
 input.series['AMZN.capex'].status='ready';snapshot=comparisonSnapshot(buildCompanyComparison(input,opts),'2026Q2',input);assert.equal(snapshot[1].status,'该季度缺少观测');
 input.series['AMZN.capex'].status='cached';snapshot=comparisonSnapshot(buildCompanyComparison(input,opts),'2026Q2',input);assert.equal(snapshot[1].status,'该季度缺少观测 · 展示缓存');
});
