import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateObserverAlerts,normalizeAlertRule,alertRuleDescription,parseAlertStorage,serializeAlertStorage} from '../lib/observer-alerts.mjs';

const point=(date,value)=>({date,value});
const rule=(kind='above',threshold=4)=>({id:'rule-1',itemId:'macro:DGS10',kind,threshold,enabled:true,createdAt:'2026-11-10T00:00:00Z'});
const item=(points,extra={})=>({id:'macro:DGS10',title:'十年期名义收益率',href:'/?page=financing#yields',sourceUrl:'https://fred.stlouisfed.org/series/DGS10',unit:'%',period:[...points].sort((a,b)=>a.date.localeCompare(b.date)).at(-1)?.date,status:'已获取',warning:false,points,...extra});
const run=(r,points,state={},extra={})=>evaluateObserverAlerts([r],[item(points,extra)],state,'2026-11-10T02:00:00Z');
const three=[point('2026-08-01',3),point('2026-09-01',3.5),point('2026-10-01',4)];

test('threshold boundary, zero and negative observations retain their meanings',()=>{
 assert.equal(run(rule('above',4),three).results[0].state,'unmatched');
 assert.equal(run(rule('below',0),[point('2026-10-01',-.5)]).results[0].state,'matched');
 assert.equal(run(rule('above',-1),[point('2026-10-01',0)]).results[0].value,0);
});
test('absolute changes in rates use percentage points, with float boundary tolerance',()=>{
 const result=run(rule('change_up',.2),[point('2026-09-01',4),point('2026-10-01',4.2)]);
 assert.equal(result.results[0].state,'matched');
 assert.match(result.results[0].reason,/0.2个百分点/);
 assert.match(alertRuleDescription(rule('change_down',20),{unit:'美元／公吨'}),/20美元／公吨/);
 assert.equal(run(rule('change_down',.5),[point('2026-09-01',4),point('2026-10-01',3.5)]).results[0].state,'matched');
 assert.equal(run(rule('change_up',0),[point('2026-09-01',4),point('2026-10-01',4)]).results[0].state,'unmatched');
});
test('sort observations without mutating input and never skip explicit missing points',()=>{
 const input=[point('2026-10-01',4),point('2026-08-01',3),point('2026-09-01',null)];
 const snapshot=JSON.stringify(input);
 assert.equal(run(rule('change_up',.5),input).results[0].state,'unavailable');
 assert.equal(run(rule('above',3),input).results[0].state,'matched');
 assert.equal(JSON.stringify(input),snapshot);
 assert.equal(run(rule('above',3),[...three,point('2026-11-01',null)]).results[0].state,'unavailable');
});
test('monthly, quarterly and weekly missing periods cannot masquerade as consecutive changes',()=>{
 const missing=[point('2026-07-01',2),point('2026-09-01',3),point('2026-10-01',4)];
 assert.equal(run(rule('consecutive_up',2),missing,{}, {frequency:'monthly'}).results[0].state,'unavailable');
 assert.equal(run(rule('consecutive_up',2),[point('2026-03-31',2),point('2026-06-30',3),point('2026-09-30',4)],{},{frequency:'quarterly'}).results[0].state,'matched');
 assert.equal(run(rule('change_up',.5),[point('2026-10-01',3),point('2026-10-15',4)],{},{frequency:'weekly'}).results[0].state,'unavailable');
 // Daily sources include non-trading days; adjacent published observations remain valid.
 assert.equal(run(rule('change_up',.5),[point('2026-11-06',3),point('2026-11-09',4)],{},{frequency:'daily'}).results[0].state,'matched');
});
test('consecutive threshold means successive changes and equality interrupts the run',()=>{
 assert.equal(run(rule('consecutive_up',2),three).results[0].state,'matched');
 assert.equal(run(rule('consecutive_up',3),three).results[0].state,'unavailable');
 assert.equal(run(rule('consecutive_up',2),[point('2026-08-01',3),point('2026-09-01',3),point('2026-10-01',4)]).results[0].state,'unmatched');
 assert.equal(run(rule('consecutive_down',2),[point('2026-08-01',4),point('2026-09-01',3),point('2026-10-01',2)]).results[0].state,'matched');
});
test('unhealthy and unconfigured source states never trigger',()=>{
 for(const status of ['使用缓存','获取失败 · 保留缓存','等待来源发布','来源未配置','已获取 · 最新期缺值','ready warning','日频收盘 · 估值字段待核验','not_configured','pending']){
  assert.equal(run(rule('above',3),three,{}, {status}).results[0].state,'unavailable',status);
 }
 assert.equal(run(rule('above',3),three,{}, {warning:true,alertEligible:true}).events.length,0);
 assert.equal(run(rule('above',3),three,{}, {alertEligible:false,alertReason:'口径待确认'}).results[0].reason,'口径待确认');
 assert.equal(run(rule('above',3),three,{}, {alertEligible:true,status:'官方新标签'}).events.length,1);
});
test('new observation establishes baseline; fetch time changes do not produce alerts',()=>{
 const r=rule('new_observation',0),first=run(r,three);
 assert.equal(first.events.length,0);assert.match(first.results[0].reason,/已记录/);
 const refetch=run(r,three,first.nextState,{checkedAt:'2026-11-11T03:00:00Z',sourceVersion:'new-fetch-version'});
 assert.equal(refetch.events.length,0);
 const updated=run(r,[...three,point('2026-11-01',4.1)],refetch.nextState);
 assert.equal(updated.events.length,1);assert.equal(updated.events[0].date,'2026-11-01');
 assert.equal(run(r,[...three,point('2026-11-01',4.1)],updated.nextState).events.length,0);
});
test('history backfill and revision are distinct from a newly published period',()=>{
 const r=rule('new_observation',0),baseline=run(r,three);
 assert.equal(run(r,[point('2026-07-01',2),...three],baseline.nextState).events.length,0);
 assert.equal(run(r,[...three.slice(0,-1),point('2026-10-01',5)],baseline.nextState).events.length,0);
});
test('failure or missing latest value preserves the successful baseline for recovery',()=>{
 const r=rule('new_observation',0),baseline=run(r,three),points=[...three,point('2026-11-01',4.1)];
 const failed=run(r,points,baseline.nextState,{status:'cached',warning:true});
 assert.deepEqual(failed.nextState,baseline.nextState);assert.equal(failed.events.length,0);
 const missing=run(r,[...three,point('2026-11-01',null)],failed.nextState);
 assert.deepEqual(missing.nextState,baseline.nextState);
 assert.equal(run(r,points,missing.nextState).events.length,1);
});
test('a reverted source snapshot cannot move new observation baseline backward',()=>{
 const r=rule('new_observation',0),baseline=run(r,three),reverted=run(r,three.slice(0,-1),baseline.nextState);
 assert.equal(reverted.nextState[r.id].date,'2026-10-01');
 assert.equal(reverted.results[0].state,'unavailable');
 assert.equal(run(r,three,reverted.nextState).events.length,0);
 const thresholdRule=rule('above',3),thresholdBaseline=run(thresholdRule,three);
 assert.equal(run(thresholdRule,[point('2026-09-01',3.8)],thresholdBaseline.nextState).events.length,0);
});
test('repeated threshold polls dedupe, revised values are re-evaluated, old revisions stay deduped',()=>{
 const r=rule('above',3),first=run(r,three);
 assert.equal(first.events.length,1);
 const repeat=run(r,three,first.nextState,{sourceVersion:'poll-2',checkedAt:'2026-11-11'});
 assert.equal(repeat.results[0].state,'matched');assert.equal(repeat.results[0].newMatch,false);assert.equal(repeat.events.length,0);
 const revision=run(r,[...three.slice(0,-1),point('2026-10-01',4.1)],repeat.nextState);
 assert.equal(revision.events.length,1);
 assert.equal(run(r,three,revision.nextState).events.length,0);
});
test('rule edits reset its comparison identity while pausing preserves its baseline',()=>{
 const r=rule('new_observation',0),baseline=run(r,three),paused=run({...r,enabled:false},three,baseline.nextState);
 assert.equal(paused.results[0].state,'disabled');assert.deepEqual(paused.nextState,baseline.nextState);
 const changed=run({...r,kind:'above',threshold:3},three,baseline.nextState);
 assert.equal(changed.events.length,1);
});
test('contradictory duplicate periods and invalid dates are not silently accepted',()=>{
 assert.equal(run(rule('above',3),[...three,point('2026-10-01',5)]).results[0].state,'unavailable');
 assert.equal(run(rule('above',3),[point('2026-02-30',5)]).results[0].state,'unavailable');
 assert.equal(run(rule('above',3),[...three,point('2026-10-01',4)]).events.length,1);
});
test('the alert observation must match the date displayed in the indicator headline',()=>{
 const r=rule('above',3),baseline=run(r,three);
 for(const period of ['2026-11-01','2026-11-01T08:00:00Z','2026-09-01']){
  const result=run(r,three,baseline.nextState,{period});
  assert.equal(result.results[0].state,'unavailable');assert.equal(result.events.length,0);assert.deepEqual(result.nextState,baseline.nextState);
 }
 assert.equal(run(r,three,{}, {period:'2026-10-01T08:00:00Z'}).events.length,1);
});
test('rules validate finite values, bounded trend lengths and unsafe object keys',()=>{
 for(const value of [{...rule(),threshold:Infinity},{...rule(),id:'__proto__'},{...rule('consecutive_up',2.5)},{...rule('consecutive_down',25)},{...rule('change_up',-1)},{...rule(),createdAt:'unknown'}])assert.equal(normalizeAlertRule(value),null);
 assert.equal(normalizeAlertRule(rule('below',-1)).threshold,-1);
});
test('storage roundtrips dedupe state and trigger history without mutating them',()=>{
 const r=rule('above',3),evaluation=run(r,three),e=evaluation.events[0];
 const history=[{id:e.fingerprint,ruleId:e.ruleId,itemId:e.itemId,title:e.title,description:e.reason,date:e.date,value:e.value,unit:e.unit,triggeredAt:e.triggeredAt,read:false,href:e.href,sourceUrl:e.sourceUrl}];
 const parsed=parseAlertStorage(serializeAlertStorage([r],evaluation.nextState,history));
 assert.equal(parsed.status,'ready');assert.deepEqual(parsed.rules,[r]);assert.deepEqual(parsed.history,history);
 assert.equal(run(r,three,parsed.state).events.length,0);
 assert.deepEqual(parseAlertStorage(JSON.stringify({version:1,rules:[r],state:{}})).history,[]);
});
test('corrupt storage is explicit and cannot be overwritten by an invalid serialization',()=>{
 assert.equal(parseAlertStorage(null).status,'empty');
 for(const raw of ['{broken','[]','{"version":2}',JSON.stringify({version:1,rules:[rule(),rule()],state:{}}),JSON.stringify({version:1,rules:[rule()],state:{a:{date:'bad'}}})])assert.equal(parseAlertStorage(raw).status,'corrupt');
 assert.throws(()=>serializeAlertStorage([{...rule(),threshold:NaN}],{}),/未保存/);
});
test('stored history cannot inject javascript or protocol-relative navigation',()=>{
 const base={id:'event-1',ruleId:'rule-1',itemId:'macro:DGS10',title:'收益率',description:'已触发',date:'2026-10-01',value:4,unit:'%',triggeredAt:'2026-11-10T02:00:00Z',read:false,href:'/?page=financing'};
 for(const href of ['javascript:alert(1)','//bad.example/path','data:text/html,hi','/\\evil.com','/\n/evil.com','\thttps://evil.com','https://evil.com','/?a=\u0000'])assert.throws(()=>serializeAlertStorage([rule()],{},[{...base,href}]),/未保存/);
 for(const sourceUrl of ['/?page=overview','//bad.example/path','https://user:secret@source.example','https://fred.stlouisfed.org\n.evil.com','http://','https://\\evil.com'])assert.throws(()=>serializeAlertStorage([rule()],{},[{...base,sourceUrl}]),/未保存/);
 assert.equal(parseAlertStorage(serializeAlertStorage([rule()],{},[base])).status,'ready');
 assert.equal(parseAlertStorage(serializeAlertStorage([rule()],{},[{...base,href:'?page=financing',sourceUrl:'https://fred.stlouisfed.org/series/DGS10'}])).status,'ready');
});
