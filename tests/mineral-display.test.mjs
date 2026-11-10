import test from 'node:test';
import assert from 'node:assert/strict';
import {mineralRoute,mineralSelectionUrl,mineralNavigation,mineralDisplay} from '../lib/mineral-display.mjs';

const base='https://example.org/monitor/?page=materials&range=1';
const point=(date,value)=>({date,value});
const series=observations=>({status:'ready',observations});

test('the default and bare metal anchors open daily data, independently of a previously saved monthly view',()=>{
 assert.deepEqual(mineralRoute(base),{basis:'market',selected:null,explicit:false});
 assert.deepEqual(mineralRoute(base+'#gold'),{basis:'market',selected:['GOLD'],explicit:true});
 assert.deepEqual(mineralRoute(base+'#nickel'),{basis:'market',selected:['NICKEL'],explicit:true});
 assert.equal(mineralRoute(base+'#%67old').selected[0],'GOLD');
});

test('an explicit frequency wins over incompatible series IDs and monthly-only metals',()=>{
 assert.equal(mineralRoute(base+'&commodityMode=monthly&series=MKT_GOLD#gold').basis,'monthly');
 assert.deepEqual(mineralRoute(base+'&commodityMode=market&series=NICKEL#nickel'),{basis:'market',selected:['NICKEL'],explicit:true});
 assert.equal(mineralRoute(base+'&series=NICKEL').basis,'monthly');
 assert.equal(mineralRoute(base+'&series=MKT_SILVER').basis,'market');
 assert.equal(mineralRoute(base+'&commodityMode=invalid#silver').basis,'market');
});

test('an explicit metal hash wins over older selection parameters; multi-selection is ordered and deduplicated',()=>{
 assert.deepEqual(mineralRoute(base+'&minerals=COPPER,ALUMINUM&series=MKT_COPPER#silver').selected,['SILVER']);
 assert.deepEqual(mineralRoute(base+'&minerals=SILVER,COPPER,SILVER,UNKNOWN#mineral-resources').selected,['COPPER','SILVER']);
 assert.deepEqual(mineralRoute(base+'&minerals=#mineral-resources').selected,[]);
 assert.deepEqual(mineralRoute(base+'#%invalid').selected,null);
});

test('frequency and selection URLs preserve deployment path and unrelated query state',()=>{
 const url=mineralSelectionUrl(base+'&watchlist=mine',{basis:'monthly',selected:['GOLD']});
 const parsed=new URL(url,'https://example.org');
 assert.equal(parsed.pathname,'/monitor/');assert.equal(parsed.searchParams.get('range'),'1');assert.equal(parsed.searchParams.get('watchlist'),'mine');assert.equal(parsed.searchParams.get('series'),'GOLD');assert.equal(parsed.hash,'#gold');
 assert.deepEqual(mineralRoute(url),{basis:'monthly',selected:['GOLD'],explicit:true});
 const empty=mineralSelectionUrl(base,{basis:'market',selected:[]});assert.deepEqual(mineralRoute(empty).selected,[]);
});

test('first implicit selection is recorded so browser Back restores the prior data frequency and metal',()=>{
 const previous={basis:'market',selected:['COPPER']},next={basis:'monthly',selected:['GOLD']};
 const steps=mineralNavigation(base,previous,next);
 assert.deepEqual(steps.map(step=>step.method),['replaceState','pushState']);
 assert.deepEqual(mineralRoute(steps[0].url),{...previous,explicit:true});assert.deepEqual(mineralRoute(steps[1].url),{...next,explicit:true});
 const back=mineralNavigation('https://example.org'+steps[1].url,next,{basis:'market',selected:['GOLD']});assert.equal(back.length,1);assert.equal(back[0].method,'pushState');assert.equal(mineralRoute(back[0].url).basis,'market');
 assert.deepEqual(mineralNavigation('https://example.org'+steps[1].url,next,next),[]);
});

test('single daily series defaults to its original price and preserves a source null as a chart gap',()=>{
 const data={MKT_GOLD:series([point('2026-11-06',4300),point('2026-11-09',null),point('2026-11-10',4350)])};
 const display=mineralDisplay(data,['GOLD'],{range:'all'});
 assert.equal(display.effectiveView,'raw');assert.equal(display.rows[0].s0,4300);assert.equal(display.rows[1].s0,null);assert.equal(display.rows[2].s0,4350);assert.equal(display.rows.length,3);assert.equal(display.entries[0].previous.date,'2026-11-06');assert.equal(display.to,'2026-11-10');
});

test('comparison ends at the last common valid date while single latest dates remain separate',()=>{
 const data={MKT_COPPER:series([point('2026-11-06',5),point('2026-11-09',5.1),point('2026-11-10',5.2)]),MKT_IRON_ORE:series([point('2026-11-06',90),point('2026-11-09',92.71),point('2026-11-10',null)])};
 const display=mineralDisplay(data,['COPPER','IRON_ORE'],{range:'all',view:'raw'});
 assert.equal(display.effectiveView,'normalized');assert.equal(display.common,true);assert.equal(display.to,'2026-11-09');assert.equal(display.latestTo,'2026-11-10');assert.equal(display.latestFrom,'2026-11-09');
 assert.equal(display.rows[0].s0,100);assert.equal(display.rows[0].s1,100);assert.equal(display.entries[1].latest.value,92.71);assert.equal(display.entries[1].lastObservation.value,null);assert.ok(Math.abs(display.rows[1].s1-92.71/90*100)<1e-10);
});

test('monthly-only and missing daily feeds never borrow monthly values or drop a selected comparison member',()=>{
 const data={NICKEL:series([point('2026-10-01',15000)]),GOLD:series([point('2026-10-01',4000)]),MKT_COPPER:series([point('2026-11-10',5)])};
 const nickel=mineralDisplay(data,['NICKEL']);assert.equal(nickel.emptyReason,'monthly_only');assert.equal(nickel.entries[0].latest,null);assert.deepEqual(nickel.rows,[]);
 const missing=mineralDisplay(data,['COPPER','GOLD']);assert.equal(missing.emptyReason,'unavailable');assert.deepEqual(missing.rows,[]);assert.equal(missing.entries.length,2);assert.equal(missing.entries[1].latest,null);
 assert.equal(mineralDisplay(data,['NICKEL'],{basis:'monthly'}).entries[0].latest.value,15000);
});

test('different observation calendars do not create interpolated comparison points',()=>{
 const display=mineralDisplay({MKT_GOLD:series([point('2026-11-09',4300)]),MKT_SILVER:series([point('2026-11-10',50)])},['GOLD','SILVER']);
 assert.equal(display.emptyReason,'no_common_dates');assert.deepEqual(display.rows,[]);assert.equal(display.latestFrom,'2026-11-09');assert.equal(display.latestTo,'2026-11-10');
});

test('normalization uses the requested window base, not an invalid distant historical base',()=>{
 const data={MKT_GOLD:series([point('2024-01-01',0),point('2025-11-10',100),point('2026-11-09',150)])};
 const display=mineralDisplay(data,['GOLD'],{range:'1',view:'normalized'});
 assert.equal(display.from,'2025-11-10');assert.deepEqual(display.rows.map(row=>row.s0),[100,150]);
 assert.equal(mineralDisplay(data,['GOLD'],{range:'all',view:'normalized'}).emptyReason,'nonpositive_base');
});

test('zero and negative actual prices remain values; percentage change and normalization reject invalid bases',()=>{
 const zero=mineralDisplay({MKT_GOLD:series([point('2026-11-09',0),point('2026-11-10',5)])},['GOLD']);assert.equal(zero.rows[0].s0,0);assert.equal(zero.entries[0].change,null);
 const negative=mineralDisplay({MKT_GOLD:series([point('2026-11-09',-1),point('2026-11-10',5)])},['GOLD']);assert.equal(negative.rows[0].s0,-1);assert.equal(negative.entries[0].change,null);
 assert.equal(mineralDisplay({MKT_GOLD:series([point('2026-11-09',-1),point('2026-11-10',5)])},['GOLD'],{view:'normalized'}).emptyReason,'nonpositive_base');
});

test('empty and invalid values stay unavailable, never turn into fabricated zeros',()=>{
 assert.equal(mineralDisplay({},[]).emptyReason,'no_selection');
 const display=mineralDisplay({MKT_GOLD:series([point('2026-11-10',Number.NaN)])},['GOLD']);assert.equal(display.emptyReason,'unavailable');assert.equal(display.entries[0].latest,null);assert.equal(display.entries[0].points[0].value,null);
});
