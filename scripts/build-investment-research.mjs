import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {buildFallbackAnalysis,buildResearchPacket,modelJsonSchema,modelPrompt,RESEARCH_PROMPT_VERSION,validateModelAnalysis} from '../lib/industry/research.mjs';
import {researchCheckpoint,appendCheckpoint,compareCheckpoints} from '../lib/industry/research-evolution.mjs';
import {buildTracking} from '../lib/industry/research-tracking.mjs';
import {buildValuations} from '../lib/industry/valuation.mjs';

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
const configuredModel=process.env.REASONING_MODEL?.trim()||'gpt-5-mini';
const key=process.env.OPENAI_API_KEY?.trim();
const packet=buildResearchPacket(industry,macro,macroDefinitions,policyRates,policyDecisions);
// Archive the complete vintage for recomputation, while the website and model
// receive only the compact evidence packet. A background check timestamp alone
// must not invalidate an otherwise identical model input.
const {calculationInputs,observationManifest,...publicPacket}=packet;
const inputHash=hash({promptVersion:RESEARCH_PROMPT_VERSION,model:configuredModel,packet:publicPacket});
const inputs={industry:{version:snapshotVersion(industry),generatedAt:industry.generatedAt??null},macro:{version:snapshotVersion(macro),generatedAt:macro.generatedAt??null},policyRates:{version:snapshotVersion(policyRates),generatedAt:policyRates.generatedAt??null},policyDecisions:{version:snapshotVersion(policyDecisions),generatedAt:policyDecisions.generatedAt??null}};
const cutoffOf=items=>items.filter(Boolean).sort().at(-1)??null;
const dataCutoffs={industry:cutoffOf(packet.quantitative.sectorSignals.map(signal=>signal.dataCutoffAt)),macro:cutoffOf(packet.macroSignals.map(signal=>signal.latestDate)),policy:cutoffOf(packet.policyRateSignals.map(signal=>signal.latestDate)),projects:cutoffOf(packet.fullSiteContext.projects.records.map(project=>project.latestEventDate))};

function safeError(error){const text=String(error?.message??error).replace(/[\r\n]+/g,' ');return (key?text.replaceAll(key,'[redacted]'):text).slice(0,220);}
function outputText(payload){
 if(typeof payload?.output_text==='string')return payload.output_text;
 for(const item of payload?.output??[])for(const content of item?.content??[])if(typeof content?.text==='string')return content.text;
 throw Error('模型响应中没有结构化文本');
}
async function requestModel(){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),45000);
 try{
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:configuredModel,instructions:'输出简体中文的结构化产业研究结论。只能解释已验证数据，遵守所有 JSON Schema 与个股边界。',input:modelPrompt(packet),max_output_tokens:3200,text:{format:modelJsonSchema(packet)}})});
  if(!response.ok)throw Error(`模型请求失败 HTTP ${response.status}`);
  const payload=await response.json();
  return {raw:JSON.parse(outputText(payload)),requestId:payload?._request_id??payload?.id??null};
 }finally{clearTimeout(timer);}
}

const now=new Date().toISOString();
const localAsOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
let analysis=buildFallbackAnalysis(packet);
let model={status:'not_configured',provider:'OpenAI Responses API',model:configuredModel,promptVersion:RESEARCH_PROMPT_VERSION,generatedAt:null,lastSuccessfulAt:previous?.model?.lastSuccessfulAt??null,checkedAt:now,requestId:null,cacheReason:null,error:null,outputHash:null};
const sameInput=previous?.inputHash===inputHash;
const reusableModel=sameInput&&previous?.analysis?.origin==='model'&&['ready','cached'].includes(previous?.model?.status);
if(key){
 if(reusableModel){
  analysis=previous.analysis;
  model={...previous.model,status:'cached',checkedAt:now,cacheReason:'unchanged_input',error:null};
 }else{
  let response;
  try{response=await requestModel();}
  catch(error){
   if(sameInput&&previous?.analysis?.origin==='model'){
    analysis=previous.analysis;
    model={...previous.model,status:'cached',checkedAt:now,cacheReason:'request_failed',error:safeError(error)};
   }else model={...model,status:'fetch_failed',error:safeError(error)};
  }
  if(response){
   try{
    analysis=validateModelAnalysis(response.raw,packet);
    model={...model,status:'ready',generatedAt:now,lastSuccessfulAt:now,requestId:response.requestId,outputHash:hash(analysis)};
   }catch(error){model={...model,status:'rejected',requestId:response.requestId,error:safeError(error)};}
  }
 }
}
const result={schemaVersion:'2',generatedAt:now,inputHash,inputs,dataCutoffs,model,quantitative:packet.quantitative,evidence:{macroSignals:packet.macroSignals,policyRateSignals:packet.policyRateSignals,institutionalReports:packet.institutionalReports,sourceRefs:packet.sourceRefs,dataGaps:packet.dataGaps,inputCoverage:packet.inputCoverage,guardrails:packet.guardrails,inputSnapshot:publicPacket},analysis};
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
result.valuation=buildValuations(industry,market,{asOf:localAsOf});
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
