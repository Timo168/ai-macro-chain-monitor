import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResearchWatchlist,filterResearchWatchlist} from '../lib/industry/research-watchlist.mjs';
import {normalizeWatchPreferences} from '../lib/industry/watchlist-preferences.mjs';
const signal=(score=50)=>({targetId:'cloud',targetName:'云平台',tier:'formal',score,stance:'gradual_attention',factors:[],macroScore:0,factorModelVersion:'v1'});
const record=(id,date,s)=>({id,recordId:id,recordedAt:date,inputHash:id,signals:[s],metrics:[]});
test('watchlist focuses on real changes, skips future and does not move event dates on refresh',()=>{
 const ledger=[record('a','2026-10-01',signal()),record('b','2026-10-02',signal(65)),record('c','2027-01-01',signal(0))];
 const a=buildResearchWatchlist({ledger},{asOf:'2026-10-05'}),b=buildResearchWatchlist({ledger},{asOf:'2026-10-06'});
 assert.equal(a.events.length,1);assert.equal(a.events[0].date,'2026-10-02');assert.deepEqual(a.events,b.events);
 assert.equal(buildResearchWatchlist({ledger:ledger.slice(0,1)},{asOf:'2026-10-05'}).events.length,0);
});
test('loss of formal eligibility is surfaced before ordinary data changes',()=>{
 const old=signal(),next={...signal(),tier:'unavailable',score:null,stance:'insufficient_data'};
 const result=buildResearchWatchlist({ledger:[record('a','2026-10-01',old),record('b','2026-10-02',next)]},{asOf:'2026-10-05'});
 assert.equal(result.events[0].kind,'invalidated');assert.equal(result.events[0].priority,3);
});
test('watch preference filtering supports empty selection, company-only and read state',()=>{
 const rows=[{id:'x',targetIds:['cloud'],entities:['EXAMPLE']},{id:'y',targetIds:['power'],entities:[]}];
 assert.equal(filterResearchWatchlist(rows,{}).length,0);
 assert.deepEqual(filterResearchWatchlist(rows,{entities:['EXAMPLE'],readIds:['x']}).map(x=>x.read),[true]);
 assert.equal(filterResearchWatchlist(rows,{entities:['EXAMPLE'],readIds:['x'],unreadOnly:true}).length,0);
 assert.deepEqual(normalizeWatchPreferences({targetIds:[],readIds:[1,'x','x']},['cloud']),{targetIds:[],entities:[],readIds:['x']});
});
test('insufficient history cannot manufacture a valuation percentile reminder',()=>{
 const valuation={companies:[{entity:'EXAMPLE',history:{status:'insufficient_history',metrics:{pe:{percentile:95}}}}]};
 assert.equal(buildResearchWatchlist({valuation},{asOf:'2026-10-05'}).events.length,0);
});
