import test from 'node:test';
import assert from 'node:assert/strict';
import {callReasoning,modelSettings,usageRecord,citationAudit,callPermission} from '../lib/industry/model-runtime.mjs';
const settings=modelSettings({}),reference={metricId:'X',periodEnd:'2026-06-30',observationVersion:'v1'};
const packet={quantitative:{sectorSignals:[{targetId:'cloud',evidenceRefs:[reference]}]},contextRefs:[]};
test('empty GitHub variables retain defaults and invalid settings fail',()=>{
 assert.deepEqual(modelSettings({REASONING_MAX_DAILY_CALLS:'',REASONING_EFFORT:''}),settings);
 assert.throws(()=>modelSettings({REASONING_MAX_DAILY_CALLS:'0'}));assert.throws(()=>modelSettings({REASONING_EFFORT:'none'}));
});
test('usage counts cached input separately and reasoning once inside output',()=>{
 const u=usageRecord({model:'gpt-5-mini-2025-08-07',usage:{input_tokens:1000,output_tokens:2000,input_tokens_details:{cached_tokens:500},output_tokens_details:{reasoning_tokens:1500}}},'gpt-5-mini');
 assert.equal(u.totalTokens,3000);assert.equal(u.estimatedCostUsd,.0041375);assert.equal(u.reasoningTokens,1500);
 assert.equal(usageRecord({model:'another-model',usage:{input_tokens:1,output_tokens:2}},'configured').estimatedCostUsd,null);
 assert.equal(usageRecord({},'gpt-5-mini').estimatedCostUsd,null);
 assert.equal(usageRecord({usage:{input_tokens:1,output_tokens:2,input_tokens_details:{cached_tokens:10}}},'gpt-5-mini').estimatedCostUsd,null);
});
test('citation audit includes conditional scenarios, detects version drift and malformed refs',()=>{
 const base={sectorViews:[{targetId:'cloud',evidenceRefs:[reference],scenarios:[{evidenceRefs:[reference]}]}]};
 assert.equal(citationAudit(base,packet).matched,2);
 base.sectorViews[0].scenarios[0].evidenceRefs=[{...reference,observationVersion:'v2'},{}];
 assert.equal(citationAudit(base,packet).invalid,2);assert.equal(citationAudit({sectorViews:[]},packet).accuracy,null);
});
test('same input failed calls back off and daily requests have a real cap',()=>{
 const calls=[{attemptedAt:'2026-10-03T00:00:00Z',inputHash:'x',status:'rejected'}];
 assert.equal(callPermission(calls,settings,'x','2026-10-03T00:30:00Z').reason,'retry_backoff');
 assert.equal(callPermission(calls,{...settings,maxDailyCalls:1},'other','2026-10-03T01:00:00Z').reason,'daily_call_limit');
 assert.equal(callPermission(calls,settings,'x','2026-10-04T00:00:00Z').allowed,true);
});
test('actual Responses request enables reasoning, disables storage and records resolved version',async()=>{
 let body;const result=await callReasoning({key:'test-only',settings,prompt:'facts',schema:{type:'json_schema'},fetchImpl:async(url,opts)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');body=JSON.parse(opts.body);
  return {ok:true,headers:new Map([['x-request-id','request-1']]),json:async()=>({id:'response-1',status:'completed',model:'gpt-5-mini-2025-08-07',output:[{type:'reasoning'},{content:[{type:'output_text',text:'{"test":true}'}]}],usage:{input_tokens:100,output_tokens:200}})};
 }});
 assert.equal(body.reasoning.effort,'medium');assert.equal(body.store,false);assert.equal(body.max_output_tokens,16000);assert.deepEqual(result.raw,{test:true});assert.equal(result.requestId,'request-1');assert.equal(result.usage.resolvedModel,'gpt-5-mini-2025-08-07');
});
test('incomplete outputs preserve chargeable usage and cannot become successful analysis',async()=>{
 await assert.rejects(callReasoning({key:'test-only',settings,prompt:'x',schema:{},fetchImpl:async()=>({ok:true,json:async()=>({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:100,output_tokens:1000}})})}),error=>Boolean(error.metadata.usage.estimatedCostUsd>0));
});
test('non-JSON and refusal never become a ready model',async()=>{
 for(const content of [[{type:'output_text',text:'not json'}],[{type:'refusal',refusal:'no'}]])await assert.rejects(callReasoning({key:'test-only',settings,prompt:'x',schema:{},fetchImpl:async()=>({ok:true,json:async()=>({status:'completed',output:[{content}]})})}));
});
