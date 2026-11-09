import test from 'node:test';
import assert from 'node:assert/strict';
import {chartRows} from '../lib/industry/engine.mjs';
import {industryChartSelection,eventsInIndustrySelection,industrySelectionCsv} from '../lib/industry/chart-selection.mjs';

const def={id:'TEST.revenue',unit:'亿美元',frequency:'monthly',aggregation:'sum',valueType:'reported'};
const point=(periodEnd,value)=>({periodEnd,value,version:'v-'+periodEnd,sourceUrl:'https://example.com/report',fetchedAt:'2026-10-01T00:00:00Z'});

test('brush window, statistics, event dates and CSV use the same inclusive selected rows',()=>{
 const rows=[point('2026-01-31',10),point('2026-02-28',20),point('2026-03-31',null),point('2026-04-30',30),point('2026-05-31',100)];
 const selection=industryChartSelection(rows,{startIndex:1,endIndex:3},{unit:def.unit});
 assert.deepEqual(selection.visibleRows,rows.slice(1,4));
 assert.equal(selection.change,50);assert.equal(selection.changeUnit,'%');assert.equal(selection.zoomed,true);
 const events=[{date:'2026-01-31'},{date:'2026-02-28'},{date:'2026-03-12'},{date:'2026-04-30'},{date:'2026-05-01'}];
 assert.deepEqual(eventsInIndustrySelection(events,selection.visibleRows),events.slice(1,4));
 const csv=industrySelectionCsv(def,selection.visibleRows);
 const lines=csv.split('\r\n');assert.equal(lines.length,4);
 assert.ok(lines[1].includes('"2026-02-28"'));assert.ok(lines[3].includes('"2026-04-30"'));
 assert.ok(lines[2].includes('"2026-03-31","","","亿美元"'),'missing observation exports an empty value');
 assert.ok(!csv.includes('2026-01-31'));assert.ok(!csv.includes('2026-05-31'));
});

test('quarterly aggregation compares and exports the displayed totals rather than final monthly observations',()=>{
 const observations=[point('2026-01-31',10),point('2026-02-28',20),point('2026-03-31',30),point('2026-04-30',20),point('2026-05-31',30),point('2026-06-30',70)];
 const rows=chartRows(def,observations,{range:'all',frequency:'quarterly'});
 const selection=industryChartSelection(rows,null,{unit:def.unit});
 assert.equal(selection.first.value,60);assert.equal(selection.last.value,120);assert.equal(selection.change,100);
 const csv=industrySelectionCsv(def,selection.visibleRows,{frequency:'quarterly'});
 assert.ok(csv.includes('"60","亿美元","value","quarterly"'));
 assert.ok(csv.includes('"120","亿美元","value","quarterly"'));
 assert.ok(csv.includes('quarterly: sum of 3 complete monthly observations'));
});

test('growth-rate and margin series show interval differences in percentage points',()=>{
 const rows=[point('2025-03-31',10),point('2025-06-30',30)];
 for(const mode of ['yoy','qoq']){
  const selected=industryChartSelection(rows,null,{unit:def.unit,mode});
  assert.equal(selected.change,20);assert.equal(selected.changeUnit,'个百分点');
  assert.ok(industrySelectionCsv(def,rows,{mode}).includes('"10","%","'+mode+'"'));
 }
 const margin=industryChartSelection([point('2025-03-31',-5),point('2025-06-30',10)],null,{unit:'%'});
 assert.equal(margin.change,15);assert.equal(margin.changeUnit,'个百分点');
});

test('year-on-year displayed growth uses source calculation and CSV preserves its base audit fields',()=>{
 const quarterly={...def,frequency:'quarterly'};
 const rows=chartRows(quarterly,[point('2025-03-31',100),point('2025-06-30',200),point('2026-03-31',110),point('2026-06-30',260)],{range:'all',mode:'yoy'});
 const selection=industryChartSelection(rows,{startIndex:rows.length-2,endIndex:rows.length-1},{unit:def.unit,mode:'yoy'});
 assert.ok(Math.abs(selection.change-20)<1e-10);assert.equal(selection.changeUnit,'个百分点');
 const csv=industrySelectionCsv(quarterly,selection.visibleRows,{mode:'yoy'});
 assert.ok(csv.includes('displayBasePeriod'));assert.ok(csv.includes('v-2025-06-30'));
 assert.ok(csv.includes('(current / base - 1) * 100'));
});

test('missing, one-point, zero-base and negative-base windows never invent an interval return',()=>{
 for(const rows of [[],[point('2026-01-31',null)],[point('2026-01-31',10)],[point('2026-01-31',0),point('2026-02-28',10)],[point('2026-01-31',-10),point('2026-02-28',10)]]){
  assert.equal(industryChartSelection(rows,null,{unit:def.unit}).change,null);
 }
 const points=[point('2026-01-31',null),point('2026-02-28',10),point('2026-03-31',20),point('2026-04-30',null)];
 const selected=industryChartSelection(points,null,{unit:def.unit});
 assert.equal(selected.first.periodEnd,'2026-02-28');assert.equal(selected.last.periodEnd,'2026-03-31');assert.equal(selected.change,100);
 assert.equal(selected.visibleRows[0].value,null);assert.equal(selected.visibleRows.at(-1).value,null);
});

test('reset restores the original rows identity and bounds; out-of-range indices stay safe',()=>{
 const rows=[point('2026-01-31',10),point('2026-02-28',20),point('2026-03-31',30)];
 const full=industryChartSelection(rows,null,{unit:def.unit});
 assert.strictEqual(full.visibleRows,rows);assert.equal(full.startIndex,0);assert.equal(full.endIndex,2);assert.equal(full.zoomed,false);
 assert.strictEqual(industryChartSelection(rows,{startIndex:0,endIndex:2},{unit:def.unit}).visibleRows,rows);
 const shrunk=industryChartSelection(rows,{startIndex:9,endIndex:10},{unit:def.unit});
 assert.equal(shrunk.visibleRows.length,1);assert.equal(shrunk.change,null);
 assert.deepEqual(eventsInIndustrySelection([{date:'2026-01-01'}],[]),[]);
});

test('CSV preserves the cited source while carrying the verified current document location and version',()=>{
 const cited='https://example.com/previous-report';
 const resolved='https://example.com/investor/2026/report.pdf';
 const migrated={...point('2026-06-30',120),sourceUrl:cited,resolvedSourceUrl:resolved,sourceDocumentVersion:'document-sha256-v2'};
 const [header,row,legacy]=industrySelectionCsv(def,[migrated,point('2026-07-31',125)]).split('\r\n');
 assert.ok(header.endsWith('"resolved_source","source_document_version"'));
 assert.equal(row.split(',')[9],'"'+cited+'"','source column keeps the original citation');
 assert.ok(row.endsWith('"'+resolved+'","document-sha256-v2"'));
 assert.ok(legacy.endsWith(',"",""'),'older observations keep absent resolution metadata empty');
 const transformed=chartRows(def,[migrated,point('2026-07-31',125)],{range:'all',mode:'qoq'});
 assert.equal(transformed[0].resolvedSourceUrl,resolved);
 assert.equal(transformed[0].sourceDocumentVersion,'document-sha256-v2');
});
