import test from 'node:test';
import assert from 'node:assert/strict';
import {callReasoning,modelSettings,usageRecord,localUsageRecord,citationAudit,callPermission} from '../lib/industry/model-runtime.mjs';
const settings=modelSettings({REASONING_PROVIDER:'openai'}),localSettings=modelSettings({}),reference={metricId:'X',periodEnd:'2026-06-30',observationVersion:'v1'};
const packet={quantitative:{sectorSignals:[{targetId:'cloud',evidenceRefs:[reference]}]},contextRefs:[]};
test('empty GitHub variables retain defaults and invalid settings fail',()=>{
 assert.deepEqual(modelSettings({REASONING_MAX_DAILY_CALLS:'',REASONING_EFFORT:''}),localSettings);
 assert.throws(()=>modelSettings({REASONING_MAX_DAILY_CALLS:'0'}));assert.throws(()=>modelSettings({REASONING_EFFORT:'none'}));
});
test('default configuration is local and never silently selects a paid provider',()=>{
 assert.equal(localSettings.provider,'ollama');assert.equal(localSettings.model,'qwen3:8b');assert.equal(localSettings.localBaseUrl,'http://127.0.0.1:11434');
 assert.equal(localSettings.localTimeoutMs,600000);assert.equal(localSettings.localContextTokens,40960);assert.equal(localSettings.localMaxOutputTokens,8192);
 assert.equal(settings.provider,'openai');assert.equal(settings.model,'gpt-5.4');
 assert.throws(()=>modelSettings({REASONING_PROVIDER:'other'}));
 assert.throws(()=>modelSettings({REASONING_LOCAL_TIMEOUT_SECONDS:'1801'}));
 assert.throws(()=>modelSettings({REASONING_LOCAL_CONTEXT_TOKENS:'32768',REASONING_LOCAL_MAX_OUTPUT_TOKENS:'32768'}));
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
const invoke=fetchImpl=>callReasoning({key:'sk-test-secret-value',settings,prompt:'private input',schema:{},fetchImpl});
const response=(status,payload)=>({status,ok:status>=200&&status<300,headers:new Map([['x-request-id','request-safe-id']]),json:async()=>payload});
const assertDiagnosis=(code,retryable,status)=>error=>{
 assert.equal(error.name,'ReasoningRuntimeError');assert.equal(error.errorCode,code);
 assert.equal(error.metadata.errorCode,code);assert.equal(error.metadata.retryable,retryable);
 assert.equal(typeof error.metadata.action,'string');assert.ok(error.metadata.action.length>0);
 if(status)assert.equal(error.metadata.httpStatus,status);
 const stored=JSON.stringify({...error,message:error.message});
 assert.doesNotMatch(stored,/sk-test-secret-value|private input|upstream-secret/);
 return true;
};
test('HTTP failures provide distinct safe actions without recording upstream bodies',async()=>{
 for(const [status,code,retryable] of [[401,'auth_failed',false],[403,'access_denied',false],[404,'model_unavailable',false],[400,'request_invalid',false],[413,'request_invalid',false],[422,'request_invalid',false],[408,'timeout',true],[504,'timeout',true],[500,'provider_unavailable',true],[502,'provider_unavailable',true],[418,'request_failed',false]]){
  await assert.rejects(invoke(async()=>response(status,{error:{message:'upstream-secret sk-test-secret-value private input',code:'unknown'}})),assertDiagnosis(code,retryable,status));
 }
});
test('HTTP 429 distinguishes exhausted credits from retryable rate limits',async()=>{
 for(const code of ['insufficient_quota','credit_balance_exhausted','billing_hard_limit_reached','billing_not_active']){
  await assert.rejects(invoke(async()=>response(429,{error:{code,message:'upstream-secret'}})),assertDiagnosis('quota_exceeded',false,429));
 }
 await assert.rejects(invoke(async()=>response(429,{error:{type:'insufficient_quota'}})),assertDiagnosis('quota_exceeded',false,429));
 await assert.rejects(invoke(async()=>response(429,{error:{code:'rate_limit_exceeded'}})),assertDiagnosis('rate_limited',true,429));
});
test('HTTP diagnostics survive HTML and malformed upstream error responses',async()=>{
 await assert.rejects(invoke(async()=>({...response(403,null),json:async()=>{throw new SyntaxError('upstream-secret');}})),assertDiagnosis('access_denied',false,403));
 await assert.rejects(invoke(async()=>({...response(200,null),json:async()=>{throw new SyntaxError('private input');}})),assertDiagnosis('invalid_response',true,200));
 for(const payload of [null,[],42,{status:'completed',output:{}},{status:'upstream-secret',output:[]}])await assert.rejects(invoke(async()=>response(200,payload)),error=>{
  assertDiagnosis(payload?.status==='upstream-secret'?'incomplete_output':'invalid_response',true)(error);return true;
 });
});
test('network errors and actual aborts have safe retry instructions',async()=>{
 await assert.rejects(invoke(async()=>{throw Error('network failed for sk-test-secret-value private input');}),assertDiagnosis('network_error',true));
 await assert.rejects(callReasoning({key:'sk-test-secret-value',settings:{...settings,timeoutMs:5},prompt:'private input',schema:{},fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(Error('upstream-secret')),{once:true});
 })}),assertDiagnosis('timeout',true));
});
test('missing key fails before any request and never consumes a paid call',async()=>{
 let called=false;
 await assert.rejects(callReasoning({key:' ',settings,prompt:'x',schema:{},fetchImpl:async()=>{called=true;}}),assertDiagnosis('key_not_configured',false));
 assert.equal(called,false);
});
test('incomplete output diagnoses retain usage but discard provider details',async()=>{
 for(const [reason,code,retryable] of [['max_output_tokens','output_limit',false],['content_filter','content_filtered',false],['upstream-secret','incomplete_output',true]]){
  await assert.rejects(invoke(async()=>response(200,{status:'incomplete',incomplete_details:{reason},usage:{input_tokens:100,output_tokens:1000},output:[{content:[{type:'output_text',text:'private input'}]}]})),error=>{
   assertDiagnosis(code,retryable)(error);assert.ok(error.metadata.usage.estimatedCostUsd>0);return true;
  });
 }
});
test('refusals empty output and invalid JSON remain separate observable failures',async()=>{
 for(const [content,code] of [[[null,{type:'refusal',refusal:'private input'}],'refused'],[[],'empty_output'],[[{type:'output_text',text:'  '}],'empty_output'],[[{type:'output_text',text:'private input'}],'invalid_json'],[[{type:'output_text',text:'null'}],'invalid_json'],[[{type:'output_text',text:'[]'}],'invalid_json']]){
  await assert.rejects(invoke(async()=>response(200,{status:'completed',output:[null,{content}]})),assertDiagnosis(code,code!=='refused'));
 }
});
const localSchema={type:'json_schema',name:'research',strict:true,schema:{type:'object',properties:{test:{type:'boolean'}},required:['test'],additionalProperties:false}};
const localShow={capabilities:['completion','thinking'],model_info:{'qwen3.context_length':40960}};
const localTags={models:[{name:'qwen3:8b',model:'qwen3:8b',digest:'a'.repeat(64),size:5000000000}]};
const localPayload={model:'qwen3:8b',done:true,done_reason:'stop',message:{role:'assistant',content:'{"test":true}',thinking:'private thinking must never persist'},prompt_eval_count:120,eval_count:80};
const localInvoke=(fetchImpl,overrides={})=>callReasoning({key:'sk-test-secret-value',settings:{...localSettings,...overrides},prompt:'facts',schema:localSchema,fetchImpl});
function localFetch({show=localShow,tags=localTags,chat=localPayload,onRequest=()=>{}}={}){
 return async(url,opts)=>{
  onRequest(url,opts);
  if(url.endsWith('/api/show'))return response(200,show);
  if(url.endsWith('/api/tags'))return response(200,tags);
  if(url.endsWith('/api/chat'))return response(200,chat);
  throw Error('unexpected remote request');
 };
}
test('local reasoning verifies installed model then requests thinking and strict JSON without credentials',async()=>{
 const requests=[];const result=await localInvoke(localFetch({onRequest:(url,opts)=>{
  requests.push(url);assert.ok(url.startsWith('http://127.0.0.1:11434/api/'));assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,undefined);
  if(url.endsWith('/chat')){
   const body=JSON.parse(opts.body);assert.equal(body.think,true);assert.equal(body.stream,false);assert.deepEqual(body.format,localSchema.schema);
   assert.deepEqual(body.options,{num_ctx:40960,num_predict:8192,temperature:0.6});assert.equal(body.messages[1].content,'facts');
  }
 }}));
 assert.deepEqual(requests.map(url=>new URL(url).pathname),['/api/show','/api/tags','/api/chat']);
 assert.deepEqual(result.raw,{test:true});assert.equal(result.provider,'ollama');assert.equal(result.thinkingEnabled,true);assert.equal(result.modelDigest,'a'.repeat(64));
 assert.equal(result.usage.estimatedCostUsd,0);assert.equal(result.usage.costStatus,'local_no_api_fee');assert.equal(result.usage.reasoningTokens,null);assert.equal(result.usage.totalTokens,200);
 assert.doesNotMatch(JSON.stringify(result),/private thinking|sk-test-secret-value/);
});
test('local usage reports unknown counts honestly while API fee remains zero',()=>{
 const result=localUsageRecord({},'qwen3:8b');assert.equal(result.inputTokens,null);assert.equal(result.outputTokens,null);assert.equal(result.totalTokens,null);assert.equal(result.reasoningTokens,null);assert.equal(result.estimatedCostUsd,0);
 assert.equal(localUsageRecord({prompt_eval_count:10,eval_count:20,prompt_eval_cached_count:3},'qwen3:8b').cachedInputTokens,3);
});
test('local endpoint validation blocks remote URLs credentials redirects and disguised paths',async()=>{
 for(const localBaseUrl of ['https://127.0.0.1:11434','http://example.com:11434','http://127.0.0.1.example.com','http://name:secret@localhost:11434','http://localhost:11434/api','http://localhost:11434/?key=value','http://localhost:11434#hash','http://localhost:11434/.','http://127.0.0.1:99999']){
  let calls=0;await assert.rejects(localInvoke(async()=>{calls++;},{localBaseUrl}),assertDiagnosis('local_endpoint_invalid',false));assert.equal(calls,0);
 }
 for(const localBaseUrl of ['http://127.0.0.1:11434','http://localhost:11434/','http://[::1]:11434'])assert.equal(modelSettings({REASONING_LOCAL_BASE_URL:localBaseUrl}).localBaseUrl,new URL(localBaseUrl).origin);
});
test('cloud tags and remote aliases are refused before inference with no OpenAI fallback',async()=>{
 for(const model of ['qwen3:cloud','qwen3:8b-cloud','cloud/model']){
  let calls=0;await assert.rejects(localInvoke(async()=>{calls++;},{model}),assertDiagnosis('local_remote_model_not_allowed',false));assert.equal(calls,0);
 }
 for(const override of [{show:{...localShow,remote_host:'https://ollama.com'}},{show:{...localShow,model_info:{cloud:true}}},{tags:{models:[{...localTags.models[0],remote_model:'qwen3:8b',remote_host:'https://ollama.com'}]}}]){
  const called=[];await assert.rejects(localInvoke(localFetch({...override,onRequest:url=>called.push(url)})),assertDiagnosis('local_remote_model_not_allowed',false));assert.ok(called.every(url=>!url.endsWith('/chat')));
 }
});
test('local service errors missing models and unsupported thinking have actionable diagnoses',async()=>{
 let calls=0;await assert.rejects(localInvoke(async url=>{calls++;assert.ok(url.startsWith('http://127.0.0.1'));throw Error('sk-test-secret-value');}),assertDiagnosis('local_unavailable',true));assert.equal(calls,1);
 await assert.rejects(localInvoke(async()=>response(404,{error:'model not found private input'})),assertDiagnosis('local_model_missing',false,404));
 await assert.rejects(localInvoke(localFetch({tags:{models:[]}})),assertDiagnosis('local_model_missing',false));
 await assert.rejects(localInvoke(localFetch({tags:{models:[{...localTags.models[0],size:0}]}})),assertDiagnosis('local_model_missing',false));
 await assert.rejects(localInvoke(localFetch({show:{capabilities:['completion']}})),assertDiagnosis('local_thinking_unsupported',false));
 await assert.rejects(localInvoke(localFetch({show:{...localShow,thinking:{values:[false]}}})),assertDiagnosis('local_thinking_unsupported',false));
 const result=await localInvoke(localFetch({show:{capabilities:['completion'],thinking:{values:[true,false]}}}));assert.deepEqual(result.raw,{test:true});
});
test('local context bounds prevent silent evidence truncation',async()=>{
 let calls=0;
 await assert.rejects(callReasoning({settings:localSettings,prompt:'证据'.repeat(8000),schema:localSchema,fetchImpl:async()=>{calls++;}}),assertDiagnosis('context_limit',false));assert.equal(calls,0);
 await assert.rejects(localInvoke(localFetch({show:{...localShow,model_info:{'qwen3.context_length':8192}}})),assertDiagnosis('context_limit',false));
 await assert.rejects(localInvoke(async()=>response(400,{error:'input exceeds context window private input'})),assertDiagnosis('context_limit',false,400));
});
test('local truncated invalid and empty outputs cannot become successful research',async()=>{
 for(const [chat,code] of [[{...localPayload,done:false},'incomplete_output'],[{...localPayload,done_reason:'length'},'output_limit'],[{...localPayload,message:{thinking:'private thinking'}},'empty_output'],[{...localPayload,message:{content:'private input'}},'invalid_json']]){
  await assert.rejects(localInvoke(localFetch({chat})),error=>{
   assertDiagnosis(code,code!=='output_limit')(error);assert.equal(error.metadata.usage.costStatus,'local_no_api_fee');assert.doesNotMatch(JSON.stringify(error),/private thinking/);return true;
  });
 }
 await assert.rejects(localInvoke(async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private input')),{once:true})),{localTimeoutMs:5}),assertDiagnosis('local_timeout',true));
});
