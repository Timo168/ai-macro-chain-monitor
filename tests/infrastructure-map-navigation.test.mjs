import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {validReadingView} from '../lib/reading-view.mjs';
import {resolveEnergyTopic,resolveEnergyView} from '../lib/energy-panels.mjs';
import {regionalNavigation} from '../lib/regional-energy.mjs';

const data={schemaVersion:'1',generatedAt:'2026-11-12T00:00:00Z',definitions:[],series:{},projects:[],events:[]};
const load={id:'EIA_ERCO_DEMAND',name:'ERCOT 实际小时负荷',kind:'load',frequency:'hourly',unit:'MW',timeZone:'America/Chicago',status:'available',sourceName:'EIA',sourceUrl:'https://www.eia.gov/electricity/gridmonitor/',exportAllowed:true,observations:[{date:'2026-11-11T00:00:00Z',value:42000}]};
const regional={regions:[{id:'ercot',name:'得克萨斯 · ERCOT',series:[load]}]};
const modules=new Map();
async function component(file){
 if(modules.has(file))return modules.get(file);
 const result=await build({entryPoints:[resolve(file)],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},logLevel:'silent',plugins:[{name:'map-navigation-observer',setup(builder){
  builder.onResolve({filter:/observer-context$/},()=>({path:'observer',namespace:'navigation-fixture'}));
  builder.onLoad({filter:/.*/,namespace:'navigation-fixture'},()=>({contents:'export const useObserver=()=>globalThis.__mapNavigationObserver;'}));
 }}]});
 const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
 modules.set(file,module.exports.default);return module.exports.default;
}
function render(Component,props={}){
 const previous=globalThis.__mapNavigationObserver;
 globalThis.__mapNavigationObserver={inputs:{regionalEnergy:regional,industry:data,macro:{series:{}}},catalog:[],errors:[],loading:false,refresh:()=>{}};
 try{return renderToStaticMarkup(React.createElement(Component,props));}finally{if(previous===undefined)delete globalThis.__mapNavigationObserver;else globalThis.__mapNavigationObserver=previous;}
}
function hrefFor(html,label){
 const anchors=[...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
 const found=anchors.find(([,href,content])=>content.includes(label));assert.ok(found,'Expected navigation link: '+label);
 return new URL(found[1].replaceAll('&amp;','&'),'https://example.org');
}

test('the actual map market link opens a valid material page, regional topic and selected load series',async()=>{
 const html=render(await component('app/industry/infrastructure-map.tsx'),{data,initialLayer:'markets'});
 const url=hrefFor(html,'查看完整电力图表');
 assert.equal(validReadingView(url.search+url.hash),true,'Dashboard must recognize the destination page');
 assert.equal(url.searchParams.get('page'),'materials');
 assert.equal(resolveEnergyTopic(url.hash)?.id,'electricity');
 assert.equal(resolveEnergyView('electricity',url.hash,'electricity-us').id,'regional-energy');
 assert.deepEqual(regionalNavigation(regional,url.search,url.hash),{regionId:'ercot',seriesId:load.id});
});

test('the regional electricity panel exposes a working return link to the shared infrastructure map',async()=>{
 const html=render(await component('app/regional-energy.tsx'));
 const url=hrefFor(html,'在地图上对照地区电价');
 assert.equal(validReadingView(url.search+url.hash),true);
 assert.equal(url.searchParams.get('page'),'impact');
 assert.equal(url.searchParams.get('industry'),'metrics');
 assert.equal(url.searchParams.get('category'),'power');
 assert.equal(url.hash,'#infrastructure-map');
 assert.notEqual(url.searchParams.get('infrastructure'),'metrics');
});
