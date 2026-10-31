import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MODEL_RUNTIME_VERSION,citationAudit} from '../lib/industry/model-runtime.mjs';
import {RESEARCH_PROMPT_VERSION,validateModelAnalysis} from '../lib/industry/research.mjs';
import {LOCAL_RESEARCH_PROMPT_VERSION} from '../lib/industry/local-research.mjs';

export const LOCAL_PUBLISH_TARGET=Object.freeze({
 repo:'Timo168/ai-macro-chain-monitor',branch:'data-cache',
 path:'industry/research-local-model.json',researchPath:'industry/research.json',
 publicUrl:'https://timo168.github.io/ai-macro-chain-monitor/data/industry-research.json',
});
const root=fileURLToPath(new URL('../',import.meta.url));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const time=value=>typeof value==='string'?Date.parse(value):NaN;
const digest=value=>typeof value==='string'&&/^(?:sha256:)?[a-f\d]{64}$/i.test(value);
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const usageKeys=['resolvedModel','inputTokens','outputTokens','cachedInputTokens','reasoningTokens','totalTokens','estimatedCostUsd','costStatus','pricing'];
const fail=message=>{throw Error(message);};
const localModelName=value=>typeof value==='string'?(value.includes(':')?value:value+':latest'):null;
function validateLocalUsage(usage,model){
 if(!object(usage)||usage.costStatus!=='local_no_api_fee'||usage.estimatedCostUsd!==0||localModelName(usage.resolvedModel)!==localModelName(model.resolvedModel))fail('本地运行用量记录不完整或与本机推理模式不符。');
 for(const name of ['inputTokens','outputTokens','cachedInputTokens','reasoningTokens','totalTokens'])if(usage[name]!=null&&(!Number.isInteger(usage[name])||usage[name]<0))fail('本机调用 token 用量记录无效。');
 if(usage.totalTokens!=null&&usage.inputTokens!=null&&usage.outputTokens!=null&&usage.totalTokens!==usage.inputTokens+usage.outputTokens)fail('本机调用 token 合计与明细不一致。');
}

function checkQuality(value){
 if(!value)return;
 if(value.accepted===false||value.passed===false||['failed','rejected','incomplete','not_passed'].includes(value.status))fail('模型质量检查未通过，拒绝发布。');
}
function publicSafe(value){
 const text=JSON.stringify(value);
 if(Buffer.byteLength(text,'utf8')>4*1024*1024)fail('本地推理交接文件超过发布大小上限。');
 if(/\b(?:sk-[a-z\d_-]{12,}|gh[pousr]_[a-z\d]{12,}|github_pat_[a-z\d_]+)\b|Bearer\s+[a-z\d._-]+/i.test(text))fail('交接文件疑似包含凭证，拒绝公开发布。');
 return text;
}

/** Validate against an independently obtained current packet; never trust status alone. */
export function validateLocalHandoff(handoff,current,{now=Date.now()}={}){
 if(!object(handoff)||handoff.schemaVersion!=='1'||!object(handoff.model)||!object(handoff.analysis))fail('本地推理交接格式无效。');
 const {model,analysis}=handoff,packet=current?.evidence?.inputSnapshot;
 if(model.status!=='ready'||model.providerId!=='ollama'||analysis.origin!=='model')fail('仅允许发布已经验收的本机真实模型结果。');
 if(!digest(model.modelDigest))fail('缺少本地模型文件摘要，不能确认实际运行版本。');
 if(model.thinkingEnabled!==true||!Array.isArray(model.modelCapabilities)||!model.modelCapabilities.includes('thinking'))fail('缺少实际启用本机推理能力的记录。');
 if(model.runtimeVersion!==MODEL_RUNTIME_VERSION||model.promptVersion!==RESEARCH_PROMPT_VERSION||model.localPromptVersion!==LOCAL_RESEARCH_PROMPT_VERSION)fail('本地推理运行时或提示词版本已变化，请重新生成。');
 if(!object(packet)||!digest(handoff.inputHash)||current?.inputHash!==handoff.inputHash)fail('推理结果与当前研究输入不一致，请重新生成。');
 if(current.model?.runtimeVersion!==MODEL_RUNTIME_VERSION||current.model?.providerId!=='ollama'||current.model?.model!==model.model)fail('当前网站模型配置与本地推理不一致。');
 if(typeof model.model!=='string'||!model.model.trim()||/(?:^|[:\/-])cloud(?:$|[:\/-])/i.test(model.model))fail('仅允许发布已下载到本机的模型结果。');
 if(localModelName(model.resolvedModel)!==localModelName(model.model))fail('实际运行模型与配置模型不一致。');
 if(model.effort!==current.model.effort)fail('本地推理配置与当前研究输入的推理强度不一致。');
 const expectedHash=hash({promptVersion:RESEARCH_PROMPT_VERSION,localPromptVersion:LOCAL_RESEARCH_PROMPT_VERSION,provider:'ollama',model:model.model,effort:model.effort,runtimeVersion:MODEL_RUNTIME_VERSION,packet});
 if(expectedHash!==handoff.inputHash)fail('研究数据包无法复算输入哈希，拒绝发布。');
 for(const stamp of [handoff.generatedAt,model.generatedAt,model.lastSuccessfulAt])if(!Number.isFinite(time(stamp))||time(stamp)>now+300000)fail('本地推理成功时间无效。');
 if(time(model.lastSuccessfulAt)>time(handoff.generatedAt)+300000)fail('本地推理成功时间晚于交接时间。');
 if(model.error||model.errorCode||model.citationAudit?.invalid>0)fail('本地推理仍有错误或未通过引用检查。');
 checkQuality(handoff.quality);checkQuality(model.quality);checkQuality(handoff.modelEvaluation?.live?.evaluation);
 const audit=citationAudit(analysis,packet);
 if(audit.invalid)fail('本地推理引用未通过当前数据版本校验。');
 let normalized;
 try{normalized=validateModelAnalysis(analysis,packet,{requireScenarios:true});}catch{fail('本地推理未通过证据、情景与研究边界检查。');}
 if(!digest(model.outputHash)||model.outputHash!==hash(normalized))fail('本地推理正文摘要不一致，拒绝发布。');
 validateLocalUsage(model.usage,model);
 if(!Array.isArray(handoff.calls)||!handoff.calls.length)fail('缺少真实本机调用记录。');
 const calls=handoff.calls.map(call=>{
  if(call.status!=='ready'||call.providerId!=='ollama'||call.inputHash!==handoff.inputHash||!Number.isFinite(time(call.attemptedAt))||call.model!==model.model||call.citationAudit?.invalid>0||call.error)fail('本机调用记录与已验收结果不一致。');
  if(time(call.attemptedAt)>now+300000||time(call.attemptedAt)>time(handoff.generatedAt)+300000)fail('本机调用开始时间无效。');
  if(call.completedAt!==undefined&&(!Number.isFinite(time(call.completedAt))||time(call.completedAt)<time(call.attemptedAt)||time(call.completedAt)>now+300000))fail('本机调用完成时间无效。');
  if(call.modelDigest!==undefined&&call.modelDigest!==model.modelDigest||call.resolvedModel!==undefined&&localModelName(call.resolvedModel)!==localModelName(model.resolvedModel))fail('本机调用版本与交接模型不一致。');
  validateLocalUsage(call.usage,model);
  checkQuality(call.quality);
  return {...pick(call,['callId','attemptedAt','completedAt','inputHash','providerId','model','effort','promptVersion','localPromptVersion','status','requestId','responseId','resolvedModel','modelDigest','elapsedMs']),usage:pick(call.usage,usageKeys),citationAudit:pick(call.citationAudit,['check','total','matched','invalid','accuracy','status','meaning'])};
 });
 const safeModel={...pick(model,['status','provider','providerId','automaticEnabled','model','effort','runtimeVersion','promptVersion','localPromptVersion','generatedAt','lastSuccessfulAt','checkedAt','requestId','responseId','resolvedModel','modelDigest','modelCapabilities','thinkingEnabled','elapsedMs','outputHash']),cacheReason:null,error:null,errorCode:null,action:null,retryable:null,usage:pick(model.usage,usageKeys),citationAudit:audit};
 const payload={schemaVersion:'1',inputHash:handoff.inputHash,generatedAt:handoff.generatedAt,model:safeModel,analysis:normalized,calls};
 publicSafe(payload);
 return payload;
}

export function runGh(args,{input}={}){
 const result=spawnSync('gh',args,{cwd:root,shell:false,windowsHide:true,encoding:'utf8',input,stdio:['pipe','pipe','pipe'],timeout:60000,maxBuffer:24*1024*1024});
 // Never forward raw stderr, environment, or API bodies into a public log.
 if(result.error)return {status:1,stdout:'',httpStatus:null};
 return {status:result.status??1,stdout:result.stdout??'',httpStatus:null};
}
function responseJson(result){try{return JSON.parse(result.stdout);}catch{return null;}}
function httpStatus(result){const body=responseJson(result);return Number(result.httpStatus??body?.status)||null;}
const contentEndpoint=path=>`repos/${LOCAL_PUBLISH_TARGET.repo}/contents/${path}`;
async function remoteFile(run,path,{optional=false}={}){
 const result=await run(['api','--method','GET',contentEndpoint(path)+'?ref='+LOCAL_PUBLISH_TARGET.branch]);
 if(result.status!==0){if(optional&&httpStatus(result)===404)return null;fail('无法读取 GitHub 当前数据状态，未执行发布。');}
 const body=responseJson(result);
 if(body?.type!=='file'||body.encoding!=='base64'||typeof body.content!=='string'||typeof body.sha!=='string')fail('GitHub 数据文件格式不符合预期。');
 let value;try{value=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));}catch{fail('GitHub 数据文件不是有效 JSON。');}
 return {sha:body.sha,value};
}
export async function readPublicResearch(){
 const response=await fetch(LOCAL_PUBLISH_TARGET.publicUrl+'?publish-check='+Date.now(),{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(25000)});
 if(!response.ok)fail('无法核对线上研究输入，未执行发布。');
 const text=await response.text();
 if(Buffer.byteLength(text,'utf8')>20*1024*1024)fail('线上研究数据超过验收大小上限。');
 try{return JSON.parse(text);}catch{fail('线上研究数据无法解析。');}
}

/** Only --publish opts into the fixed single-file GitHub update and deployment. */
export async function publishLocalReasoning({handoff,current,publish=false,run=runGh,readCurrent=readPublicResearch,maxRetries=1}={}){
 const payload=validateLocalHandoff(handoff,current);
 if(!publish)return {status:'validated',published:false,inputHash:payload.inputHash,note:'仅完成本地验收；未访问 GitHub，未发布，未调用模型。'};
 let commitSha=null,unchanged=false;
 for(let attempt=0;attempt<=Math.min(1,Math.max(0,maxRetries));attempt++){
  const live=await readCurrent();validateLocalHandoff(payload,live);
  const branchCurrent=await remoteFile(run,LOCAL_PUBLISH_TARGET.researchPath);
  validateLocalHandoff(payload,branchCurrent.value);
  const existing=await remoteFile(run,LOCAL_PUBLISH_TARGET.path,{optional:true});
  if(existing&&existing.value.inputHash!==payload.inputHash&&(!Number.isFinite(time(existing.value.generatedAt))||time(existing.value.generatedAt)>=time(payload.generatedAt)))fail('云端已有不同输入的新推理结果，拒绝覆盖。');
  if(existing&&existing.value.inputHash===payload.inputHash){
   if(existing.value.model?.outputHash===payload.model.outputHash&&existing.value.generatedAt===payload.generatedAt){validateLocalHandoff(existing.value,live);unchanged=true;break;}
   if(!Number.isFinite(time(existing.value.generatedAt))||time(existing.value.generatedAt)>=time(payload.generatedAt))fail('云端已保存同一输入的更新结果，拒绝用较旧结果覆盖。');
  }
  const body={message:'Publish validated local reasoning result',branch:LOCAL_PUBLISH_TARGET.branch,content:Buffer.from(publicSafe(payload),'utf8').toString('base64'),...(existing?{sha:existing.sha}:{})};
  const result=await run(['api','--method','PUT',contentEndpoint(LOCAL_PUBLISH_TARGET.path),'--input','-'],{input:JSON.stringify(body)});
  if(result.status===0){commitSha=responseJson(result)?.commit?.sha;if(typeof commitSha!=='string'||!/^[a-f\d]{40,64}$/i.test(commitSha))fail('GitHub 返回的提交信息不完整；请核对后台状态。');break;}
  if(httpStatus(result)!==409)fail('GitHub 未接受发布请求；未覆盖其他数据文件。');
  if(attempt>=Math.min(1,Math.max(0,maxRetries)))fail('云端数据并发变化，已停止发布；请重新验收后再试。');
 }
 const dispatch=await run(['workflow','run','deploy.yml','--repo',LOCAL_PUBLISH_TARGET.repo,'--ref','main']);
 return {status:dispatch.status===0?(unchanged?'already_published':'published'):'published_deploy_pending',published:true,unchanged,inputHash:payload.inputHash,commitSha,deploymentRequested:dispatch.status===0,path:LOCAL_PUBLISH_TARGET.path};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const flags=process.argv.slice(2);if(flags.some(flag=>flag!=='--publish'))fail('仅支持 --publish；不传参数只做本地验收。');
  const handoff=JSON.parse(readFileSync(resolve(root,'data/industry/research-local-model.json'),'utf8'));
  const current=JSON.parse(readFileSync(resolve(root,'data/industry/research-local-input.json'),'utf8'));
  const result=await publishLocalReasoning({handoff,current,publish:flags.includes('--publish')});
  console.log(JSON.stringify(result));
  if(result.status==='published_deploy_pending')process.exitCode=2;
 }catch(error){console.error('Local reasoning publication stopped: '+(error instanceof SyntaxError?'本地 JSON 文件无效。':error?.code?'本地交接文件无法读取。':error?.message??'验收未通过。'));process.exitCode=1;}
}
