import {createHash} from 'node:crypto';

export const MODEL_RUNTIME_VERSION='reasoning-runtime-1.0.0';
const modelPrices={'gpt-5-mini':{input:0.25,cachedInput:0.025,output:2},'gpt-5.4':{input:2.5,cachedInput:0.25,output:15},'gpt-5.4-mini':{input:0.75,cachedInput:0.075,output:4.5}};
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function modelSettings(env=process.env){
 const integer=(name,fallback,min,max)=>{const value=Number(env[name]?.trim()||fallback);if(!Number.isInteger(value)||value<min||value>max)throw Error(`${name} 配置无效`);return value;};
 const effort=env.REASONING_EFFORT?.trim()||'medium';
 if(!['low','medium','high'].includes(effort))throw Error('REASONING_EFFORT 必须为 low、medium 或 high');
 return {model:env.REASONING_MODEL?.trim()||'gpt-5.4',effort,maxOutputTokens:integer('REASONING_MAX_OUTPUT_TOKENS',16000,4000,64000),timeoutMs:integer('REASONING_TIMEOUT_SECONDS',180,30,600)*1000,maxDailyCalls:integer('REASONING_MAX_DAILY_CALLS',8,1,100),retryMinutes:integer('REASONING_RETRY_MINUTES',60,15,1440)};
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
 const model=payload?.model??configuredModel;
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
export async function callReasoning({key,settings,prompt,schema,fetchImpl=fetch}){
 const controller=new AbortController(),start=Date.now(),timer=setTimeout(()=>controller.abort(),settings.timeoutMs);
 try{
  const response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model:settings.model,reasoning:{effort:settings.effort},store:false,instructions:'用简体中文输出可追溯的产业研究，区分正反证据及条件性情景，不编造数据。',input:prompt,max_output_tokens:settings.maxOutputTokens,text:{format:schema}})});
  if(!response.ok)throw Object.assign(Error(`模型请求失败 HTTP ${response.status}`),{httpStatus:response.status,metadata:{requestId:response.headers?.get?.('x-request-id')??null,elapsedMs:Date.now()-start,httpStatus:response.status}});
  const payload=await response.json();
  const metadata={requestId:response.headers?.get?.('x-request-id')??payload.id??null,responseId:payload.id??null,usage:usageRecord(payload,settings.model),elapsedMs:Date.now()-start,responseStatus:payload.status??null};
  if(payload.status&&payload.status!=='completed')throw Object.assign(Error('模型输出未完成：'+(payload.incomplete_details?.reason??payload.status)),{metadata});
  const parts=(payload.output??[]).flatMap(item=>item.content??[]);
  if(parts.some(part=>part.type==='refusal'))throw Object.assign(Error('模型未返回研究结论'),{metadata});
  const text=typeof payload.output_text==='string'?payload.output_text:parts.filter(part=>part.type==='output_text').map(part=>part.text).join('');
  try{return {raw:JSON.parse(text),...metadata,outputHash:createHash('sha256').update(text).digest('hex')};}
  catch{throw Object.assign(Error('模型未返回有效 JSON'),{metadata});}
 }finally{clearTimeout(timer);}
}
