import test from 'node:test';
import assert from 'node:assert/strict';
import {energyTopics,resolveEnergyTopic,resolveEnergyView,energySelectionUrl} from '../lib/energy-panels.mjs';
import {regionalNavigation} from '../lib/regional-energy.mjs';

const byTopic={
 'mineral-resources':['mineral-resources','copper','aluminum','iron-ore','nickel','gold','silver'],
 'oil-commodities':['oil-commodities','brent','commodity-comparison','DCOILBRENTEU'],
 'natural-gas':['natural-gas','natural-gas-daily','natural-gas-us','DHHNGSP','NATGAS_US'],
 electricity:['electricity','electricity-us','regional-energy','EIA_US_COMMERCIAL','EIA_ERCOT_NORTH_PRICE','EIA_ERCO_DEMAND','EIA_PJM_WEST_PRICE','EIA_PJM_DEMAND'],
 'coal-aus':['coal-aus','COAL_AUS'],
};
test('all existing material bookmarks resolve to one of five unique topics',()=>{
 assert.equal(energyTopics.length,5);assert.equal(new Set(energyTopics.map(topic=>topic.id)).size,5);
 const seen=new Set();
 for(const [topicId,anchors] of Object.entries(byTopic))for(const anchor of anchors){
  assert.equal(resolveEnergyTopic(anchor)?.id,topicId,anchor);assert.equal(resolveEnergyTopic('#'+anchor)?.id,topicId,'#'+anchor);
  assert.equal(seen.has(anchor),false,'ambiguous alias '+anchor);seen.add(anchor);
 }
});
test('legacy saved chart IDs migrate to their containing topics without dropping their leaf views',()=>{
 for(const [saved,topicId] of [['brent','oil-commodities'],['commodity-comparison','oil-commodities'],['natural-gas-us','natural-gas'],['natural-gas-daily','natural-gas'],['electricity-us','electricity'],['regional-energy','electricity']]){
  assert.equal(resolveEnergyTopic(saved).id,topicId);
  assert.equal(resolveEnergyView(topicId,'',saved).id,saved);
 }
});
test('explicit leaf hashes beat stored frequency or electricity view',()=>{
 assert.equal(resolveEnergyView('natural-gas','#natural-gas-us','natural-gas-daily').id,'natural-gas-us');
 assert.equal(resolveEnergyView('natural-gas','#DHHNGSP','natural-gas-us').id,'natural-gas-daily');
 assert.equal(resolveEnergyView('natural-gas','#NATGAS_US','natural-gas-daily').id,'natural-gas-us');
 assert.equal(resolveEnergyView('electricity','#EIA_PJM_DEMAND','electricity-us').id,'regional-energy');
 assert.equal(resolveEnergyView('electricity','#electricity-us','regional-energy').id,'electricity-us');
 assert.equal(resolveEnergyView('oil-commodities','#commodity-comparison','brent').id,'commodity-comparison');
});
test('unknown, removed and unrelated selections use only valid views in the selected topic',()=>{
 assert.equal(resolveEnergyTopic('#removed'),undefined);
 assert.equal(resolveEnergyView('natural-gas','#unknown','removed').id,'natural-gas-daily');
 assert.equal(resolveEnergyView('natural-gas','#brent','natural-gas-us').id,'natural-gas-us');
 assert.equal(resolveEnergyView('electricity','#unknown','removed').id,'electricity-us');
 assert.equal(resolveEnergyView('mineral-resources','#gold'),null);assert.equal(resolveEnergyView('coal-aus','#coal-aus'),null);assert.equal(resolveEnergyView('removed','#brent'),null);
});
test('new regional series become routable when data arrives and open the regional view',()=>{
 const newIds=['EIA_CAISO_DEMAND','EIA_MISO_PRICE'];
 for(const id of newIds){
  assert.equal(resolveEnergyTopic('#'+id),undefined);
  assert.equal(resolveEnergyTopic('#'+id,newIds)?.id,'electricity');
  assert.equal(resolveEnergyView('electricity','#'+id,'electricity-us',newIds).id,'regional-energy');
 }
 // Existing links can resolve before the lazy-loaded regional data exists.
 assert.equal(resolveEnergyTopic('#EIA_PJM_DEMAND',[])?.id,'electricity');
});
test('moving to oil or gas clears unrelated commodity and region selectors while preserving range and deployment path',()=>{
 const before='https://example.org/ai-macro-chain-monitor/?page=materials&range=3&chartRange=5&commodityMode=monthly&minerals=GOLD&series=MKT_GOLD&region=pjm&custom=keep#gold';
 for(const anchor of ['brent','commodity-comparison','natural-gas-daily','natural-gas-us','coal-aus']){
  const result=new URL(energySelectionUrl(before,anchor),'https://example.org');
  assert.equal(result.pathname,'/ai-macro-chain-monitor/');assert.equal(result.hash,'#'+anchor);
  for(const [key,value] of [['page','materials'],['range','3'],['chartRange','5'],['custom','keep']])assert.equal(result.searchParams.get(key),value);
  for(const key of ['commodityMode','minerals','series','region'])assert.equal(result.searchParams.has(key),false,anchor+' '+key);
 }
});
test('retail electricity clears regional state while regional view retains the requested region',()=>{
 const before='https://example.org/monitor/?page=materials&range=all&chartRange=1&region=pjm&series=EIA_PJM_DEMAND&commodityMode=market#EIA_PJM_DEMAND';
 let result=new URL(energySelectionUrl(before,'electricity-us'),'https://example.org');
 assert.equal(result.searchParams.has('region'),false);assert.equal(result.searchParams.has('series'),false);assert.equal(result.searchParams.has('commodityMode'),false);
 result=new URL(energySelectionUrl(before,'regional-energy'),'https://example.org');
 assert.equal(result.searchParams.get('region'),'pjm');assert.equal(result.searchParams.get('range'),'all');assert.equal(result.searchParams.get('chartRange'),'1');assert.equal(result.searchParams.has('commodityMode'),false);
});
test('explicit monthly commodity links keep their basis when opening a metal',()=>{
 const result=new URL(energySelectionUrl('https://example.org/monitor/?page=materials&commodityMode=monthly&region=pjm&series=EIA_PJM_DEMAND&range=1','copper'),'https://example.org');
 assert.equal(result.searchParams.get('commodityMode'),'monthly');assert.equal(result.searchParams.has('region'),false);assert.equal(result.searchParams.has('series'),false);assert.equal(result.hash,'#copper');
});
test('a regional leaf overrides contradictory region and series parameters through both navigation layers',()=>{
 const regions={regions:[{id:'ercot',series:[{id:'EIA_ERCO_DEMAND'}]},{id:'pjm',series:[{id:'EIA_PJM_DEMAND'}]}]};
 const anchor='#EIA_PJM_DEMAND';
 assert.equal(resolveEnergyTopic(anchor).id,'electricity');assert.equal(resolveEnergyView('electricity',anchor,'electricity-us').id,'regional-energy');
 assert.deepEqual(regionalNavigation(regions,'?page=materials&region=ercot&series=EIA_ERCO_DEMAND&chartRange=1',anchor),{regionId:'pjm',seriesId:'EIA_PJM_DEMAND'});
 assert.equal(regionalNavigation(null,'?page=materials&region=pjm',anchor),null);
 assert.deepEqual(regionalNavigation(regions,'?page=materials&region=pjm','#regional-energy'),{regionId:'pjm',seriesId:null});
});
