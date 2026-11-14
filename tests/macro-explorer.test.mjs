import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

let summarize;
async function load(){
 if(summarize)return summarize;
 const built=await build({entryPoints:[resolve('app/macro-explorer.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},logLevel:'silent'});
 const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
 summarize=module.exports.macroExplorerSummary;return summarize;
}
const group=(id,series,extra={})=>({id,series,title:id,unit:'%',frequency:'月度',category:1,read:'',impact:'',sectors:[],...extra});
const cpi=group('cpi',['CPIAUCNS','CPILFENS','CPIAUCSL','CPILFESL'],{kind:'inflation'});
const policy=group('policy',['DFEDTARL','DFEDTARU'],{kind:'step',frequency:'日度'});
const series=(id,points,extra={})=>({id,status:'ready',observations:points.map(([date,value])=>({date,value})),...extra});
const dataset=entries=>({generatedAt:'2026-11-10T00:00:00Z',series:Object.fromEntries(entries.map(item=>[item.id,item]))});

test('revisiting an overview reuses its snapshot and a revised observation replaces the cached headline',async()=>{
 const built=await build({entryPoints:['lib/overview-snapshot.ts'],bundle:true,write:false,platform:'node',format:'cjs'});
 const module={exports:{}};
 new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
 const {getOverviewSnapshot}=module.exports;
 const snapshot=dataset([series('NFCI',[['2026-10-02',-.6],['2026-10-16',-.3],['2026-10-30',-.2]])]);
 const original=getOverviewSnapshot(snapshot);
 assert.equal(getOverviewSnapshot(snapshot),original);
 const row=original.byId.get('nfci');
 assert.equal(row.m.last.value,-.2);
 assert.equal(row.priorWeek,undefined);
 assert.equal(row.four.value,-.6);
 const revision=dataset([series('NFCI',[['2026-10-30',-.4]])]);
 const next=getOverviewSnapshot(revision);
 assert.notEqual(next,original);
 assert.equal(next.changes[0].m.last.value,-.4);
 assert.equal(original.byId.get('nfci').m.last.value,-.2);
});

test('a new CPI raw value with missing year-earlier base labels the older valid rate explicitly',async()=>{
 const summary=(await load())(cpi,dataset([series('CPIAUCNS',[['2025-09-01',324.8],['2025-10-01',null],['2026-09-01',336.94],['2026-10-01',337.511]])]));
 assert.equal(summary.valueText,'3.74');assert.equal(summary.date,'2026-09-01');
 assert.equal(summary.name,'CPI · 最近有效同比');assert.equal(summary.note,'原值截至 2026-10；同比缺少 2025-10 基期');assert.equal(summary.warning,true);
});
test('CPI with a valid comparison month shows the new computed month and names the percentage measure',async()=>{
 const summary=(await load())(cpi,dataset([series('CPIAUCNS',[['2025-10-01',100],['2026-10-01',103]])]));
 assert.equal(summary.valueText,'3.00');assert.equal(summary.date,'2026-10-01');assert.equal(summary.name,'CPI · 同比');assert.equal(summary.note,'');
});
test('the same helper respects seasonally adjusted monthly CPI and does not carry a yearly-base warning into it',async()=>{
 const summary=(await load())(cpi,dataset([series('CPIAUCSL',[['2026-09-01',336.298],['2026-10-01',337.476]])]),'mom');
 assert.equal(summary.valueText,'0.35');assert.equal(summary.date,'2026-10-01');assert.equal(summary.name,'CPI · 环比');assert.equal(summary.note,'');
});
test('missing index and zero base are distinct from an unpublished derived value',async()=>{
 const run=await load();
 let summary=run(cpi,dataset([series('CPIAUCNS',[['2025-10-01',100],['2026-10-01',null]])]));
 assert.equal(summary.valueText,'—');assert.match(summary.note,/最新期缺值/);
 summary=run(cpi,dataset([series('CPIAUCNS',[['2025-10-01',0],['2026-10-01',103]])]));
 assert.equal(summary.valueText,'—');assert.match(summary.note,/同比基期为零/);
});
test('policy headlines use a complete same-day interval and retain the percentage unit',async()=>{
 const summary=(await load())(policy,dataset([series('DFEDTARL',[['2026-11-09',3.75]]),series('DFEDTARU',[['2026-11-09',4]])]));
 assert.equal(summary.valueText,'3.75–4.00');assert.equal(summary.unit,'%');assert.equal(summary.name,'目标利率区间');assert.equal(summary.date,'2026-11-09');assert.equal(summary.note,'');
});
test('policy never combines endpoints from different days and exposes a failed upper source',async()=>{
 const run=await load();
 const summary=run(policy,dataset([series('DFEDTARL',[['2026-11-08',3.75],['2026-11-09',4]]),series('DFEDTARU',[['2026-11-08',4]],{status:'cached'})]));
 assert.equal(summary.valueText,'3.75–4.00');assert.equal(summary.date,'2026-11-08');assert.match(summary.note,/2026-11-09 区间不完整/);assert.match(summary.status,/上限：获取失败 · 缓存/);assert.equal(summary.warning,true);
 const none=run(policy,dataset([series('DFEDTARL',[['2026-11-09',3.75]]),series('DFEDTARU',[['2026-11-08',4]])]));
 assert.equal(none.valueText,'—');assert.equal(none.date,null);
});
test('policy previous change belongs to the displayed complete interval rather than a newer lone endpoint',async()=>{
 const summary=(await load())(policy,dataset([series('DFEDTARL',[['2026-11-07',3.5],['2026-11-08',3.75],['2026-11-09',5]]),series('DFEDTARU',[['2026-11-07',3.75],['2026-11-08',4]])]));
 assert.equal(summary.date,'2026-11-08');assert.equal(summary.previous,0.25);
});
test('employment transformations and first yield series preserve their actual units',async()=>{
 const run=await load();
 let summary=run(group('claims',['ICSA'],{unit:'千人'}),dataset([series('ICSA',[['2026-11-07',194000]])]));assert.equal(summary.valueText,'194.0');assert.equal(summary.unit,'千人');
 summary=run(group('payrolls',['PAYEMS'],{unit:'千人'}),dataset([series('PAYEMS',[['2026-09-01',160000],['2026-10-01',160100]])]));assert.equal(summary.valueText,'100.0');assert.equal(summary.date,'2026-10-01');
 summary=run(group('yields',['DGS10','DFII10']),dataset([series('DGS10',[['2026-11-09',4.5]]),series('DFII10',[['2026-11-09',2]])]));assert.equal(summary.valueText,'4.50');assert.match(summary.name,/名义/);
});
test('full chart cards reuse the complete policy interval and explain CPI missing bases above the chart',async()=>{
 const built=await build({entryPoints:[resolve('app/chart-card.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},logLevel:'silent',plugins:[{name:'observer-context-fixture',setup(builder){builder.onResolve({filter:/observer-context$/},()=>({path:'observer',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const useObserver=()=>({catalog:[],inputs:{macro:null,industry:null},errors:[]});'}));}}]});
 const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
 const render=(group,data)=>renderToStaticMarkup(React.createElement(module.exports.default,{group,data,range:'all'}));
 let html=render(policy,dataset([series('DFEDTARL',[['2026-11-09',3.75]]),series('DFEDTARU',[['2026-11-09',4]])]));
 assert.match(html,/<div class="chart-stat">3.75–4.00 <small>%<\/small>/);assert.match(html,/下限较上期/);
 html=render(cpi,dataset([series('CPIAUCNS',[['2025-09-01',324.8],['2025-10-01',null],['2026-09-01',336.94],['2026-10-01',337.511]])]));
 assert.match(html,/CPI · 最近有效同比/);assert.match(html,/原值截至 2026-10；同比缺少 2025-10 基期/);
});
