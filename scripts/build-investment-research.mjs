import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {buildFallbackAnalysis,buildResearchPacket,modelJsonSchema,modelPrompt,RESEARCH_PROMPT_VERSION,validateModelAnalysis} from '../lib/industry/research.mjs';
import {researchCheckpoint,appendCheckpoint,compareCheckpoints} from '../lib/industry/research-evolution.mjs';
import {buildTracking} from '../lib/industry/research-tracking.mjs';
import {buildValuations} from '../lib/industry/valuation.mjs';
import {modelSettings,callPermission,callReasoning,citationAudit,MODEL_RUNTIME_VERSION} from '../lib/industry/model-runtime.mjs';
import {buildResearchRobustness} from '../lib/industry/research-robustness.mjs';
import {buildResearchValidation} from '../lib/industry/research-validation.mjs';
import {buildResearchWatchlist} from '../lib/industry/research-watchlist.mjs';
import {buildCrossCompanyComparison} from '../lib/industry/cross-company.mjs';
import {buildModelEvaluation} from '../lib/industry/model-evaluation.mjs';
import {createLocalResearchPrompt,LOCAL_RESEARCH_PROMPT_VERSION} from '../lib/industry/local-research.mjs';
import {validateLocalHandoff} from './publish-local-reasoning.mjs';

const folder='data/industry';
const output=folder+'/research.json';
const historyPath=folder+'/research-history.json';
const inputsFolder=folder+'/research-inputs';
const industryPath=existsSync(folder+'/latest.json')?folder+'/latest.json':folder+'/seed.json';
const macroPath=existsSync('data/latest.json')?'data/latest.json':'data/seed.json';
const policyRatesPath=existsSync('data/policy-rates.json')?'data/policy-rates.json':'data/policy-rates.seed.json';
const policyDecisionsPath=existsSync('data/policy-decisions.json')?'data/policy-decisions.json':'data/policy-decisions.seed.json';
const read=(path,fallback)=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):fallback;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshotVersion=value=>hash(value).slice(0,16);
const writeJsonAtomic=(path,value)=>{mkdirSync(path.slice(0,path.lastIndexOf('/')),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(value));renameSync(path+'.tmp',path);};
const previous=read(output,null);
const history=read(historyPath,[]);
const industry=read(industryPath,{definitions:[],series:{},recommendations:[]});
const macro=read(macroPath,{series:{}});
const macroDefinitions=read('lib/indicators.json',[]);
const policyRates=read(policyRatesPath,{series:[]});
const policyDecisions=read(policyDecisionsPath,{decisions:[],checks:[]});
const settings=modelSettings();
const configuredModel=settings.model;
const localProvider=settings.provider==='ollama';
// Neither a page refresh nor adding an API key opts into paid generation.
const automaticEnabled=process.env.REASONING_ENABLED==='true';
const activationRequested=process.argv.includes('--activate-model');
const generationEnabled=automaticEnabled||activationRequested;
const key=process.env.OPENAI_API_KEY?.trim();
const packet=buildResearchPacket(industry,macro,macroDefinitions,policyRates,policyDecisions);
// Archive the complete vintage for recomputation, while the website and model
// receive only the compact evidence packet. A background check timestamp alone
// must not invalidate an otherwise identical model input.
const {calculationInputs,observationManifest,...publicPacket}=packet;
const inputHash=hash({promptVersion:RESEARCH_PROMPT_VERSION,localPromptVersion:localProvider?LOCAL_RESEARCH_PROMPT_VERSION:null,provider:settings.provider,model:configuredModel,effort:settings.effort,runtimeVersion:MODEL_RUNTIME_VERSION,packet:publicPacket});
const inputs={industry:{version:snapshotVersion(industry),generatedAt:industry.generatedAt??null},macro:{version:snapshotVersion(macro),generatedAt:macro.generatedAt??null},policyRates:{version:snapshotVersion(policyRates),generatedAt:policyRates.generatedAt??null},policyDecisions:{version:snapshotVersion(policyDecisions),generatedAt:policyDecisions.generatedAt??null}};
const cutoffOf=items=>items.filter(Boolean).sort().at(-1)??null;
const dataCutoffs={industry:cutoffOf(packet.quantitative.sectorSignals.map(signal=>signal.dataCutoffAt)),macro:cutoffOf(packet.macroSignals.map(signal=>signal.latestDate)),policy:cutoffOf(packet.policyRateSignals.map(signal=>signal.latestDate)),projects:cutoffOf(packet.fullSiteContext.projects.records.map(project=>project.latestEventDate))};

function safeError(error){const text=String(error?.message??error).replace(/[\r\n]+/g,' ');return (key?text.replaceAll(key,'[redacted]'):text).slice(0,220);}
async function requestModel(){
 return callReasoning({key,settings,prompt:localProvider?createLocalResearchPrompt(packet):modelPrompt(packet),schema:modelJsonSchema(packet)});
}

const now=new Date().toISOString();
const localAsOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
let analysis=buildFallbackAnalysis(packet);
const callsPath=folder+'/research-model-calls.json';
const calls=read(callsPath,[]);
const sameModel=previous?.model?.providerId===settings.provider&&previous?.model?.model===configuredModel;
let model={status:'not_configured',provider:localProvider?'Ollama 本地推理':'OpenAI Responses API',providerId:settings.provider,automaticEnabled,model:configuredModel,effort:settings.effort,runtimeVersion:MODEL_RUNTIME_VERSION,promptVersion:RESEARCH_PROMPT_VERSION,localPromptVersion:localProvider?LOCAL_RESEARCH_PROMPT_VERSION:null,generatedAt:null,lastSuccessfulAt:sameModel?(previous?.model?.lastSuccessfulAt??null):null,checkedAt:now,requestId:null,cacheReason:null,error:null,errorCode:localProvider?'local_not_configured':'key_not_configured',action:localProvider?'在本机启动已下载的模型，并运行一次真实推理验收。':'在后台配置 API 密钥；付费推理还需显式启用。',retryable:false,outputHash:null,usage:null,citationAudit:null};
const sameInput=previous?.inputHash===inputHash;
const reusableModel=sameInput&&previous?.analysis?.origin==='model'&&['ready','cached'].includes(previous?.model?.status);
const handoffPath=folder+'/research-local-model.json';
const localHandoff=localProvider?read(handoffPath,null):null;
let acceptedHandoff=false,handoffRejected=false;
// GitHub Pages reads a locally generated result; it never calls a home PC.
// Only the exact current evidence packet and a revalidated answer are reusable.
if(localHandoff?.inputHash===inputHash&&localHandoff.model?.providerId==='ollama'&&localHandoff.model?.model===configuredModel&&localHandoff.analysis?.origin==='model'&&localHandoff.model?.lastSuccessfulAt){
 try{
  const verified=validateLocalHandoff(localHandoff,{inputHash,model,evidence:{inputSnapshot:publicPacket}});
  analysis=verified.analysis;
  model={...verified.model,status:'cached',automaticEnabled,checkedAt:now,cacheReason:'local_handoff'};
  for(const call of verified.calls)if(!calls.some(saved=>saved.inputHash===call.inputHash&&saved.attemptedAt===call.attemptedAt))calls.push(call);
  acceptedHandoff=true;
 }catch{handoffRejected=true;model={...model,status:'rejected',errorCode:'output_rejected',error:'本地模型结果未通过当前证据校验。',action:'请在本机根据当前数据重新生成分析。'};}
}
if(!acceptedHandoff&&!handoffRejected&&(localProvider||key)){
 if(reusableModel){
  analysis=previous.analysis;
  model={...previous.model,status:'cached',automaticEnabled,checkedAt:now,cacheReason:'unchanged_input',error:null,errorCode:null,action:null,retryable:null};
 }else if(!generationEnabled){
  model={...model,errorCode:localProvider?'local_not_configured':'automation_disabled',status:localProvider?'not_configured':'deferred',action:localProvider?'等待本机生成并发布与当前数据匹配的推理结果；不会调用付费 API。':'自动付费推理未开启；先手动验收，再决定运行频率。'};
 }else{
  const permission=callPermission(calls,settings,inputHash,now);
  if(!permission.allowed){model={...model,status:'deferred',cacheReason:permission.reason,error:permission.reason==='daily_call_limit'?'达到后台每日调用次数设置，等待下一日。':'上次调用失败，正在等待后台重试。'};}
  else{
  let response;
  const call={attemptedAt:now,inputHash,providerId:settings.provider,model:configuredModel,effort:settings.effort,promptVersion:RESEARCH_PROMPT_VERSION,status:'fetch_failed',usage:null,citationAudit:null};
  try{response=await requestModel();}
  catch(error){
   Object.assign(call,error.metadata??{},{error:safeError(error)});
   if(sameInput&&previous?.analysis?.origin==='model'){
    analysis=previous.analysis;
    model={...previous.model,automaticEnabled,status:'cached',checkedAt:now,cacheReason:'request_failed',error:safeError(error),errorCode:error.metadata?.errorCode,action:error.metadata?.action,retryable:error.metadata?.retryable};
   }else model={...model,...(error.metadata??{}),status:'fetch_failed',error:safeError(error)};
  }
  if(response){
   Object.assign(call,{requestId:response.requestId,responseId:response.responseId,resolvedModel:response.usage.resolvedModel,elapsedMs:response.elapsedMs,usage:response.usage});
   try{
    const audit=citationAudit(response.raw,packet);call.citationAudit=audit;
    if(audit.invalid)throw Error('模型引用未通过精确版本校验');
    analysis=validateModelAnalysis(response.raw,packet,{requireScenarios:true});
    call.status='ready';
    model={...model,status:'ready',generatedAt:now,lastSuccessfulAt:now,requestId:response.requestId,resolvedModel:response.usage.resolvedModel,modelDigest:response.modelDigest??null,modelCapabilities:response.modelCapabilities??null,thinkingEnabled:response.thinkingEnabled??null,usage:response.usage,citationAudit:audit,elapsedMs:response.elapsedMs,outputHash:hash(analysis),error:null,errorCode:null,action:null,retryable:null};
   }catch(error){call.status='rejected';call.error=safeError(error);model={...model,status:'rejected',requestId:response.requestId,resolvedModel:response.usage.resolvedModel,usage:response.usage,citationAudit:call.citationAudit,error:safeError(error),errorCode:'output_rejected',action:'检查证据引用与输出边界，再运行验收。',retryable:false};}
  }
  calls.push(call);writeJsonAtomic(callsPath,calls);
  }
 }
}
if(acceptedHandoff)writeJsonAtomic(callsPath,calls);
if(localProvider&&model.status==='ready')writeJsonAtomic(handoffPath,{schemaVersion:'1',inputHash,generatedAt:now,model,analysis,calls:calls.filter(call=>call.inputHash===inputHash&&call.providerId==='ollama'&&call.status==='ready')});
const result={schemaVersion:'2',generatedAt:now,inputHash,inputs,dataCutoffs,model,quantitative:packet.quantitative,evidence:{macroSignals:packet.macroSignals,policyRateSignals:packet.policyRateSignals,institutionalReports:packet.institutionalReports,sourceRefs:packet.sourceRefs,dataGaps:packet.dataGaps,inputCoverage:packet.inputCoverage,guardrails:packet.guardrails,inputSnapshot:publicPacket},analysis};
result.modelAudit={totalCalls:calls.length,successfulCalls:calls.filter(call=>call.status==='ready').length,rejectedCalls:calls.filter(call=>call.status==='rejected').length,estimatedCostUsd:calls.reduce((sum,call)=>sum+(call.usage?.estimatedCostUsd??0),0),unpricedCalls:calls.filter(call=>call.usage?.estimatedCostUsd==null).length,maxDailyCalls:settings.maxDailyCalls,note:'引用匹配率只衡量来源版本匹配；费用为可计价调用的小计，未计价调用另列。'};
const ledgerPath=folder+'/research-ledger.json';
let ledger=read(ledgerPath,[]);
// Only actual previously saved output can establish the first comparison.
// Never recalculate a past signal from today's revised financial history.
if(!ledger.length&&previous?.quantitative&&previous?.evidence?.inputSnapshot){
 const archived=read(`${inputsFolder}/${previous.inputHash}.json`,null);
 ledger=[{...researchCheckpoint({...previous,generatedAt:archived?.createdAt??previous.generatedAt}),origin:'imported_archive'}];
}
// Recover a comparison from a previously saved numeric packet, not from a
// recomputation. These old packets never create retroactive sample baskets.
if(ledger.length===1&&ledger[0].origin==='live_archive'){
 for(const entry of (Array.isArray(history)?history:[]).slice().reverse()){
  const archived=read(`${inputsFolder}/${entry.inputHash}.json`,null);
  if(!archived?.packet?.quantitative?.sectorSignals?.length||!archived.createdAt||archived.createdAt>=ledger[0].recordedAt)continue;
  const baseline=researchCheckpoint({generatedAt:archived.createdAt,inputHash:archived.inputHash,quantitative:archived.packet.quantitative,evidence:{inputSnapshot:archived.packet},dataCutoffs:archived.dataCutoffs});
  if(baseline.id===ledger[0].id)continue;
  ledger=[{...baseline,origin:'imported_archive'},...ledger];break;
 }
}
const checkpoint=researchCheckpoint(result);
const evolution=appendCheckpoint(ledger,checkpoint);
result.changes=compareCheckpoints(evolution.previous,evolution.current,{unchanged:!evolution.appended});
const market=read(folder+'/research-market.json',{prices:{},finance:{}});
const followupPath=folder+'/research-followup.json';
result.followup=buildTracking(evolution.records,market,{asOf:localAsOf,prior:read(followupPath,null)});
writeJsonAtomic(followupPath,result.followup);
result.followup.vintageArchive=read(folder+'/research-alfred.json',{status:'not_configured',note:'未配置ALFRED历史版本；前瞻跟踪采用实际留存快照。'});
result.valuation=buildValuations(industry,market,{asOf:localAsOf,previous:previous?.valuation,recordedAt:now});
result.robustness=buildResearchRobustness(calculationInputs,{inputHash});
result.validation=buildResearchValidation(evolution.records,result.followup,{asOf:localAsOf,registeredAt:previous?.validation?.registeredAt??now});
result.attention=buildResearchWatchlist({ledger:evolution.records,signals:packet.quantitative.sectorSignals,industry,valuation:result.valuation,robustness:result.robustness},{asOf:localAsOf});
result.crossCompany=buildCrossCompanyComparison(industry,{asOf:localAsOf});
result.modelEvaluation=buildModelEvaluation({model,analysis,packet,calls});
if(result.modelEvaluation.contract.status!=='passed')throw Error('模型接口验收题未通过，停止发布本次研究数据');
writeJsonAtomic(ledgerPath,evolution.records);
const immutableInput={schemaVersion:'3',inputHash,createdAt:now,inputs,dataCutoffs,packet:publicPacket,calculationInputs,observationManifest,calculationInputHash:hash(calculationInputs)};
mkdirSync(inputsFolder,{recursive:true});
if(!existsSync(`${inputsFolder}/${inputHash}.json`))writeJsonAtomic(`${inputsFolder}/${inputHash}.json`,immutableInput);
const historyEntry={inputHash,generatedAt:now,inputs,dataCutoffs,model:{status:model.status,model:model.model,promptVersion:model.promptVersion,lastSuccessfulAt:model.lastSuccessfulAt,outputHash:model.outputHash},analysis:{origin:analysis.origin,overallStance:analysis.overallStance,marketRegime:analysis.marketRegime,confidence:analysis.confidence,summary:analysis.summary}};
const previousHistory=Array.isArray(history)?history:[];
// An unchanged recheck cannot move the historical signal's first-known time.
writeJsonAtomic(historyPath,previousHistory.some(entry=>entry.inputHash===inputHash)?previousHistory:[...previousHistory,historyEntry]);
writeJsonAtomic(output,result);
console.log(`Investment research: ${model.status}; ${packet.quantitative.sectorSignals.length} industry targets; ${packet.inputCoverage.industryMetricCount} industry metrics; input ${inputHash.slice(0,12)}.`);
if(activationRequested&&!['ready','cached'].includes(model.status)){console.error(`真实推理未通过：${model.errorCode??model.status}；${model.action??model.error??'请检查后台诊断。'}`);process.exitCode=1;}
