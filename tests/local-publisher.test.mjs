import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {LOCAL_PUBLISH_TARGET,publishLocalReasoning,validateLocalHandoff} from '../scripts/publish-local-reasoning.mjs';
import {MODEL_RUNTIME_VERSION,citationAudit} from '../lib/industry/model-runtime.mjs';
import {RESEARCH_PROMPT_VERSION,validateModelAnalysis} from '../lib/industry/research.mjs';
import {LOCAL_RESEARCH_PROMPT_VERSION} from '../lib/industry/local-research.mjs';
import {modelEvaluationCases} from '../lib/industry/model-evaluation.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json=value=>({status:0,stdout:JSON.stringify(value)});
const file=(value,sha='a'.repeat(40))=>json({type:'file',encoding:'base64',sha,content:Buffer.from(JSON.stringify(value)).toString('base64')});
function fixture(){
 const {packet,answer}=modelEvaluationCases()[0];
 packet.temporalBoundary={asOfDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),availabilityMode:'current_observation'};
 const analysis=validateModelAnalysis(answer,packet,{requireScenarios:true}),generatedAt=new Date(Date.now()-60000).toISOString();
 const model={status:'ready',provider:'Ollama 本地推理',providerId:'ollama',model:'local-test:8b',resolvedModel:'local-test:8b',modelDigest:'sha256:'+'a'.repeat(64),thinkingEnabled:true,modelCapabilities:['completion','thinking'],effort:'medium',runtimeVersion:MODEL_RUNTIME_VERSION,promptVersion:RESEARCH_PROMPT_VERSION,localPromptVersion:LOCAL_RESEARCH_PROMPT_VERSION,generatedAt,lastSuccessfulAt:generatedAt,checkedAt:generatedAt,error:null,errorCode:null,automaticEnabled:false,outputHash:hash(analysis),citationAudit:citationAudit(analysis,packet),usage:{resolvedModel:'local-test:8b',inputTokens:100,outputTokens:50,reasoningTokens:null,estimatedCostUsd:0,costStatus:'local_no_api_fee'}};
 const inputHash=hash({promptVersion:RESEARCH_PROMPT_VERSION,localPromptVersion:LOCAL_RESEARCH_PROMPT_VERSION,provider:'ollama',model:model.model,effort:model.effort,runtimeVersion:MODEL_RUNTIME_VERSION,packet});
 const calls=[{attemptedAt:generatedAt,inputHash,providerId:'ollama',model:model.model,effort:model.effort,promptVersion:RESEARCH_PROMPT_VERSION,status:'ready',usage:model.usage,citationAudit:model.citationAudit}];
 return {handoff:{schemaVersion:'1',inputHash,generatedAt,model,analysis,calls},current:{inputHash,model,evidence:{inputSnapshot:packet}}};
}

test('dry run verifies a real local handoff without network, GitHub mutation, or model generation',async()=>{
 const {handoff,current}=fixture();let touched=0;
 const result=await publishLocalReasoning({handoff,current,run:()=>{touched++;throw Error('not allowed');},readCurrent:()=>{touched++;throw Error('not allowed');}});
 assert.equal(result.status,'validated');assert.equal(result.published,false);assert.equal(touched,0);
});

test('missing digest, nonlocal origins, runtime drift, quality failures and altered evidence are rejected',()=>{
 const cases=[
  value=>{value.handoff.model.modelDigest=null;},
  value=>{value.handoff.model.status='cached';},
  value=>{value.handoff.model.providerId='openai';},
  value=>{value.handoff.analysis.origin='deterministic';},
  value=>{value.handoff.model.runtimeVersion='old-runtime';},
  value=>{value.handoff.model.localPromptVersion='old-local-prompt';},
  value=>{value.handoff.model.thinkingEnabled=false;},
  value=>{value.handoff.model.modelCapabilities=['completion'];},
  value=>{value.handoff.quality={accepted:false};},
  value=>{value.handoff.model.quality={status:'failed'};},
  value=>{value.handoff.analysis.sectorViews[0].evidenceRefs[0].observationVersion='invented';},
  value=>{value.current.evidence.inputSnapshot.marketRegime='negative_evidence';},
  value=>{value.handoff.calls=[];},
 ];
 for(const mutate of cases){const value=structuredClone(fixture());mutate(value);assert.throws(()=>validateLocalHandoff(value.handoff,value.current));}
});

test('model identity, success timestamps and free local usage must agree across the handoff and call log',()=>{
 const future=new Date(Date.now()+600000).toISOString();
 const cases=[
  value=>{value.handoff.model.resolvedModel='unexpected-model:cloud';},
  value=>{value.handoff.model.lastSuccessfulAt=future;},
  value=>{value.handoff.model.generatedAt='invalid-date';},
  value=>{value.handoff.calls[0].attemptedAt=future;},
  value=>{value.handoff.calls[0].completedAt=new Date(Date.parse(value.handoff.calls[0].attemptedAt)-1).toISOString();},
  value=>{value.handoff.calls[0].modelDigest='sha256:'+'b'.repeat(64);},
  value=>{value.handoff.calls[0].resolvedModel='unexpected-model:8b';},
  value=>{value.handoff.calls[0].usage={...value.handoff.model.usage,costStatus:'estimated_from_usage',estimatedCostUsd:1};},
  value=>{value.handoff.model.usage={...value.handoff.model.usage,inputTokens:-1};},
  value=>{value.handoff.model.usage={...value.handoff.model.usage,totalTokens:999};},
  value=>{value.handoff.calls[0].usage={...value.handoff.model.usage,resolvedModel:'different:8b'};},
 ];
 for(const mutate of cases){const value=structuredClone(fixture());mutate(value);assert.throws(()=>validateLocalHandoff(value.handoff,value.current));}
});

test('publisher only PUTs the single allowlisted artifact through JSON stdin with its current SHA',async()=>{
 const {handoff,current}=fixture(),seen=[];
 const existing={...structuredClone(handoff),generatedAt:new Date(Date.parse(handoff.generatedAt)-1000).toISOString()};
 const run=async(args,options)=>{
  seen.push({args,options});
  if(args[0]==='workflow')return {status:0,stdout:''};
  if(args[2]==='GET')return file(args[3].includes('/research.json?')?current:existing,'b'.repeat(40));
  assert.equal(args[2],'PUT');assert.equal(args[3],`repos/${LOCAL_PUBLISH_TARGET.repo}/contents/industry/research-local-model.json`);
  assert.deepEqual(args.slice(-2),['--input','-']);
  const body=JSON.parse(options.input),payload=JSON.parse(Buffer.from(body.content,'base64').toString());
  assert.equal(body.sha,'b'.repeat(40));assert.equal(body.branch,'data-cache');assert.equal(payload.inputHash,handoff.inputHash);
  assert.equal(payload.analysis.origin,'model');assert.equal(payload.model.modelDigest,handoff.model.modelDigest);
  assert.equal(payload.model.thinkingEnabled,true);assert.ok(payload.model.modelCapabilities.includes('thinking'));assert.equal(payload.model.localPromptVersion,LOCAL_RESEARCH_PROMPT_VERSION);
  assert.equal(body.content.includes('OPENAI_API_KEY'),false);
  return json({commit:{sha:'c'.repeat(40)}});
 };
 const result=await publishLocalReasoning({handoff,current,publish:true,run,readCurrent:async()=>current});
 assert.equal(result.status,'published');assert.equal(result.deploymentRequested,true);
 assert.equal(seen.filter(item=>item.args[2]==='PUT').length,1);
 assert.deepEqual(seen.at(-1).args,['workflow','run','deploy.yml','--repo',LOCAL_PUBLISH_TARGET.repo,'--ref','main']);
});

test('online or data-branch input drift aborts before any writes',async()=>{
 for(const location of ['public','branch']){
  const {handoff,current}=fixture();let writes=0;
  const changed={...current,inputHash:'b'.repeat(64)};
  const run=async(args)=>{if(args[2]==='PUT')writes++;return file(location==='branch'?changed:current);};
  await assert.rejects(publishLocalReasoning({handoff,current,publish:true,run,readCurrent:async()=>location==='public'?changed:current}),/输入不一致/);
  assert.equal(writes,0);
 }
});

test('409 revalidates current inputs and refuses a newly published different-input result',async()=>{
 const {handoff,current}=fixture();let puts=0,reads=0,dispatched=0;
 const run=async(args)=>{
  if(args[0]==='workflow'){dispatched++;return {status:0,stdout:''};}
  if(args[2]==='PUT'){puts++;return {status:1,stdout:JSON.stringify({status:'409',message:'Conflict'})};}
  if(args[3].includes('/research.json?'))return file(current);
  reads++;return reads===1?{status:1,stdout:JSON.stringify({status:'404'})}:file({...handoff,inputHash:'b'.repeat(64),generatedAt:new Date().toISOString()});
 };
 await assert.rejects(publishLocalReasoning({handoff,current,publish:true,run,readCurrent:async()=>current}),/不同输入的新推理/);
 assert.equal(puts,1);assert.equal(dispatched,0);assert.equal(reads,2);
});

test('409 retries once with a freshly read SHA when evidence remains identical',async()=>{
 const {handoff,current}=fixture();let puts=0,artifactReads=0,publicReads=0;
 const older={...handoff,generatedAt:new Date(Date.parse(handoff.generatedAt)-1000).toISOString()};
 const run=async(args,options)=>{
  if(args[0]==='workflow')return {status:0,stdout:''};
  if(args[2]==='GET'){
   if(args[3].includes('/research.json?'))return file(current);
   artifactReads++;return file(older,String(artifactReads).repeat(40));
  }
  puts++;assert.equal(JSON.parse(options.input).sha,String(puts).repeat(40));
  return puts===1?{status:1,stdout:JSON.stringify({status:409})}:json({commit:{sha:'c'.repeat(40)}});
 };
 const result=await publishLocalReasoning({handoff,current,publish:true,run,readCurrent:async()=>{publicReads++;return current;}});
 assert.equal(result.status,'published');assert.equal(puts,2);assert.equal(publicReads,2);
});

test('already published content is idempotent and can retry deployment without another PUT',async()=>{
 const {handoff,current}=fixture();let writes=0;
 const run=async(args)=>{
  if(args[0]==='workflow')return {status:0,stdout:''};
  if(args[2]==='PUT')writes++;
  return file(args[3].includes('/research.json?')?current:handoff);
 };
 const result=await publishLocalReasoning({handoff,current,publish:true,run,readCurrent:async()=>current});
 assert.equal(result.status,'already_published');assert.equal(result.unchanged,true);assert.equal(writes,0);
});

test('credential-like text cannot be published and unknown fields are not exported',()=>{
 const {handoff,current}=fixture();handoff.debugEnv={OPENAI_API_KEY:'unpublished-placeholder'};
 const safe=validateLocalHandoff(handoff,current);assert.equal('debugEnv' in safe,false);
 handoff.analysis.summary='检查凭证 sk-PRIVATE-DONT-PUBLISH-123456。';handoff.model.outputHash=hash(handoff.analysis);
 assert.throws(()=>validateLocalHandoff(handoff,current),/凭证/);
});

test('spawn uses a hidden nonshell process and never passes a body on the command line',()=>{
 const source=readFileSync(new URL('../scripts/publish-local-reasoning.mjs',import.meta.url),'utf8');
 assert.match(source,/shell:false,windowsHide:true/);assert.match(source,/stdio:\['pipe','pipe','pipe'\]/);
 assert.doesNotMatch(source,/process\.env|force-with-lease|--force|execSync\(/);
});

test('local runner validates both a fresh result and cache reuse through the same publication gate',()=>{
 const source=readFileSync(new URL('../scripts/run-local-reasoning.mjs',import.meta.url),'utf8');
 assert.match(source,/REASONING_PROVIDER:'ollama'/);
 assert.match(source,/validateLocalHandoff\(previous,current\)/);
 assert.match(source,/const envelope=validateLocalHandoff\(/);
 assert.match(source,/new URL\('\.\.\/data\/industry\/',import\.meta\.url\)/);
 assert.doesNotMatch(source,/OPENAI_API_KEY|provider:'openai'|api\.openai\.com/);
});
