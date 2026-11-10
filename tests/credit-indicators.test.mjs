import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {groups} from '../lib/groups.ts';
import {metrics,parseFredCsv} from '../lib/calculations.mjs';

const registry=JSON.parse(fs.readFileSync(new URL('../lib/indicators.json',import.meta.url),'utf8'));
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/credit-source-samples.json',import.meta.url),'utf8'));

test('credit source excerpts preserve three verified historical points per series',()=>{
 for(const [id,record] of Object.entries(fixture.series)){
  assert.equal(record.samples.length,3,id);
  assert.deepEqual(parseFredCsv(record.csv),record.samples,id);
  assert.equal(registry.find(item=>item.id===id)?.frequency,record.frequency,id);
 }
 assert.equal(fixture.series.DRTSCILM.samples[1].value,41.5);
 assert.equal(fixture.series.DRTSCIS.samples[1].value,39.7);
 assert.equal(fixture.series.T10YIE.samples[1].value,.91);
 assert.equal(fixture.series.EBP.samples[1].value,.6550285809602876);
});

test('SLOOS is quarterly and separate size classes retain distinct chart series',()=>{
 const group=groups.find(item=>item.id==='sloos');
 assert.equal(group.frequency,'季度');assert.deepEqual(group.series,['DRTSCILM','DRTSCIS']);
 assert.equal(group.unit,'%');assert.equal(group.category,3);
 assert.equal(metrics([{date:'a',value:10},{date:'b',value:20}],false).previous,10);
});

test('EBP uses percentage-point differences across zero instead of percent change',()=>{
 const group=groups.find(item=>item.id==='ebp');
 assert.equal(group.unit,'个百分点');assert.deepEqual(group.series,['EBP']);
 assert.ok(Math.abs(metrics([{date:'a',value:-.3},{date:'b',value:.1}],false).previous-.4)<1e-10);
 const entry=registry.find(item=>item.id==='EBP');
 assert.ok(entry.release.startsWith('https://www.federalreserve.gov/'));
 assert.match(entry.seasonal,/研究估计/);
});

test('breakeven is rate context and daily gas remains distinct from monthly commodity history',()=>{
 assert.deepEqual(groups.find(item=>item.id==='breakeven').series,['T10YIE']);
 assert.equal(groups.find(item=>item.id==='breakeven').unit,'%');
 assert.deepEqual(groups.find(item=>item.id==='natural-gas-daily').series,['DHHNGSP']);
 assert.deepEqual(groups.find(item=>item.id==='natural-gas-us').series,['NATGAS_US']);
 assert.equal(registry.find(item=>item.id==='DHHNGSP').frequency,'daily');
 assert.equal(registry.find(item=>item.id==='NATGAS_US').frequency,'monthly');
});

test('Henry Hub daily price has three independently verified EIA history points',()=>{
 const gas=JSON.parse(fs.readFileSync(new URL('./fixtures/natural-gas-samples.json',import.meta.url),'utf8'));
 assert.deepEqual(gas.samples,[{date:'1997-01-07',value:3.82},{date:'2020-10-30',value:3.03},{date:'2026-11-03',value:2.63}]);
 assert.equal(gas.unit,'USD/MMBtu');assert.match(gas.crossCheckUrl,/^https:\/\/www\.eia\.gov\//);
 const group=groups.find(item=>item.id==='natural-gas-daily');
 assert.equal(group.unit,'美元／MMBtu');assert.equal(group.category,2);
 assert.ok(Math.abs(metrics(gas.samples.slice(-2),true).previous-(2.63/3.03-1)*100)<1e-10);
});
