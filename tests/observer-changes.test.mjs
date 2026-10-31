import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVisitSnapshot,compareVisitSnapshots,mergeVisitBaseline,validVisitSnapshot} from '../lib/observer-changes.mjs';
const input=(observations,status='ready')=>({macro:{generatedAt:'2026-10-31',series:{A:{observations,status,fetchedAt:'2026-10-31'}}}});
const point=(date,value)=>({date,value});
test('first visit is a baseline; a successful re-fetch is not a data change',()=>{
 const before=buildVisitSnapshot(input([point('2026-08-01',3)]));
 const after=buildVisitSnapshot(input([point('2026-08-01',3)]),[],'2026-11-01');
 assert.equal(compareVisitSnapshots(null,before).length,0);assert.equal(compareVisitSnapshots(before,after).length,0);
});
test('new periods, revisions, nulls and source recovery retain separate meanings',()=>{
 const before=buildVisitSnapshot(input([point('2026-08-01',3),point('2026-09-01',null)],'cached'));
 const after=buildVisitSnapshot(input([point('2026-08-01',2.9),point('2026-09-01',0),point('2026-10-01',3.1)]));
 const events=compareVisitSnapshots(before,after);
 assert.deepEqual(events.map(e=>e.kind).sort(),['new','recovery','revision','revision']);
 assert.equal(events.find(e=>e.kind==='new').count,1);
});
test('waiting for a scheduled monthly release is not failure',()=>{
 const before=buildVisitSnapshot(input([point('2026-09-01',3)]));
 const after=buildVisitSnapshot(input([point('2026-09-01',3)],'awaiting_release'));
 assert.equal(compareVisitSnapshots(before,after).length,0);
});
test('unavailable module cannot erase its stored baseline',()=>{
 const before=buildVisitSnapshot(input([point('2026-09-01',3)]));
 const partial=buildVisitSnapshot({macro:{generatedAt:'',series:{}}});
 assert.equal(compareVisitSnapshots(before,partial).length,0);
 assert.deepEqual(mergeVisitBaseline(before,partial).records,before.records);
 assert.equal(validVisitSnapshot({version:1,observedAt:'bad',records:[],scopes:[]}),false);
});
test('decision range changes with equal midpoint are visible',()=>{
 const make=(lower,upper)=>buildVisitSnapshot({policyDecisions:{generatedAt:'2026-10-31',status:'ready',decisions:[{bankId:'fed',bank:'Fed',announcementDate:'2026-10-01',lower,upper,midpoint:4}]}});
 assert.equal(compareVisitSnapshots(make(3.5,4.5),make(3.75,4.25))[0].kind,'revision');
});
test('a module loaded later is not reported as entirely new history',()=>{
 const early=buildVisitSnapshot({policyRates:{generatedAt:'2026-10-31',series:[]}});
 const later=buildVisitSnapshot(input([point('2026-09-01',3)]));
 assert.equal(compareVisitSnapshots(early,later).length,0);
 assert.deepEqual(mergeVisitBaseline(early,later).scopes.sort(),['macro','policy']);
});
