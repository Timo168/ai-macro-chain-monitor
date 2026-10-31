import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {validateModelAnalysis} from '../lib/industry/research.mjs';

const builder=new URL('../scripts/build-investment-research.mjs',import.meta.url);

test('disabled local generation never fetches; only exact validated handoffs are accepted and recorded once',async()=>{
 const temporaryRoot=resolve(tmpdir()),directory=mkdtempSync(join(temporaryRoot,'local-handoff-'));
 const cwd=process.cwd(),environment={...process.env},previousFetch=globalThis.fetch;
 const json=(name,value)=>writeFileSync(join(directory,name),JSON.stringify(value));
 const read=name=>JSON.parse(readFileSync(join(directory,'data/industry',name),'utf8'));
 let requests=0,sequence=0;
 const build=()=>import(builder.href+'?local-handoff-case='+Date.now()+'-'+sequence++);
 const now=new Date().toISOString(),today=now.slice(0,10);
 const recommendation={targetId:'overall',targetName:'AI产业链整体',level:'insufficient_data',confidence:'low',coverage:0,requiredDimensionCount:5,availableDimensionCount:0,reason:'证据不足',dataCutoffAt:'',positiveEvidence:[],negativeEvidence:[],neutralEvidence:[],missingMetrics:['未配置建设数据'],invalidationConditions:['下一次正式披露后重新核验。']};
 try{
  mkdirSync(join(directory,'data/industry'),{recursive:true});mkdirSync(join(directory,'lib'));
  json('lib/indicators.json',[]);
  json('data/industry/latest.json',{definitions:[],series:{},recommendations:[recommendation],projects:[],events:[]});
  json('data/latest.json',{series:{DFII10:{status:'ready',sourceUrl:'https://example.com/official',observations:[{date:today,value:1.5,version:'fixture-rate-v1',publishedAt:now,sourceUrl:'https://example.com/official'}]}}});
  process.chdir(directory);
  for(const name of Object.keys(process.env))if(name.startsWith('REASONING_')||name==='OPENAI_API_KEY')delete process.env[name];
  globalThis.fetch=async()=>{requests++;throw Error('Test forbids all live network and model calls');};
  await build();let result=read('research.json');
  assert.equal(result.model.providerId,'ollama');
  assert.equal(result.model.model,'qwen3:8b');
  assert.equal(result.model.automaticEnabled,false);
  assert.equal(result.analysis.origin,'deterministic');
  assert.equal(requests,0);

  const exactRef=result.evidence.inputSnapshot.contextRefs.find(ref=>ref.metricId==='DFII10');
  assert.ok(exactRef,'fixture must include an exact permitted background citation');
  const reference=(({metricId,observationVersion,periodEnd})=>({metricId,observationVersion,periodEnd}))(exactRef);
  // Synthetic output for integration tests; not evidence of a real model run.
  const analysis={origin:'model',overallStance:result.quantitative.overall.stance,summary:'当前整体证据不足，等待正式披露。',marketRegime:result.evidence.inputSnapshot.marketRegime,confidence:'low',limitations:['这是一份离线合成验收结果。'],sectorViews:result.quantitative.sectorSignals.map(signal=>({targetId:signal.targetId,stance:signal.stance,thesis:'关键直接证据不足，仍需核验。',evidenceRefs:[],contextRefs:[reference],missingMetricIds:signal.missingMetrics,risks:['后续披露可能改变现有判断。'],nextEvidence:['核对下一期正式披露。'],positiveCase:'已有背景观测可供跟踪。',contraryCase:'关键直接数据尚未齐备。',scenarios:['base','upside','downside'].map(name=>({name,assumption:'若后续正式披露发生变化。',implication:'则重新核验条件性判断。',invalidation:'新披露不再支持现有假设时重新评估。',evidenceRefs:[reference]}))}))};
  const outputHash=createHash('sha256').update(JSON.stringify(validateModelAnalysis(analysis,result.evidence.inputSnapshot,{requireScenarios:true}))).digest('hex');
  const model={...result.model,status:'ready',generatedAt:now,lastSuccessfulAt:now,resolvedModel:'qwen3:8b',modelDigest:'a'.repeat(64),modelCapabilities:['completion','thinking'],thinkingEnabled:true,outputHash,error:null,errorCode:null,usage:{resolvedModel:'qwen3:8b',inputTokens:100,outputTokens:100,totalTokens:200,estimatedCostUsd:0,costStatus:'local_no_api_fee'}};
  const call={attemptedAt:now,inputHash:result.inputHash,providerId:'ollama',model:'qwen3:8b',status:'ready',usage:model.usage};
  const artifact={schemaVersion:'1',inputHash:result.inputHash,generatedAt:now,model,analysis,calls:[call]};
  const save=value=>json('data/industry/research-local-model.json',value);

  for(const altered of [
   {...artifact,inputHash:'different-evidence'},
   {...artifact,model:{...model,providerId:'openai'}},
   {...artifact,model:{...model,model:'other-local-model'}},
   {...artifact,analysis:{...analysis,origin:'deterministic'}}
  ]){
   save(altered);await build();result=read('research.json');
   assert.equal(result.analysis.origin,'deterministic');
   assert.equal(result.modelAudit.successfulCalls,0);
   assert.equal(requests,0);
  }

  save(artifact);await build();result=read('research.json');
  assert.equal(result.analysis.origin,'model');
  assert.equal(result.model.status,'cached');
  assert.equal(result.model.cacheReason,'local_handoff');
  assert.equal(result.model.citationAudit.invalid,0);
  assert.equal(result.model.citationAudit.matched,4);
  assert.equal(result.modelAudit.successfulCalls,1);
  assert.equal(read('research-model-calls.json').length,1);
  assert.deepEqual(result.analysis.sectorViews[0].contextRefs,[reference]);

  await build();await build();
  assert.equal(read('research-model-calls.json').length,1,'repeated static builds must not invent extra local calls');
  assert.equal(read('research.json').modelAudit.successfulCalls,1);

  const badCitation=structuredClone(artifact);
  badCitation.analysis.sectorViews[0].contextRefs[0].observationVersion='invented-revision';
  save(badCitation);await build();result=read('research.json');
  assert.equal(result.analysis.origin,'deterministic','a rejected current artifact must not silently reuse the prior model answer');
  assert.equal(result.model.errorCode,'output_rejected');
  assert.equal(read('research-model-calls.json').length,1);

  const badStance=structuredClone(artifact);badStance.analysis.overallStance='positive_allocation';
  save(badStance);await build();result=read('research.json');
  assert.equal(result.analysis.origin,'deterministic','exact citations do not permit overriding evidence gates');
  assert.equal(result.model.errorCode,'output_rejected');
  assert.equal(requests,0);

  const noThinking={...artifact,model:{...artifact.model,thinkingEnabled:false}};
  save(noThinking);await build();result=read('research.json');
  assert.equal(result.analysis.origin,'deterministic','metadata must prove this was a local thinking model');
  assert.equal(result.model.errorCode,'output_rejected');

  process.env.REASONING_MODEL='another-local-model';
  await build();result=read('research.json');
  assert.equal(result.model.lastSuccessfulAt,null,'a new model cannot inherit another model success time');
  assert.equal(requests,0);
 }finally{
  globalThis.fetch=previousFetch;process.chdir(cwd);
  for(const name of Object.keys(process.env))if(!Object.hasOwn(environment,name))delete process.env[name];Object.assign(process.env,environment);
  const child=relative(temporaryRoot,resolve(directory));
  assert.ok(child&&!child.startsWith('..')&&!child.includes(':')&&child.startsWith('local-handoff-'),'cleanup must stay inside its own temp folder');
  rmSync(directory,{recursive:true,force:true});
 }
});
