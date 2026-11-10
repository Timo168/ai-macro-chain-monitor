import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {defaultObserverPins} from '../lib/observer-preferences.mjs';

const require=createRequire(import.meta.url),components=new Map();
const future=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const policyEvents=[1,3,35].map((offset,index)=>({id:'test-policy-'+index,bankId:'fed',bank:'测试央行',country:'测试国家',startDate:future(offset),decisionDate:future(offset),title:'官方会议 '+index,timezone:'America/New_York',sourceUrl:'https://example.org/policy/'+index,scheduleType:'official'}));
async function component(file,exportName='default'){
 const key=file+':'+exportName;if(components.has(key))return components.get(key);
 const result=await build({entryPoints:[resolve(file)],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},logLevel:'silent',plugins:[{
  name:'compact-panel-fixtures',setup(builder){
   builder.onResolve({filter:/observer-context$/},()=>({path:'observer',namespace:'compact-fixtures'}));
   builder.onResolve({filter:/lib\/policy-calendar$/},()=>({path:'policy',namespace:'compact-fixtures'}));
   builder.onLoad({filter:/.*/,namespace:'compact-fixtures'},({path})=>({contents:path==='observer'?'export const useObserver=()=>globalThis.__compactObserver;':`export const policyCalendar=${JSON.stringify(policyEvents)};export const policyCalendarSourceCheckedAt=${JSON.stringify(future(0))};export const policyBanks=[{id:'fed',name:'测试央行',country:'测试国家',shortName:'FED',sourceUrl:'https://example.org/policy'}];` }));
  }
 }]});
 const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,module,module.exports);
 const Component=module.exports[exportName];components.set(key,Component);return Component;
}
const series=(id,frequency,observations,status='available')=>({id,name:frequency==='hourly'?'实际小时负荷':'区域批发电价',kind:frequency==='hourly'?'load':'wholesale_price',frequency,unit:frequency==='hourly'?'MW':'美元/MWh',status,observations,timeZone:'America/Chicago',sourceName:'官方测试来源',sourceUrl:'https://example.org/electricity',exportAllowed:true});
const energy={regions:[{id:'ercot',name:'德克萨斯 · ERCOT',series:[series('TEST_PRICE','daily',[],'not_published'),series('TEST_LOAD','hourly',[{date:'2026-11-09T01:00:00Z',value:41000},{date:'2026-11-09T02:00:00Z',value:42360}])]}]};
function render(Component,props={},hash=''){
 const priorLocation=globalThis.location,priorObserver=globalThis.__compactObserver;
 globalThis.location={hash};globalThis.__compactObserver={inputs:{regionalEnergy:energy,macro:{series:{}},industry:null},catalog:[],errors:[],loading:false,refresh:()=>{}};
 try{return renderToStaticMarkup(React.createElement(Component,props));}
 finally{if(priorLocation===undefined)delete globalThis.location;else globalThis.location=priorLocation;if(priorObserver===undefined)delete globalThis.__compactObserver;else globalThis.__compactObserver=priorObserver;}
}

test('regional power keeps both indicators selectable but renders one valid-data chart by default',async()=>{
 const html=render(await component('app/regional-energy.tsx'));
 assert.equal((html.match(/<article class="re-series"/g)??[]).length,1);
 assert.match(html,/<article class="re-series" id="TEST_LOAD"/);
 assert.match(html,/<option value="TEST_PRICE"/);assert.match(html,/尚未发布/);
 assert.match(html,/42,360/);assert.match(html,/图表时区/);
 assert.match(html,/aria-label="导出实际小时负荷 CSV"/);
 assert.match(html,/<details class="re-explanation"><summary>/);
});
test('regional deep links select an unavailable price without substituting load or fabricating a zero',async()=>{
 const html=render(await component('app/regional-energy.tsx'),{},'#TEST_PRICE');
 assert.equal((html.match(/<article class="re-series"/g)??[]).length,1);
 assert.match(html,/<article class="re-series" id="TEST_PRICE"/);
 assert.doesNotMatch(html,/<article class="re-series" id="TEST_LOAD"/);
 assert.match(html,/暂无已发布的有效观测/);
 assert.match(html,/<button[^>]*disabled=""[^>]*aria-label="导出区域批发电价 CSV"/);
});
test('the workbench preserves every saved item and its operations while mounting only one full card',async()=>{
 const items=defaultObserverPins.map((id,index)=>({id,kind:'macro',title:'固定指标 '+index,subtitle:'指标说明',value:String(index+1),unit:'%',period:'2026-11-09',status:'已获取',warning:false,href:'/?page=finance#'+id,checkedAt:'2026-11-09T00:00:00Z',points:[],searchTerms:''}));
 const html=render(await component('app/observer-workspace.tsx','ObserverWorkspace'),{items,loading:false,onOpen:()=>{}});
 assert.equal((html.match(/<article class="observer-card"/g)??[]).length,1);
 for(const item of items)assert.ok(html.includes('<option value="'+item.id+'"'),item.id);
 assert.match(html,/查看图表/);assert.match(html,/上移固定指标 0/);assert.match(html,/下移固定指标 0/);assert.match(html,/从工作台移除固定指标 0/);
});
test('research dates remain selectable and bulk export keeps the whole filtered result count',async()=>{
 const html=render(await component('app/research-calendar.tsx'));
 assert.equal((html.match(/<article class="rc-event rc-event-policy"/g)??[]).length,1);
 assert.match(html,new RegExp('<option value="'+future(1)+'"'));assert.match(html,new RegExp('<option value="'+future(3)+'"'));
 assert.doesNotMatch(html,new RegExp('<option value="'+future(35)+'"'));
 assert.match(html,/选择当前结果（2）/);assert.match(html,/导出所选/);
 assert.match(html,/<details class="rc-sources"><summary>/);
});
test('policy meetings render a single month while keeping future months, following and ICS controls',async()=>{
 const html=render(await component('app/policy-calendar.tsx'));
 assert.equal((html.match(/class="policy-month"/g)??[]).length,1);
 assert.match(html,new RegExp('<option value="'+future(35).slice(0,7)+'"'));
 assert.match(html,/<details class="policy-follow"><summary>/);assert.match(html,/关注与对比范围/);
 assert.match(html,/下载关注央行的提醒/);assert.match(html,/<details class="policy-notes"><summary>/);
});
test('policy source connectivity never masquerades as a newly verified interest rate',async()=>{
 const label=await component('app/policy-calendar.tsx','policyVerificationLabel');
 assert.equal(label({status:'ready',decisionStatus:'verified'}),'尚未提供利率核验状态');
 assert.equal(label({status:'ready',rateVerificationStatus:'not_configured'}),'自动利率核验未接入');
 assert.equal(label({status:'ready',rateVerificationStatus:'cached'}),'本轮未核验新利率 · 保留上次决议');
 assert.equal(label({status:'fetch_failed',rateVerificationStatus:'fetch_failed'}),'利率获取失败 · 暂无成功决议');
 assert.equal(label({status:'ready',rateVerificationStatus:'verified'}),'本轮官方利率已核验');
});
