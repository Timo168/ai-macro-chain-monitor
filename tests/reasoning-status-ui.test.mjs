import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../app/industry/reasoning-status.ts',import.meta.url),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {reasoningStatus}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
const fixture=(model={},origin='deterministic',successfulCalls=0)=>({
 model:{status:'not_configured',provider:'Ollama 本地推理',providerId:'ollama',model:'local-test-model',automaticEnabled:false,error:null,...model},
 analysis:{origin},modelAudit:{successfulCalls},
});

test('unconfigured local engine is not presented as a successful model call',()=>{
 const state=reasoningStatus(fixture());
 assert.equal(state.active,false);assert.equal(state.local,true);assert.equal(state.title,'等待配置本地推理');
 assert.equal(state.actualModel,null);assert.equal(state.successfulCalls,0);
 assert.match(state.explanation,/规则引擎/);assert.doesNotMatch(state.diagnostic.action,/密钥|充值/);
});

test('only a verified model-origin ready or cached result is presented as model reasoning',()=>{
 for(const status of ['not_configured','fetch_failed','rejected','deferred']){
  assert.equal(reasoningStatus(fixture({status},'model',3)).active,false,status);
 }
 for(const status of ['ready','cached']){
  assert.equal(reasoningStatus(fixture({status},'deterministic',3)).active,false,status);
  const state=reasoningStatus(fixture({status,resolvedModel:'actual-local-version'},'model',3));
  assert.equal(state.active,true);assert.equal(state.actualModel,'actual-local-version');
 }
});

test('disabled automatic calls do not hide the provenance of a verified cached result',()=>{
 const state=reasoningStatus(fixture({status:'cached',cacheReason:'unchanged_input',automaticEnabled:false},'model',1));
 assert.equal(state.title,'复用已验证推理');assert.equal(state.active,true);assert.equal(state.successfulCalls,1);
 assert.doesNotMatch(state.explanation,/最新抓取|实时/);
});

test('raw provider errors and action fields never reach the public status explanation',()=>{
 const secret='sk-test-PRIVATE-DO-NOT-DISPLAY';
 for(const errorCode of ['unknown_provider_error','network_error',undefined]){
  const state=reasoningStatus(fixture({status:'fetch_failed',errorCode,error:`401 ${secret}`,action:`debug ${secret}`}));
  assert.equal(JSON.stringify(state).includes(secret),false);assert.ok(state.diagnostic);
 }
});

test('local missing-model and context failures have actionable safe diagnostics',()=>{
 const missing=reasoningStatus(fixture({status:'fetch_failed',errorCode:'local_model_missing'}));
 const context=reasoningStatus(fixture({status:'fetch_failed',errorCode:'context_limit'}));
 assert.match(missing.diagnostic.reason,/未安装/);assert.match(context.diagnostic.reason,/上下文/);
 assert.equal(missing.active,false);assert.equal(context.active,false);
});

test('local timeout, unsupported thinking, and failed requests have distinct safe explanations',()=>{
 for(const [errorCode,expected] of [['local_timeout',/超过等待时间/],['local_thinking_unsupported',/支持思考模式/],['local_request_failed',/请求未完成/]]){
  const state=reasoningStatus(fixture({status:'fetch_failed',errorCode,error:'private-path-and-provider-detail'}));
  assert.equal(state.active,false);assert.match(state.diagnostic.reason,expected);assert.match(state.diagnostic.action,/管理员/);
  assert.equal(JSON.stringify(state).includes('private-path-and-provider-detail'),false);
 }
});
