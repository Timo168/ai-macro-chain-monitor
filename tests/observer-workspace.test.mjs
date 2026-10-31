import test from 'node:test';
import assert from 'node:assert/strict';
import {parseObserverPins,defaultObserverPins,updateObserverPins,searchObserverItems} from '../lib/observer-preferences.mjs';

test('workspace preserves intentionally empty favorites and unavailable IDs',()=>{
 assert.deepEqual(parseObserverPins(null),defaultObserverPins);
 assert.deepEqual(parseObserverPins('{'),defaultObserverPins);
 assert.deepEqual(parseObserverPins(JSON.stringify({version:1,ids:[]})),[]);
 assert.deepEqual(parseObserverPins(JSON.stringify({version:1,ids:['unknown:awaiting-load','macro:DGS10','macro:DGS10',null]})),['unknown:awaiting-load','macro:DGS10']);
});
test('workspace sorting is bounded and never loses other favorites',()=>{
 const original=['a','b','c'];
 assert.deepEqual(updateObserverPins(original,'a','up'),original);
 assert.deepEqual(updateObserverPins(original,'b','down'),['a','c','b']);
 assert.deepEqual(updateObserverPins(original,'missing','down'),original);
 assert.deepEqual(updateObserverPins(original,'b','toggle'),['a','c']);
 assert.deepEqual(updateObserverPins(original,'d','toggle'),['a','b','c','d']);
 assert.deepEqual(original,['a','b','c']);
});
test('search supports Chinese, English, codes and multiword intersections',()=>{
 const items=[{id:'macro:DGS10',kind:'macro',title:'十年期名义收益率',subtitle:'日度',searchTerms:'nominal treasury'}, {id:'industry:MSFT.capex',kind:'industry',title:'MSFT 现金资本开支',subtitle:'季度',searchTerms:'微软 Microsoft Azure'}, {id:'macro:DFII10',kind:'macro',title:'十年期实际收益率',subtitle:'日度',searchTerms:'real treasury'}];
 assert.deepEqual(searchObserverItems(items,'微软').map(row=>row.id),['industry:MSFT.capex']);
 assert.deepEqual(searchObserverItems(items,'msft CAPEX').map(row=>row.id),['industry:MSFT.capex']);
 assert.deepEqual(searchObserverItems(items,'Microsoft 季度').map(row=>row.id),['industry:MSFT.capex']);
 assert.deepEqual(searchObserverItems(items,'DGS10').map(row=>row.id),['macro:DGS10']);
 assert.deepEqual(searchObserverItems(items,'收益率','macro').map(row=>row.id),['macro:DGS10','macro:DFII10']);
 assert.deepEqual(searchObserverItems(items,'微软','macro'),[]);
 assert.deepEqual(searchObserverItems(items,'unavailable query'),[]);
});
