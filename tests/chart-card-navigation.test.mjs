import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as calculations from '../lib/calculations.mjs';
import * as health from '../lib/data-health.mjs';
import * as yields from '../lib/yield-display.mjs';

// Exercise the exported navigation logic with the real makeChart and indicator
// registry. UI imports are inert here; browser mounting is checked separately.
function loadSource(relative,dependencies={}){
 const source=readFileSync(new URL(relative,import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};new Function('require','exports','module',code)(id=>dependencies[id]??{},module.exports,module);return module.exports;
}
const data=loadSource('../lib/data.ts',{'./indicators.json':JSON.parse(readFileSync(new URL('../lib/indicators.json',import.meta.url))),'./calculations.mjs':calculations,'./data-health.mjs':health});
const preferences=loadSource('../app/use-saved-view.ts');
const {groups}=loadSource('../lib/groups.ts',{'./yield-display.mjs':yields});
const {chartNavigationIntent,shouldApplyChartGlobalRange}=loadSource('../app/chart-card.tsx',{'@/lib/data':data,'./use-saved-view':preferences});
test('page range does not act as a chart-specific range when restoring a saved view',()=>{
 const intent=chartNavigationIntent(groups.find(group=>group.id==='claims'),'yoy','?page=overview&range=1','');
 assert.equal(intent.range,null);
 assert.equal(shouldApplyChartGlobalRange('1','5',true,'5','5'),false,'initial dashboard URL restoration keeps the card preference');
 assert.equal(shouldApplyChartGlobalRange('1','1',false,'1','1'),false,'mount or data-only render cannot reset the card');
 assert.equal(shouldApplyChartGlobalRange('5','3',false,'5','3'),true,'a later global control change does reset the card');
 assert.equal(shouldApplyChartGlobalRange('1','3',true,'5','3'),true,'an explicit different selection before restoration still wins');
});
test('explicit chartRange targets only its own panel',()=>{
 const claims=groups.find(group=>group.id==='claims'),pce=groups.find(group=>group.id==='pce');
 assert.equal(chartNavigationIntent(claims,'yoy','?range=1&chartRange=5','#claims').range,'5');
 assert.equal(chartNavigationIntent(pce,'yoy','?range=1&chartRange=5','#claims').range,null);
 assert.equal(chartNavigationIntent(claims,'yoy','?chartRange=invalid','#claims').range,null);
});
test('a real-yield search link reveals DFII10 without changing the nominal headline series',()=>{
 const yields=groups.find(group=>group.id==='yields'),intent=chartNavigationIntent(yields,'yoy','?series=DFII10','#yields');
 assert.equal(yields.series[0],'DGS10');assert.equal(yields.series[intent.revealIndex],'DFII10');assert.equal(intent.mode,null);
 const previouslyHidden=[0,1],next=previouslyHidden.filter(index=>index!==intent.revealIndex);
 assert.deepEqual(next,[0],'the target is visible while unrelated legend choices remain unchanged');
});
test('core CPI search selects matching basis and reveals the selected line after saved mom state',()=>{
 const cpi=groups.find(group=>group.id==='cpi');
 const yearly=chartNavigationIntent(cpi,'mom','?series=CPILFENS&chartMode=yoy','#cpi');
 assert.equal(yearly.mode,'yoy');assert.equal(yearly.revealIndex,1);
 const inferred=chartNavigationIntent(cpi,'mom','?series=CPILFENS','#cpi');assert.equal(inferred.mode,'yoy');assert.equal(inferred.revealIndex,1);
 const monthly=chartNavigationIntent(cpi,'yoy','?series=CPILFESL&chartMode=mom','#cpi');assert.equal(monthly.mode,'mom');assert.equal(monthly.revealIndex,1);
 const unrelated=chartNavigationIntent(cpi,'yoy','?series=DFII10','#yields');assert.equal(unrelated.revealIndex,null);assert.equal(unrelated.mode,null);
});
