import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {panelAnchor,resolvePanelSelection,panelSelectionUrl} from '../lib/panel-explorer.mjs';

const items=[{id:'claims',title:'就业',anchor:'claims'},{id:'regional',title:'电力',anchor:'regional-energy',aliases:['EIA_PJM_DEMAND']}];
test('deep links select the containing panel before saved preferences, including nested metrics',()=>{
 assert.equal(resolvePanelSelection(items,'claims','#EIA_PJM_DEMAND').id,'regional');
 assert.equal(resolvePanelSelection(items,'regional','#claims').id,'claims');
 assert.equal(resolvePanelSelection(items,'removed','#unknown').id,'claims');
 assert.equal(resolvePanelSelection([],'claims','#claims'),null);
 assert.equal(panelAnchor('#%E9%93%9C'),'铜');assert.equal(panelAnchor('#%bad'),'');
});
test('panel links preserve deployment base and all query filters',()=>{
 assert.equal(panelSelectionUrl('https://example.org/monitor/?page=impact&industry=conclusions&research=validation#old','research-progress'),'/monitor/?page=impact&industry=conclusions&research=validation#research-progress');
 assert.equal(panelSelectionUrl('https://example.org/monitor/?page=materials&range=3#old',''),'/monitor/?page=materials&range=3');
});
let Component;
async function load(){if(Component)return Component;const output=await build({entryPoints:[resolve('app/panel-explorer.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},logLevel:'silent'});const module={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);Component=module.exports.default;return Component;}
test('large catalogs mount one detailed panel and only six directory cards',async()=>{
 const Explorer=await load(),calls=[];
 const html=renderToStaticMarkup(React.createElement(Explorer,{title:'指标',storageKey:'test',items:Array.from({length:30},(_,i)=>({id:String(i),title:'指标'+i})),renderPanel:id=>{calls.push(id);return React.createElement('article',null,id);}}));
 assert.deepEqual(calls,['0']);assert.equal((html.match(/aria-pressed=/g)??[]).length,6);assert.match(html,/30 个主题/);assert.match(html,/指标下一页/);assert.match(html,/aria-controls=/);
});
test('controlled selection renders the chosen topic and empty catalog calls no renderer',async()=>{
 const Explorer=await load(),calls=[];const renderPanel=id=>{calls.push(id);return React.createElement('p',null,id)};
 const html=renderToStaticMarkup(React.createElement(Explorer,{title:'主题',storageKey:'controlled',items,selectedId:'regional',renderPanel}));
 assert.deepEqual(calls,['regional']);assert.match(html,/value="regional" selected/);
 calls.length=0;const empty=renderToStaticMarkup(React.createElement(Explorer,{title:'主题',storageKey:'empty',items:[],renderPanel}));assert.equal(calls.length,0);assert.match(empty,/暂无可展示内容/);
});
