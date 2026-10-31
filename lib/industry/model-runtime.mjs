import {createHash} from 'node:crypto';

export const MODEL_RUNTIME_VERSION='reasoning-runtime-2.0.0';
const modelPrices={'gpt-5-mini':{input:0.25,cachedInput:0.025,output:2},'gpt-5.4':{input:2.5,cachedInput:0.25,output:15},'gpt-5.4-mini':{input:0.75,cachedInput:0.075,output:4.5}};
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function modelSettings(env=process.env){
 const integer=(name,fallback,min,max)=>{const value=Number(env[name]?.trim()||fallback);if(!Number.isInteger(value)||value<min||value>max)throw Error(`${name} 配置无效`);return value;};
 const provider=env.REASONING_PROVIDER?.trim()||'ollama';
 if(!['ollama','openai'].includes(provider))throw Error('REASONING_PROVIDER 必须为 ollama 或 openai');
 const effort=env.REASONING_EFFORT?.trim()||'medium';
 if(!['low','medium','high'].includes(effort))throw Error('REASONING_EFFORT 必须为 low、medium 或 high');
 const model=env.REASONING_MODEL?.trim()||(provider==='ollama'?'qwen3:8b':'gpt-5.4');
 const localBaseUrl=localEndpoint(env.REASONING_LOCAL_BASE_URL?.trim()||'http://127.0.0.1:11434');
 if(provider==='ollama'&&isCloudModel(model))throw modelFailure('local_remote_model_not_allowed');
 const localContextTokens=integer('REASONING_LOCAL_CONTEXT_TOKENS',40960,2048,131072),localMaxOutputTokens=integer('REASONING_LOCAL_MAX_OUTPUT_TOKENS',8192,256,32768);
 if(localMaxOutputTokens>=localContextTokens)throw Error('本地推理输出预算必须小于上下文窗口');
 return {provider,model,effort,maxOutputTokens:integer('REASONING_MAX_OUTPUT_TOKENS',16000,4000,64000),timeoutMs:integer('REASONING_TIMEOUT_SECONDS',180,30,600)*1000,maxDailyCalls:integer('REASONING_MAX_DAILY_CALLS',8,1,100),retryMinutes:integer('REASONING_RETRY_MINUTES',60,15,1440),localBaseUrl,localTimeoutMs:integer('REASONING_LOCAL_TIMEOUT_SECONDS',600,30,1800)*1000,localContextTokens,localMaxOutputTokens};
}
export function callPermission(calls,settings,inputHash,now){
 const day=now.slice(0,10),same=(calls??[]).filter(call=>call.inputHash===inputHash);
 const recent=same.at(-1);
 if(recent&&recent.status!=='ready'&&Date.parse(now)-Date.parse(recent.attemptedAt)<settings.retryMinutes*60000)return {allowed:false,reason:'retry_backoff'};
 if((calls??[]).filter(call=>call.attemptedAt?.startsWith(day)).length>=settings.maxDailyCalls)return {allowed:false,reason:'daily_call_limit'};
 return {allowed:true,reason:null};
}
export function usageRecord(payload,configuredModel){
 const u=payload?.usage??{},input=u.input_tokens,output=u.output_tokens,cached=u.input_tokens_details?.cached_tokens??0,reasoning=u.output_tokens_details?.reasoning_tokens??0;
 const complete=[input,output,cached,reasoning].every(finite)&&cached<=input&&reasoning<=output;
 const model=typeof payload?.model==='string'?payload.model:configuredModel;
 const base=model.replace(/-\d{4}-\d{2}-\d{2}$/,'');
 const rates=base==='gpt-5.4'&&input>272000?null:modelPrices[base]??null;
 const pricingSource='https://developers.openai.com/api/docs/models/'+base;
 return {resolvedModel:model,inputTokens:finite(input)?input:null,outputTokens:finite(output)?output:null,cachedInputTokens:finite(cached)?cached:null,reasoningTokens:finite(reasoning)?reasoning:null,totalTokens:complete?input+output:null,estimatedCostUsd:complete&&rates?((input-cached)*rates.input+cached*rates.cachedInput+output*rates.output)/1e6:null,costStatus:!complete?'usage_unavailable':rates?'estimated_from_usage':'pricing_not_configured',pricing:rates?{perMillionTokens:rates,sourceUrl:pricingSource,checkedAt:'2026-10-03',note:'根据标准文本 token 单价估算；以账户账单为准。'}:null};
}
const refKey=ref=>[ref?.metricId,ref?.observationVersion,ref?.periodEnd].join('|');
export function citationAudit(raw,packet){
 const sectors=new Map(packet.quantitative.sectorSignals.map(signal=>[signal.targetId,signal]));
 const contexts=new Set((packet.contextRefs??[]).map(refKey));
 let total=0,matched=0;const failures=[];
 for(const view of raw?.sectorViews??[]){
  const direct=new Set((sectors.get(view.targetId)?.evidenceRefs??[]).map(refKey));
  for(const [field,allowed] of [['evidenceRefs',direct],['contextRefs',contexts]])for(const ref of view[field]??[]){total++;if(ref&&['metricId','observationVersion','periodEnd'].every(k=>typeof ref[k]==='string'&&ref[k])&&allowed.has(refKey(ref)))matched++;else failures.push({targetId:view.targetId,field,reference:ref});}
  for(const scenario of view.scenarios??[])for(const ref of scenario.evidenceRefs??[]){total++;if(ref&&['metricId','observationVersion','periodEnd'].every(k=>typeof ref[k]==='string'&&ref[k])&&(direct.has(refKey(ref))||contexts.has(refKey(ref))))matched++;else failures.push({targetId:view.targetId,field:'scenario.evidenceRefs',reference:ref});}
 }
 return {check:'exact_metric_period_version',total,matched,invalid:total-matched,accuracy:total?matched/total:null,status:failures.length?'failed':total?'passed':'no_citations',failures,meaning:'只验证引用的指标、日期和版本匹配；不代表投资判断准确率。'};
}
// Never expose upstream error messages or bodies: they can contain submitted input.
const failureDetails={
 local_endpoint_invalid:['本地推理地址不符合要求','仅配置 http://127.0.0.1:11434 等本机回环地址，不附加路径、账号或查询参数。',false],
 local_remote_model_not_allowed:['当前模型指向云端，已阻止调用','使用已经下载到本机的模型；本地模式不会转用云模型或付费 API。',false],
 local_unavailable:['本机 Ollama 服务尚不可用','启动本机后台 Ollama 服务后重试。',true],
 local_model_missing:['所选推理模型尚未安装到本机','先在本机下载所选模型，再重新运行研究推理。',false],
 local_thinking_unsupported:['本地模型未确认支持思考模式','选择支持 thinking 的本地模型，并确认 Ollama 版本支持该能力。',false],
 local_request_failed:['本地推理请求未完成','检查本机 Ollama 服务与模型状态，修复后重试。',true],
 local_timeout:['本地推理超过等待时间','保留现有结果，检查本机资源，必要时缩减输入或增加本地超时设置。',true],
 context_limit:['研究输入或输出预算超出本地上下文容量','缩减本次证据输入或拆分研究任务，保持完整证据后再生成。',false],
 key_not_configured:['后台尚未配置推理 API 密钥','在后台配置 OPENAI_API_KEY 后重试。',false],
 auth_failed:['推理 API 身份验证失败','检查后台 API 密钥是否有效，以及所属项目是否正确。',false],
 access_denied:['当前项目没有推理 API 访问权限','检查账户、项目、组织及地区访问权限。',false],
 model_unavailable:['配置的推理模型或接口资源不可用','核对模型名称，并确认当前 API 项目有该模型的访问权限。',false],
 quota_exceeded:['推理 API 可用额度不足','检查 API 账户余额、项目预算与计费状态，恢复额度后再试。',false],
 rate_limited:['推理 API 请求受到限流','等待限流窗口结束后重试；持续发生时检查项目速率与用量限额。',true],
 request_invalid:['推理 API 未接受当前请求配置','检查模型支持的推理参数、输出格式和上下文长度。',false],
 provider_unavailable:['推理 API 服务暂时不可用','保留现有结果，稍后重试并查看服务状态。',true],
 request_failed:['推理 API 请求失败','根据 HTTP 状态检查后台配置，修复后再试。',false],
 timeout:['推理 API 请求超时','稍后重试；持续超时时检查网络或调整后台超时设置。',true],
 network_error:['无法连接推理 API','检查后台网络与代理连接后重试。',true],
 invalid_response:['推理 API 返回了无法识别的响应','保留现有结果，稍后重试；持续发生时检查接口响应格式。',true],
 output_limit:['推理输出达到上限，结论尚未完成','检查输出预算，适当提高最大输出 token 或缩减输入后重试。',false],
 content_filtered:['推理输出受到内容限制，未形成完整结论','检查研究输入与请求内容后重新生成。',false],
 incomplete_output:['推理输出尚未完成','保留现有结果，稍后重新生成并检查完整性。',true],
 refused:['推理模型未接受本次研究请求','检查研究输入与请求内容后重新生成。',false],
 empty_output:['推理模型没有返回研究正文','保留现有结果，检查输出预算后重新生成。',true],
 invalid_json:['推理模型没有返回有效的研究 JSON 对象','保留现有结果，检查结构化输出配置后重新生成。',true],
};
function modelFailure(errorCode,metadata={}){
 const [message,action,retryable]=failureDetails[errorCode];
 const details={...metadata,errorCode,action,retryable};
 return Object.assign(Error(message),{name:'ReasoningRuntimeError',errorCode,action,retryable,httpStatus:details.httpStatus??null,metadata:details});
}
function httpErrorCode(status,payload){
 const labels=[payload?.error?.code,payload?.error?.type];
 if(status===401)return 'auth_failed';
 if(status===403)return 'access_denied';
 if(status===404)return 'model_unavailable';
 if(status===429)return labels.some(value=>['insufficient_quota','credit_balance_exhausted','billing_hard_limit_reached','billing_not_active'].includes(value))?'quota_exceeded':'rate_limited';
 if(status===408||status===504)return 'timeout';
 if(status>=500)return 'provider_unavailable';
 if([400,413,422].includes(status))return 'request_invalid';
 return 'request_failed';
}
function localEndpoint(value){
 if(typeof value!=='string'||!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/?$/i.test(value))throw modelFailure('local_endpoint_invalid');
 try{const url=new URL(value);if(url.port==='0')throw Error();return url.origin;}
 catch{throw modelFailure('local_endpoint_invalid');}
}
const isCloudModel=model=>typeof model!=='string'||/(?:^|[:/-])cloud(?:$|[:/-])/i.test(model)||/-cloud$/i.test(model);
function remoteModelMetadata(value){
 if(!value||typeof value!=='object')return false;
 for(const [key,item] of Object.entries(value)){
  if(['remote_host','remote_model','cloud','is_remote'].includes(key)&&item)return true;
  if(['name','model'].includes(key)&&typeof item==='string'&&isCloudModel(item))return true;
  if(item&&typeof item==='object'&&remoteModelMetadata(item))return true;
 }
 return false;
}
export function localUsageRecord(payload,configuredModel){
 const input=payload?.prompt_eval_count,output=payload?.eval_count,cached=payload?.prompt_eval_cached_count;
 return {resolvedModel:typeof payload?.model==='string'?payload.model:configuredModel,inputTokens:finite(input)?input:null,outputTokens:finite(output)?output:null,cachedInputTokens:finite(cached)?cached:null,reasoningTokens:null,totalTokens:finite(input)&&finite(output)?input+output:null,estimatedCostUsd:0,costStatus:'local_no_api_fee',pricing:null};
}
async function callLocalReasoning({settings,prompt,schema,fetchImpl=fetch}){
 const base=localEndpoint(settings.localBaseUrl??'http://127.0.0.1:11434'),model=settings.model??'qwen3:8b';
 if(isCloudModel(model))throw modelFailure('local_remote_model_not_allowed');
 const contextTokens=settings.localContextTokens??40960,maxOutputTokens=settings.localMaxOutputTokens??8192;
 const instructions='用简体中文输出可追溯的产业研究，区分正反证据及条件性情景，不编造数据。仅在最终正文返回符合指定格式的 JSON 对象。';
 // A byte upper bound deliberately rejects uncertain fit rather than silently truncating evidence.
 if(typeof prompt!=='string'||Buffer.byteLength(prompt+instructions,'utf8')+maxOutputTokens+512>contextTokens)throw modelFailure('context_limit');
 if(!schema?.schema||typeof schema.schema!=='object'||Array.isArray(schema.schema))throw modelFailure('request_invalid');
 const start=Date.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),settings.localTimeoutMs??600000);
 const request=async(path,body)=>{
  let response;
  try{response=await fetchImpl(base+path,{method:body?'POST':'GET',signal:controller.signal,redirect:'error',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
  catch{throw modelFailure(controller.signal.aborted?'local_timeout':'local_unavailable',{provider:'ollama',elapsedMs:Date.now()-start});}
  if(!response||typeof response.json!=='function')throw modelFailure('invalid_response',{provider:'ollama',elapsedMs:Date.now()-start});
  let payload;
  try{payload=await response.json();}
  catch{throw modelFailure(controller.signal.aborted?'local_timeout':'invalid_response',{provider:'ollama',httpStatus:response.status??null,elapsedMs:Date.now()-start});}
  if(!response.ok||payload?.error){
   const errorText=typeof payload?.error==='string'?payload.error:'';
   const errorCode=/context (?:length|window)|input.*(?:too long|exceed)|exceed.*context/i.test(errorText)?'context_limit':response.status===404?'local_model_missing':'local_request_failed';
   throw modelFailure(errorCode,{provider:'ollama',httpStatus:response.status??null,elapsedMs:Date.now()-start});
  }
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw modelFailure('invalid_response',{provider:'ollama',elapsedMs:Date.now()-start});
  return payload;
 };
 try{
  const shown=await request('/api/show',{model,verbose:false});
  if(remoteModelMetadata(shown))throw modelFailure('local_remote_model_not_allowed',{provider:'ollama'});
  const tags=await request('/api/tags');
  if(!Array.isArray(tags.models))throw modelFailure('invalid_response',{provider:'ollama'});
  const canonical=name=>typeof name==='string'?(name.includes(':')?name:name+':latest'):null;
  const installed=tags.models.find(item=>canonical(item?.name)===canonical(model)||canonical(item?.model)===canonical(model));
  if(!installed)throw modelFailure('local_model_missing',{provider:'ollama'});
  if(remoteModelMetadata(installed))throw modelFailure('local_remote_model_not_allowed',{provider:'ollama'});
  if(!finite(installed.size)||installed.size<=0)throw modelFailure('local_model_missing',{provider:'ollama'});
  const capabilities=Array.isArray(shown.capabilities)?shown.capabilities.filter(item=>typeof item==='string'):[];
  const thinking=Array.isArray(shown.thinking?.values)?shown.thinking.values.includes(true):capabilities.includes('thinking');
  if(!thinking)throw modelFailure('local_thinking_unsupported',{provider:'ollama'});
  const limits=Object.entries(shown.model_info??{}).filter(([key,value])=>key.endsWith('.context_length')&&finite(value)&&value>0).map(([,value])=>value);
  if(limits.length&&contextTokens>Math.min(...limits))throw modelFailure('context_limit',{provider:'ollama'});
  const payload=await request('/api/chat',{model,stream:false,think:true,format:schema.schema,messages:[{role:'system',content:instructions},{role:'user',content:prompt}],options:{num_ctx:contextTokens,num_predict:maxOutputTokens,temperature:0.6}});
  if(remoteModelMetadata({model:payload.model}))throw modelFailure('local_remote_model_not_allowed',{provider:'ollama'});
  const modelDigest=typeof installed.digest==='string'&&/^(?:sha256:)?[a-f\d]{64}$/i.test(installed.digest)?installed.digest:null;
  const metadata={provider:'ollama',requestId:null,responseId:null,usage:localUsageRecord(payload,model),elapsedMs:Date.now()-start,responseStatus:payload.done===true?'completed':'incomplete',modelDigest,modelCapabilities:capabilities,thinkingEnabled:true};
  if(payload.done!==true)throw modelFailure('incomplete_output',metadata);
  if(payload.done_reason==='length')throw modelFailure('output_limit',metadata);
  // Ollama's thinking field is intentionally neither returned nor persisted.
  const text=payload.message?.content;
  if(typeof text!=='string'||!text.trim())throw modelFailure('empty_output',metadata);
  let raw;
  try{raw=JSON.parse(text);}catch{throw modelFailure('invalid_json',metadata);}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw modelFailure('invalid_json',metadata);
  return {raw,...metadata,outputHash:createHash('sha256').update(text).digest('hex')};
 }finally{clearTimeout(timer);}
}
export async function callReasoning(args){
 const provider=args.settings?.provider??'ollama';
 if(provider==='ollama')return callLocalReasoning(args);
 if(provider==='openai')return callOpenAIReasoning(args);
 throw modelFailure('request_invalid');
}
async function callOpenAIReasoning({key,settings,prompt,schema,fetchImpl=fetch}){
 if(typeof key!=='string'||!key.trim())throw modelFailure('key_not_configured');
 const controller=new AbortController(),start=Date.now(),timer=setTimeout(()=>controller.abort(),settings.timeoutMs);
 try{
  let response;
  try{response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model:settings.model,reasoning:{effort:settings.effort},store:false,instructions:'用简体中文输出可追溯的产业研究，区分正反证据及条件性情景，不编造数据。',input:prompt,max_output_tokens:settings.maxOutputTokens,text:{format:schema}})});}
  catch{throw modelFailure(controller.signal.aborted?'timeout':'network_error',{elapsedMs:Date.now()-start});}
  if(!response||typeof response.json!=='function')throw modelFailure('invalid_response',{elapsedMs:Date.now()-start});
  const transport={requestId:response.headers?.get?.('x-request-id')??null,httpStatus:response.status??null,elapsedMs:Date.now()-start};
  let payload;
  try{payload=await response.json();}
  catch{
   if(controller.signal.aborted)throw modelFailure('timeout',{...transport,elapsedMs:Date.now()-start});
   throw modelFailure(response.ok?'invalid_response':httpErrorCode(response.status,null),transport);
  }
  if(!response.ok)throw modelFailure(httpErrorCode(response.status,payload),{...transport,elapsedMs:Date.now()-start});
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw modelFailure('invalid_response',transport);
  const metadata={requestId:response.headers?.get?.('x-request-id')??payload.id??null,responseId:payload.id??null,usage:usageRecord(payload,settings.model),elapsedMs:Date.now()-start,responseStatus:['completed','failed','in_progress','queued','cancelled','incomplete'].includes(payload.status)?payload.status:null};
  if(payload.status!=='completed'){
   const reason=payload.incomplete_details?.reason;
   const code=reason==='max_output_tokens'?'output_limit':reason==='content_filter'?'content_filtered':payload.status?'incomplete_output':'invalid_response';
   throw modelFailure(code,metadata);
  }
  if(payload.output!==undefined&&!Array.isArray(payload.output))throw modelFailure('invalid_response',metadata);
  const parts=(payload.output??[]).flatMap(item=>Array.isArray(item?.content)?item.content:[]);
  if(parts.some(part=>part?.type==='refusal'))throw modelFailure('refused',metadata);
  const text=typeof payload.output_text==='string'?payload.output_text:parts.filter(part=>part?.type==='output_text'&&typeof part.text==='string').map(part=>part.text).join('');
  if(!text.trim())throw modelFailure('empty_output',metadata);
  let raw;
  try{raw=JSON.parse(text);}
  catch{throw modelFailure('invalid_json',metadata);}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw modelFailure('invalid_json',metadata);
  return {raw,...metadata,outputHash:createHash('sha256').update(text).digest('hex')};
 }finally{clearTimeout(timer);}
}
