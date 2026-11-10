import test from 'node:test';
import assert from 'node:assert/strict';
import {parseObserverPins,defaultObserverPins,updateObserverPins,searchObserverItems} from '../lib/observer-preferences.mjs';
import {applyObserverReadFailures} from '../lib/observer-read-state.mjs';
import {evaluateObserverAlerts} from '../lib/observer-alerts.mjs';

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

test('regional read failure stays cached in workspace and cannot trigger an alert',()=>{
 const item={id:'regional:EIA_PJM_WEST_PRICE',title:'PJM电价',kind:'macro',value:'63.91',unit:'美元/MWh',period:'2026-10-27',status:'已获取',warning:false,alertEligible:true,frequency:'daily',checkedAt:'2026-11-10T00:00:00Z',points:[{date:'2026-10-27',value:63.91}]};
 const rule={id:'r1',itemId:item.id,kind:'above',threshold:50,enabled:true,createdAt:'2026-11-10T00:00:00Z'};
 const failed=applyObserverReadFailures([item],['区域电力暂时无法读取，保留已加载数据']);
 assert.equal(failed[0].status,'读取失败 · 保留缓存');assert.equal(failed[0].warning,true);
 assert.equal(failed[0].points,item.points);assert.equal(failed[0].checkedAt,item.checkedAt);assert.equal(failed[0].value,'63.91');
 const result=evaluateObserverAlerts([rule],failed);
 assert.equal(result.results[0].state,'unavailable');assert.equal(result.events.length,0);
 assert.equal(item.alertEligible,true);assert.equal(item.status,'已获取');
 const recovered=applyObserverReadFailures([item],[]);
 assert.equal(recovered[0],item);assert.equal(evaluateObserverAlerts([rule],recovered).events.length,1);
});

test('regional and ordinary macro feeds fail independently and preserve missing data',()=>{
 const regional={id:'regional:price',kind:'macro',warning:false,alertEligible:true,points:[]};
 const macro={id:'macro:DGS2',kind:'macro',warning:false,alertEligible:true,points:[{date:'2026-11-06',value:4.51}]};
 const regionOnly=applyObserverReadFailures([regional,macro],['区域电力暂时无法读取']);
 assert.equal(regionOnly[0].status,'读取失败 · 暂无数据');assert.equal(regionOnly[1],macro);
 const macroOnly=applyObserverReadFailures([regional,macro],[],true);
 assert.equal(macroOnly[0],regional);assert.equal(macroOnly[1].alertEligible,false);
 const industry={id:'industry:MSFT.capex',kind:'industry',points:[]};
 assert.equal(applyObserverReadFailures([industry],['产业数据暂时无法读取'])[0].warning,true);
});
