import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {researchRouteTopic,researchTopicFromLocation,sourceCatalogPage} from '../lib/industry/panel-navigation.mjs';

const base='https://example.org/monitor/?page=impact&industry=conclusions';
test('research query links open follow-up subjects even without a hash',()=>{
 for(const section of ['attention','changes','robustness','tracking','validation','valuation','crossCompany','modelEvaluation'])assert.equal(researchTopicFromLocation(base+'&research='+section,'sectors'),'progress');
 assert.equal(researchTopicFromLocation(base+'&research=valuation&company=GOOG','plans'),'progress');
 assert.equal(researchTopicFromLocation(base,'plans'),'plans');
});
test('explicit subject anchors win over a stale follow-up query',()=>{
 assert.equal(researchTopicFromLocation(base+'&research=validation#plan-delivery'),'plans');
 assert.equal(researchTopicFromLocation(base+'&research=validation#research-conclusions'),'sectors');
 assert.equal(researchTopicFromLocation(base+'#research-rules','progress'),'rules');
 assert.equal(researchTopicFromLocation(base+'#research-progress','rules'),'progress');
 assert.equal(researchTopicFromLocation(base+'#%72esearch-progress'),'progress');
});
test('unrecognized or malformed links fall back to a valid saved subject',()=>{
 assert.equal(researchTopicFromLocation(base+'&research=absent#%broken','plans'),'plans');
 assert.equal(researchTopicFromLocation(base,'removed-topic'),'sectors');
 assert.equal(researchTopicFromLocation('',undefined),'sectors');
 assert.equal(researchRouteTopic(base),null); // A normal mount must not overwrite the saved topic.
 assert.equal(researchRouteTopic(base+'&research=unknown#unrelated'),null);
});

const definitions=Array.from({length:21},(_,i)=>({id:'M'+i,entity:i%2?'GOOG':'MSFT',category:i<12?'capex':'cloud',nameZh:'指标'+i,nameEn:'Metric '+i,sourceName:'Official IR',unit:i%2?'%':'亿美元'}));
test('catalog pagination preserves order, units and every entry',()=>{
 const first=sourceCatalogPage(definitions);assert.deepEqual(first.items.map(d=>d.id),['M0','M1','M2','M3','M4','M5','M6','M7']);assert.equal(first.pages,3);assert.equal(first.count,21);
 assert.strictEqual(first.items[0],definitions[0]);assert.equal(first.items[1].unit,'%');
 assert.deepEqual(sourceCatalogPage(definitions,{page:99}).items.map(d=>d.id),['M16','M17','M18','M19','M20']);
 assert.equal(sourceCatalogPage(definitions,{page:-1}).page,0);
});
test('catalog search and category filters compose and reset an invalid page',()=>{
 const result=sourceCatalogPage(definitions,{search:' goog ',category:'cloud',page:2});assert.deepEqual(result.items.map(d=>d.id),['M13','M15','M17','M19']);assert.equal(result.page,0);
 assert.equal(sourceCatalogPage(definitions,{search:'official ir'}).count,21);
 const empty=sourceCatalogPage(definitions,{search:'no-such-company'});assert.deepEqual(empty.items,[]);assert.equal(empty.pages,1);assert.equal(empty.count,0);
 assert.deepEqual(sourceCatalogPage([]).items,[]);
});

const modules=new Map();
async function load(path){
 if(modules.has(path))return modules.get(path);
 const require=createRequire(import.meta.url),output=await build({entryPoints:[resolve(path)],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},logLevel:'silent'}),module={exports:{}};
 new Function('require','module','exports',output.outputFiles[0].text)(require,module,module.exports);
 modules.set(path,module.exports);return module.exports;
}
const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));

test('financial updates retain aggregate status but only mount one company detail',async()=>{
 const {FinancialUpdates}=await load('app/industry/financial-updates.tsx');
 const row=(entity,index)=>({entity,status:index?'published_pending':'cached',release:null,upcoming:null,sourceStatus:index?'ready':'cached',checkedAt:null,lastSuccessfulAt:null,sourceUrl:'https://example.org/'+entity,error:index?null:'upstream unavailable',dataStatus:'cached',latestObservationAt:null,ingestedPeriodEnd:null,note:'DETAIL-'+entity});
 const html=render(FinancialUpdates,{data:{definitions:[],financialUpdates:[row('MSFT',0),row('GOOG',1)]}});
 assert.match(html,/DETAIL-MSFT/);assert.doesNotMatch(html,/DETAIL-GOOG/);assert.match(html,/检查失败 · 展示缓存/);assert.match(html,/1<\/b> 家已发布待采集/);assert.match(html,/尚无观测/);assert.match(html,/GOOG/);
});
test('institutional reports expose one complete report without dropping cache state or sources',async()=>{
 const {InstitutionalSources}=await load('app/industry/research-sources.tsx');
 const report=(id,value)=>({id,title:'Report '+id,publisher:'Official agency',status:'cached',sourceUrl:'https://example.org/'+id,scope:'Regional scope '+id,publishedAt:'2026-10-01',modelRole:'scenario_only',unit:'TWh',facts:[{period:'2026',nature:'forecast',value}],methodology:'method-'+id,licenseNote:'public fact',licenseUrl:'https://example.org/license',version:'v1',fetchedAt:'2026-10-02',error:'fetch failed'});
 const html=render(InstitutionalSources,{data:{definitions:[],researchReports:[report('first',101000),report('second',202000)],sourceCatalog:[]}});
 assert.match(html,/101,000/);assert.doesNotMatch(html,/202,000/);assert.match(html,/method-first/);assert.doesNotMatch(html,/method-second/);assert.match(html,/获取失败 · 展示缓存/);assert.match(html,/机构预测/);
});
test('robustness renders a selected target rather than all scenario tables',async()=>{
 const {ResearchRobustness}=await load('app/industry/research-tools.tsx');
 const targets=Array.from({length:18},(_,i)=>({targetId:'t'+i,targetName:'Target '+i,baselineScore:i===0?0:-10,scoreRange:{min:-20,max:0},summary:'DETAIL-'+i,scenarios:[{id:'s'+i,label:'SCENARIO-'+i,score:i===0?0:null,delta:0,eligible:i===0}],scenarioCount:1}));
 const html=render(ResearchRobustness,{data:{targets,limitations:[]}});
 assert.match(html,/DETAIL-0/);assert.doesNotMatch(html,/DETAIL-1</);assert.match(html,/SCENARIO-0/);assert.doesNotMatch(html,/SCENARIO-1</);assert.match(html,/当前 0\.00 分/);assert.match(html,/Target 17/);assert.match(html,/下一页/);
});
test('validation keeps different horizon and tier groups selectable, showing only one evidence table',async()=>{
 const {ResearchValidation}=await load('app/industry/research-tools.tsx');
 const groups=[1,3,6].flatMap(months=>['formal','leading'].map(tier=>({targetId:'cloud',targetName:'Cloud',months,tier,evaluationPhase:'prospective',count:0,sampleAdequacy:'insufficient',scoreBands:[{id:'b',label:'BAND-'+months+'-'+tier,count:0}],costScenarios:[]})));
 const html=render(ResearchValidation,{data:{groups,method:{sampleThreshold:20},limitations:[]}});
 assert.match(html,/BAND-1-formal/);assert.doesNotMatch(html,/BAND-3-formal/);assert.match(html,/Cloud · 6 个月/);assert.match(html,/样本仍不足/);assert.doesNotMatch(html,/平均扣费收益 0/);
});
test('cross-company checking retains all groups but renders only the chosen company evidence',async()=>{
 const {ResearchCrossCompany}=await load('app/industry/research-tools.tsx');
 const group=(id)=>({id,name:'Group '+id,summary:'Summary '+id,boundary:'BOUNDARY-'+id,companies:[{entity:'Company-'+id,scope:'SCOPE-'+id,revenue:null,profit:null}]});
 const html=render(ResearchCrossCompany,{data:{groups:[group('first'),group('second')]},showMetric:()=>{}});
 assert.match(html,/SCOPE-first/);assert.doesNotMatch(html,/SCOPE-second/);assert.match(html,/Group second/);assert.match(html,/尚未取得通过校验的公开历史/);
});
test('plan delivery keeps the catalog while mounting only one plan timeline',async()=>{
 const {PlanDelivery}=await load('app/industry/plan-delivery.tsx');
 const html=render(PlanDelivery,{data:{definitions:[],series:{}}});
 assert.equal((html.match(/class="plan-delivery-steps"/g)??[]).length,1);assert.match(html,/选择公司与计划期间/);assert.match(html,/版本、来源状态与比较规则/);
});

test('missing or version-mismatched research gives an explicit selected-panel state and available alternatives',async()=>{
 const {ResearchPending}=await load('app/industry/research-pending.tsx');
 for(const topic of ['sectors','progress']){
  const html=render(ResearchPending,{topic,issue:'研究结论正在等待与当前数据版本一致的更新。',onRules:()=>{},onPlans:()=>{}});
  assert.match(html,/role="status"/);assert.match(html,/等待与当前数据版本一致/);assert.match(html,/先看方向规则与历史/);assert.match(html,/查看企业计划兑现/);
  assert.match(html,new RegExp('id="'+(topic==='progress'?'research-progress':'research-conclusions')+'"'));
 }
});
