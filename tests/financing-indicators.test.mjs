import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {groups} from '../lib/groups.ts';
import {metrics,parseFredCsv} from '../lib/calculations.mjs';
import {buildResearchPacket} from '../lib/industry/research.mjs';
import {seriesHealth} from '../lib/data-health.mjs';

const registry=JSON.parse(fs.readFileSync(new URL('../lib/indicators.json',import.meta.url),'utf8'));
const samples=JSON.parse(fs.readFileSync(new URL('./fixtures/financing-fred-samples.json',import.meta.url),'utf8'));

test('official financing excerpts retain three verified points per series',()=>{
 for(const id of ['DGS2','DTWEXBGS','T10Y2Y']){
  const sample=samples.series[id],points=parseFredCsv(sample.csv);
  assert.equal(points.length,3);
  assert.deepEqual(points,sample.points);
  assert.equal(sample.sourceUrl,`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
  assert.equal(registry.find(item=>item.id===id)?.frequency,'daily');
 }
});

test('spread samples match underlying yields on the identical observation date',()=>{
 for(const sample of samples.spreadChecks){
  assert.equal(sample.tenYear.date,sample.twoYear.date);
  assert.equal(sample.spread.date,sample.tenYear.date);
  assert.ok(Math.abs(sample.spread.value-(sample.tenYear.value-sample.twoYear.value))<1e-10);
 }
});

test('dollar changes use percent while rates and the curve use percentage points',()=>{
 const dollar=groups.find(group=>group.id==='dollar'),spread=groups.find(group=>group.id==='yield-curve'),twoYear=groups.find(group=>group.id==='yields-2y');
 assert.equal(dollar.changeKind,'percent');assert.equal(spread.unit,'个百分点');assert.equal(twoYear.unit,'%');
 assert.ok(Math.abs(metrics([{date:'a',value:100},{date:'b',value:110}],dollar.changeKind==='percent').previous-10)<1e-10);
 assert.ok(Math.abs(metrics([{date:'a',value:-.2},{date:'b',value:.1}],spread.changeKind==='percent').previous-.3)<1e-10);
});

test('new financing routes resolve without duplicate observer series',()=>{
 for(const id of ['DGS2','T10Y2Y','DTWEXBGS']){
  const matched=groups.filter(group=>group.series.includes(id));
  assert.equal(matched.length,1);assert.equal(matched[0].category,3);
 }
});

test('dollar weekly publication is not mistaken for missing daily observations',()=>{
 const series={status:'ready',observations:[{date:'2026-11-06',value:121.8803}],publication:{state:'waiting_release',nextReleaseAt:'2026-11-16T21:15:00Z'}};
 assert.equal(seriesHealth(series).state,'ready');
 assert.equal(seriesHealth({...series,status:'cached'}).state,'cached');
 assert.equal(seriesHealth({...series,publication:{state:'awaiting_source'}}).state,'awaiting_source');
});

test('supplemental research retains spread point changes across zero',()=>{
 const observations=Array.from({length:21},(_,index)=>({date:`2026-10-${String(index+1).padStart(2,'0')}`,publishedAt:`2026-10-${String(index+1).padStart(2,'0')}`,value:-.2+index*.015}));
 const result=buildResearchPacket({definitions:[],series:{},recommendations:[]},{series:{T10Y2Y:{status:'ready',sourceUrl:'https://fred.stlouisfed.org/series/T10Y2Y',observations}}},registry,{},{},{asOfDate:'2026-10-22'});
 const signal=result.macroSignals.find(item=>item.id==='T10Y2Y');
 assert.equal(signal.role,'supplementary');assert.equal(signal.changeUnit,'百分点');
 assert.ok(Math.abs(signal.change-.3)<1e-10);
});
