import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRegionalEnergy,regionalChartRows,regionalCsv,regionalDate,regionalNavigation,regionalRanges,regionalSourceUrl,regionalStats,regionalStatus,regionalWindow} from '../lib/regional-energy.mjs';

// Synthetic fixtures exercise display contracts; none is published as source data.
const hourly={id:'TEST_DEMAND',name:'测试负荷',kind:'load',unit:'MW',frequency:'hourly',timeZone:'America/New_York',sourceName:'Test official source',sourceUrl:'https://www.eia.gov/electricity/gridmonitor/',exportAllowed:true,status:'available',observations:[{date:'2026-11-01T05:00:00Z',value:100},{date:'2026-11-01T06:00:00Z',value:120},{date:'2026-11-01T08:00:00Z',value:150}]};
const daily={...hourly,id:'TEST_PRICE',name:'测试价格',kind:'wholesale_price',unit:'美元/MWh',frequency:'daily',exportAllowed:false,observations:[{date:'2026-10-26',value:40},{date:'2026-10-27',value:-5},{date:'2026-10-28',value:0}]};
const payload=series=>({schemaVersion:1,regions:[{id:'pjm',name:'PJM',timeZone:'America/New_York',series}]});

test('parser keeps source units, zeros, negative prices and missing observations',()=>{
 const result=parseRegionalEnergy(payload([{...daily,observations:[...daily.observations,{date:'2026-10-29',value:null}]}]));
 assert.deepEqual(result.regions[0].series[0].observations.map(row=>row.value),[40,-5,0,null]);
 assert.equal(result.regions[0].series[0].unit,'美元/MWh');
 assert.equal(result.regions[0].series[0].exportAllowed,false);
});

test('parser rejects invalid numeric values, local unzoned hours and duplicate UTC instants',()=>{
 for(const observations of [[{date:'2026-11-01T05:00:00Z',value:'123'}],[{date:'2026-11-01T05:00:00',value:123}],[{date:'2026-11-01T05:00:00Z',value:Infinity}],[{date:'2026-11-01T05:00:00Z',value:10},{date:'2026-11-01T01:00:00-04:00',value:10}]])assert.throws(()=>parseRegionalEnergy(payload([{...hourly,observations}])));
 assert.throws(()=>parseRegionalEnergy(payload([{...daily,observations:[{date:'2026-02-30',value:3}]}])));
});

test('DST repeated local hour remains distinguishable and is displayed correctly in Beijing',()=>{
 const series=parseRegionalEnergy(payload([hourly])).regions[0].series[0];
 assert.notEqual(regionalDate(series.observations[0].date,'hourly',series.timeZone),regionalDate(series.observations[1].date,'hourly',series.timeZone));
 assert.match(regionalDate(series.observations[0].date,'hourly','Asia/Shanghai'),/13:00/);
 assert.match(regionalDate(series.observations[1].date,'hourly','Asia/Shanghai'),/14:00/);
 assert.equal(regionalDate('2026-10-27','daily','Asia/Shanghai'),'2026-10-27');
});

test('source failure, cache, unpublished and unconfigured stay separate',()=>{
 assert.equal(regionalStatus(hourly).status,'available');
 assert.equal(regionalStatus({...hourly,status:'cached',lastFetchStatus:'fetch_failed'}).label,'使用缓存');
 assert.match(regionalStatus({...hourly,status:'cached',lastFetchStatus:'fetch_failed'}).detail,/来源检查失败/);
 assert.equal(regionalStatus(hourly,true).status,'cached');
 assert.equal(regionalStatus({...hourly,observations:[]},true).status,'fetch_failed');
 assert.equal(regionalStatus({...hourly,status:'not_published',observations:[]}).label,'尚未发布');
 assert.equal(regionalStatus({...hourly,freshness:'delayed'}).label,'来源观测滞后');
 assert.equal(regionalStatus({...hourly,freshness:'delayed'}).status,'delayed');
 assert.equal(regionalStatus({...hourly,freshness:'delayed'}).warning,true);
 assert.equal(regionalStatus(undefined).status,'not_configured');
});

test('ranges expose actual available history and 24-hour selection includes exactly 24 hourly points',()=>{
 const observations=Array.from({length:169},(_,index)=>({date:new Date(Date.UTC(2026,10,1)+index*3600000).toISOString(),value:index}));
 const series={...hourly,observations};
 assert.equal(regionalWindow(series,'1').length,24);
 assert.equal(regionalWindow(series,'7').length,168);
 assert.equal(regionalWindow(series,'all').length,169);
 assert.equal(regionalRanges(series).find(row=>row.value==='7').available,true);
 assert.equal(regionalRanges(series).find(row=>row.value==='30').available,false);
 assert.equal(regionalRanges(daily).find(row=>row.value==='30').available,false);
});

test('missing hour creates a null separator without manufacturing an exported observation',()=>{
 const rows=regionalChartRows(hourly.observations,'hourly');
 assert.equal(rows.length,4);
 assert.deepEqual(rows[2],{date:'2026-11-01T07:00:00.000Z',value:null,gap:true});
 const csv=regionalCsv(hourly,rows);
 assert.ok(!csv.includes('2026-11-01T07:00:00.000Z'));
 assert.match(csv,/2026-11-01T08:00:00Z/);
 assert.equal(regionalStats(hourly.observations,'hourly').previousChange,null);
});

test('change calculations keep negative prices absolute and stop when latest period is missing',()=>{
 assert.equal(regionalStats(daily.observations,'daily').previousChange,5);
 assert.equal(regionalStats(daily.observations,'daily').rangeChange,-40);
 const stats=regionalStats([...daily.observations,{date:'2026-10-29',value:null}],'daily');
 assert.equal(stats.last.value,0);
 assert.equal(stats.latestMissing,true);
 assert.equal(stats.previousChange,null);
});

test('export requires permission and preserves source provenance and null gaps',()=>{
 assert.throws(()=>regionalCsv(daily,daily.observations),/尚未开放/);
 const csv=regionalCsv({...hourly,fetchedAt:'2026-11-02T12:00:00Z',version:'test-v1'},[{date:'2026-11-01T05:00:00Z',value:null}]);
 assert.match(csv,/UTC/);assert.match(csv,/test-v1/);assert.match(csv,/2026-11-02T12:00:00Z/);
 assert.match(csv,/"2026-11-01T05:00:00Z","","UTC"/);
});

test('source links reject script and credential-bearing URLs',()=>{
 assert.equal(regionalSourceUrl('javascript:alert(1)'),null);
 assert.equal(regionalSourceUrl('https://user:secret@example.com/'),null);
 assert.equal(regionalSourceUrl('https://www.eia.gov/'),'https://www.eia.gov/');
 const result=parseRegionalEnergy(payload([{...hourly,sourceUrl:'javascript:alert(1)'}]));
 assert.equal(result.regions[0].series[0].sourceUrl,null);
});

test('saved chart links select the owning region even when the previous region differs',()=>{
 const data={regions:[{id:'ercot',series:[{id:'ERCO_D'}]},{id:'pjm',series:[{id:'PJM_D'}]}]};
 assert.deepEqual(regionalNavigation(data,'?page=materials&region=ercot','#PJM_D'),{regionId:'pjm',seriesId:'PJM_D'});
 assert.deepEqual(regionalNavigation(data,'?page=materials&region=pjm','#regional-energy'),{regionId:'pjm',seriesId:null});
 assert.equal(regionalNavigation(data,'?page=overview&region=pjm','#PJM_D'),null);
 assert.equal(regionalNavigation(data,'?page=materials&region=unknown','#brent'),null);
});

test('regional query cannot override another energy panel hash, and encoded leaf links still win',()=>{
 const data={regions:[{id:'ercot',series:[{id:'EIA_ERCO_DEMAND'}]},{id:'pjm',series:[{id:'EIA_PJM_DEMAND'}]}]};
 assert.equal(regionalNavigation(data,'?page=materials&region=pjm','#brent'),null);
 assert.equal(regionalNavigation(data,'?page=materials&region=pjm','#electricity-us'),null);
 assert.equal(regionalNavigation(data,'?page=materials&region=pjm','#natural-gas-daily'),null);
 assert.deepEqual(regionalNavigation(data,'?page=materials&region=pjm',''),{regionId:'pjm',seriesId:null});
 assert.deepEqual(regionalNavigation(data,'?page=materials&region=ercot&series=EIA_ERCO_DEMAND','#%45IA_PJM_DEMAND'),{regionId:'pjm',seriesId:'EIA_PJM_DEMAND'});
 assert.equal(regionalNavigation(data,'?page=materials&region=pjm','#%bad'),null);
});
