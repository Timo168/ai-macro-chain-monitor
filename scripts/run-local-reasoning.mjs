// Read the published evidence packet and generate an independent local result.
// No API key, cloud model, or local macro database is sent to GitHub by this job.
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {modelSettings,callReasoning,citationAudit,MODEL_RUNTIME_VERSION} from '../lib/industry/model-runtime.mjs';
import {createLocalResearchPrompt,LOCAL_RESEARCH_PROMPT_VERSION} from '../lib/industry/local-research.mjs';
import {modelJsonSchema,validateModelAnalysis,RESEARCH_PROMPT_VERSION} from '../lib/industry/research.mjs';
import {validateLocalHandoff} from './publish-local-reasoning.mjs';

const directory=fileURLToPath(new URL('../data/industry/',import.meta.url));mkdirSync(directory,{recursive:true});
const output=directory+'/research-local-model.json';
const lock=directory+'/local-reasoning.lock';
let lockFd;
try{lockFd=openSync(lock,'wx');}catch{throw Error('已有本机推理任务运行；请等待结束。异常退出后确认进程已停止再清理 local-reasoning.lock。');}
try{
 const source='https://timo168.github.io/ai-macro-chain-monitor/data/industry-research.json';
 const response=await fetch(source+'?local='+Date.now(),{signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error(`无法读取线上研究数据：HTTP ${response.status}`);
 const current=await response.json(),packet=current.evidence?.inputSnapshot;
 if(!packet?.quantitative?.sectorSignals?.length||!current.inputHash)throw Error('线上缺少完整研究输入。');
 if(current.model?.providerId!=='ollama'||current.model?.runtimeVersion!==MODEL_RUNTIME_VERSION||current.model?.promptVersion!==RESEARCH_PROMPT_VERSION)throw Error('线上尚未发布相同版本的本地推理接口，请先完成网站部署。');
 const settings=modelSettings({...process.env,REASONING_PROVIDER:'ollama',REASONING_MODEL:current.model.model,REASONING_EFFORT:current.model.effort,REASONING_LOCAL_CONTEXT_TOKENS:process.env.REASONING_LOCAL_CONTEXT_TOKENS||'40960',REASONING_LOCAL_MAX_OUTPUT_TOKENS:process.env.REASONING_LOCAL_MAX_OUTPUT_TOKENS||'12288'});
 const expected=createHash('sha256').update(JSON.stringify({promptVersion:RESEARCH_PROMPT_VERSION,localPromptVersion:LOCAL_RESEARCH_PROMPT_VERSION,provider:settings.provider,model:settings.model,effort:settings.effort,runtimeVersion:MODEL_RUNTIME_VERSION,packet})).digest('hex');
 if(expected!==current.inputHash)throw Error('线上输入与本机推理版本不匹配，停止执行；不会使用过时数据。');
 writeFileSync(directory+'/research-local-input.json.tmp',JSON.stringify(current));renameSync(directory+'/research-local-input.json.tmp',directory+'/research-local-input.json');
 const previous=existsSync(output)?JSON.parse(readFileSync(output,'utf8')):null;
 if(previous?.inputHash===current.inputHash&&previous.model?.status==='ready'&&previous.analysis?.origin==='model'){
  validateLocalHandoff(previous,current);
  console.log('已存在相同输入的验收结果；复用缓存，不重复消耗本机算力。');
 }else{
  const prompt=createLocalResearchPrompt(packet),now=new Date().toISOString();
  console.log(`本机推理 ${settings.model}：${packet.quantitative.sectorSignals.length} 个研究目标，输入 ${Buffer.byteLength(prompt)} 字节，不调用外部 API。`);
  const result=await callReasoning({settings,prompt,schema:modelJsonSchema(packet)});
  const audit=citationAudit(result.raw,packet);
  if(audit.invalid)throw Error('本机模型引用未通过校验；结果不会发布。');
  const analysis=validateModelAnalysis(result.raw,packet,{requireScenarios:true});
  const callId='local:'+randomUUID(),finishedAt=new Date().toISOString();
  const model={status:'ready',provider:'Ollama 本地推理',providerId:'ollama',automaticEnabled:false,model:settings.model,resolvedModel:result.usage.resolvedModel,modelDigest:result.modelDigest,modelCapabilities:result.modelCapabilities,thinkingEnabled:result.thinkingEnabled,effort:settings.effort,runtimeVersion:MODEL_RUNTIME_VERSION,promptVersion:RESEARCH_PROMPT_VERSION,localPromptVersion:LOCAL_RESEARCH_PROMPT_VERSION,generatedAt:finishedAt,lastSuccessfulAt:finishedAt,checkedAt:finishedAt,requestId:callId,cacheReason:null,error:null,errorCode:null,action:null,retryable:null,outputHash:createHash('sha256').update(JSON.stringify(analysis)).digest('hex'),usage:result.usage,citationAudit:audit,elapsedMs:result.elapsedMs};
  const call={attemptedAt:now,completedAt:finishedAt,inputHash:current.inputHash,providerId:'ollama',model:settings.model,resolvedModel:model.resolvedModel,modelDigest:model.modelDigest,requestId:callId,status:'ready',usage:result.usage,citationAudit:audit,elapsedMs:result.elapsedMs};
  // The producer, cache reuse, publisher and website importer must agree on
  // what counts as a real validated local result, including runtime metadata.
  const envelope=validateLocalHandoff({schemaVersion:'1',inputHash:current.inputHash,sourceGeneratedAt:current.generatedAt,generatedAt:finishedAt,model,analysis,calls:[call]},current);
  writeFileSync(output+'.tmp',JSON.stringify(envelope));renameSync(output+'.tmp',output);
  console.log(`真实本机推理通过程序校验，耗时 ${Math.round(result.elapsedMs/1000)} 秒；外部 API 费用 0。语义质量仍需复核。`);
 }
}catch(error){
 console.error(error.metadata?.errorCode?`${error.metadata.errorCode}: ${error.metadata.action}`:error.message);
 process.exitCode=1;
}finally{closeSync(lockFd);unlinkSync(lock);}
