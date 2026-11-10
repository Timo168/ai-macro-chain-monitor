import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {ALL_ENTITIES,metricAnchor,metricEntity,metricExplorerPreference,metricExplorerSummary,metricPage,metricSelectionHistory,metricSelectionUrl,resolveMetricExplorer} from '../lib/industry/metric-explorer.mjs';

const def=(id,entity='MSFT',category='capex',extras={})=>({id,entity,category,nameZh:'现金资本开支',nameEn:'Cash capital spending',family:'capex',unit:'亿美元',frequency:'quarterly',normalUpdateDelayDays:60,sourceName:'Company IR',sourceUrl:'https://example.org/report',...extras});
const rows=[def('MSFT.capex'),def('MSFT.cash',undefined,undefined,{nameZh:'营业现金流'}),def('GOOG.capex','GOOG'),def('PROJECT.capacity','PROJECT','projects')];
const options={category:'capex'};
const point=(periodEnd,value)=>({periodEnd,value,version:'v1'});
test('the directory stays in registry order and defaults to one selected metric',()=>{
 const result=resolveMetricExplorer(rows,options);
 assert.deepEqual(result.entities,['MSFT','GOOG']);assert.equal(result.entity,ALL_ENTITIES);assert.equal(result.selected.id,'MSFT.capex');assert.equal(result.rows.length,3);
 assert.deepEqual(resolveMetricExplorer(rows,{...options,entity:'GOOG'}).rows.map(d=>d.id),['GOOG.capex']);
});
test('deep links win over saved metric and incompatible company, including late arriving definitions',()=>{
 const saved={...options,entity:'MSFT',metricId:'MSFT.cash',anchorId:'GOOG.capex'};
 assert.equal(resolveMetricExplorer([],saved).selected,null);
 const result=resolveMetricExplorer(rows,saved);assert.equal(result.entity,'GOOG');assert.equal(result.selected.id,'GOOG.capex');
 assert.equal(resolveMetricExplorer(rows,{...saved,entity:ALL_ENTITIES}).entity,ALL_ENTITIES);
});
test('search never exposes a chart outside the filtered list and clear entity does not leak another category',()=>{
 const result=resolveMetricExplorer(rows,{...options,search:'现金流',anchorId:'GOOG.capex'});
 assert.deepEqual(result.rows.map(d=>d.id),['MSFT.cash']);assert.equal(result.selected.id,'MSFT.cash');
 assert.equal(resolveMetricExplorer(rows,{...options,search:'no match'}).selected,null);
 assert.equal(resolveMetricExplorer(rows,{category:'projects',entity:'MSFT',metricId:'MSFT.cash'}).selected.id,'PROJECT.capacity');
 assert.equal(resolveMetricExplorer(rows,{...options,search:'goog'}).selected.id,'GOOG.capex');
});
test('missing entities, removed saved IDs and absent categories have explicit fallbacks',()=>{
 assert.equal(metricEntity(def('unknown','')),'__other__');
 assert.equal(resolveMetricExplorer(rows,{...options,entity:'REMOVED',metricId:'REMOVED.capex'}).selected.id,'MSFT.capex');
 assert.deepEqual(resolveMetricExplorer(rows,{category:'absent'}).rows,[]);
 assert.equal(metricExplorerPreference({entity:ALL_ENTITIES,metricId:''}),true);assert.equal(metricExplorerPreference(null),false);assert.equal(metricExplorerPreference({entity:'MSFT'}),false);
});
test('URL helpers retain deployment path, page and unrelated query filters',()=>{
 assert.equal(metricSelectionUrl('https://example.org/ai-macro-chain-monitor/?page=impact&industry=metrics&range=3#old','GOOG.capex'),'/ai-macro-chain-monitor/?page=impact&industry=metrics&range=3#GOOG.capex');
 assert.equal(metricAnchor('#%E9%93%9C.price'),'铜.price');assert.equal(metricAnchor('#%bad'),'');
 assert.equal(metricSelectionUrl('https://example.org/?page=impact#old',''),'/?page=impact');
 assert.equal(metricPage(Array.from({length:15},(_,index)=>({id:String(index)})),'13'),2);
});
test('the first implicit selection is recorded before navigation so Back restores it',()=>{
 const href='https://example.org/monitor/?page=impact&industry=metrics&category=capex&range=3';
 const steps=metricSelectionHistory(href,'MSFT.capex','GOOG.capex');
 assert.deepEqual(steps,[{method:'replaceState',url:'/monitor/?page=impact&industry=metrics&category=capex&range=3#MSFT.capex'},{method:'pushState',url:'/monitor/?page=impact&industry=metrics&category=capex&range=3#GOOG.capex'}]);
 // The persisted selection has moved to B, but Back's URL still restores A.
 const backAnchor=metricAnchor(new URL(steps[0].url,'https://example.org').hash);
 assert.equal(resolveMetricExplorer(rows,{...options,entity:'GOOG',metricId:'GOOG.capex',anchorId:backAnchor}).selected.id,'MSFT.capex');
 assert.deepEqual(metricSelectionHistory(href+'#MSFT.capex','MSFT.capex','GOOG.capex'),[steps[1]]);
 assert.deepEqual(metricSelectionHistory(href+'#GOOG.capex','GOOG.capex','GOOG.capex'),[]);
 assert.deepEqual(metricSelectionHistory(href,'MSFT.capex','MSFT.capex'),[steps[0]]);
});
test('a category entered without a hash records its own current selection',()=>{
 const href='https://example.org/monitor/?page=impact&industry=metrics&category=projects';
 const steps=metricSelectionHistory(href,'PROJECT.capacity','PROJECT.construction');
 assert.equal(steps[0].url,'/monitor/?page=impact&industry=metrics&category=projects#PROJECT.capacity');
 assert.equal(steps[1].url,'/monitor/?page=impact&industry=metrics&category=projects#PROJECT.construction');
 assert.deepEqual(metricSelectionHistory(href,'',''),[]);
});
test('summaries reuse exact metricStats values and keep percentage-point versus growth units',()=>{
 const series={status:'ready',observations:[point('2025-06-30',100),point('2026-06-30',125)]};
 let result=metricExplorerSummary(def('MSFT.capex'),series,'2026-07-15');assert.equal(result.value,125);assert.equal(result.yoy,25);assert.equal(result.yoyUnit,'%');assert.equal(result.unit,'亿美元');
 result=metricExplorerSummary(def('MSFT.margin','MSFT','cloud',{unit:'%',family:'cloud_margin'}),{...series,observations:[point('2025-06-30',20),point('2026-06-30',25)]},'2026-07-15');assert.equal(result.yoy,5);assert.equal(result.yoyUnit,'个百分点');
 result=metricExplorerSummary(def('MSFT.growth','MSFT','cloud',{unit:'%',family:'cloud_growth'}),{...series,observations:[point('2026-06-30',25)]},'2026-07-15');assert.equal(result.yoy,25);assert.equal(result.yoyLabel,'披露同比');assert.equal(result.yoyUnit,'%');
});
test('missing points do not become zeros and cache/failure/source states remain visible',()=>{
 let result=metricExplorerSummary(def('MSFT.capex'),{status:'cached',error:'upstream failure',observations:[point('2026-06-30',125)]},'2026-07-15');assert.equal(result.value,125);assert.equal(result.status,'获取失败 · 展示缓存');assert.equal(result.warning,true);
 result=metricExplorerSummary(def('MSFT.capex'),{status:'ready',observations:[point('2026-03-31',125),point('2026-06-30',null)]},'2026-07-15');assert.equal(result.value,null);assert.equal(result.yoy,null);assert.equal(result.period,'2026-06-30');assert.match(result.status,/最新期缺值/);
 result=metricExplorerSummary(def('MSFT.capex'),undefined,'2026-07-15');assert.equal(result.value,null);assert.equal(result.status,'待接入');
 result=metricExplorerSummary(def('MSFT.capex'),{status:'not_configured',observations:[]},'2026-07-15');assert.equal(result.status,'未配置来源');
 result=metricExplorerSummary(def('MSFT.capex'),{status:'ready',observations:[point('2024-06-30',0)]},'2026-07-15');assert.equal(result.value,0);assert.match(result.status,/超过更新周期/);
});

let Explorer;
async function loadExplorer(){
 if(Explorer)return Explorer;
 const require=createRequire(import.meta.url);
 const output=await build({entryPoints:[resolve('app/industry/metric-explorer.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},logLevel:'silent'});
 const module={exports:{}};
 // Bundle only project code; React stays external so the renderer shares its hooks.
 new Function('require','module','exports',output.outputFiles[0].text)(require,module,module.exports);
 Explorer=module.exports.default;
 return Explorer;
}
test('a large catalog renders only six summaries and one complete chart',async()=>{
 const Component=await loadExplorer(),calls=[];
 const definitions=Array.from({length:24},(_,index)=>def('MSFT.metric'+index,'MSFT','capex',{nameZh:'指标 '+index}));
 const data={definitions,series:{}};
 const html=renderToStaticMarkup(React.createElement(Component,{data,category:'capex',search:'',now:'2026-11-10',renderMetric:definition=>{calls.push(definition.id);return React.createElement('article',{'data-rendered-metric':definition.id},'full chart');}}));
 assert.deepEqual(calls,['MSFT.metric0']);assert.equal((html.match(/aria-pressed="(?:true|false)"/g)??[]).length,6);assert.match(html,/24 项/);assert.match(html,/下一页指标/);assert.match(html,/收起图表/);
});
test('empty search renders no unrelated chart and offers clearing the filters',async()=>{
 const Component=await loadExplorer(),calls=[];
 const html=renderToStaticMarkup(React.createElement(Component,{data:{definitions:rows,series:{}},category:'capex',search:'not-found',now:'2026-11-10',renderMetric:definition=>{calls.push(definition.id);return null;},onClearSearch:()=>{}}));
 assert.equal(calls.length,0);assert.match(html,/没有符合当前筛选的指标/);assert.match(html,/清除筛选/);
});
