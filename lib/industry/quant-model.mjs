import {dimensionNames,metricStats,chartRows,targets} from './engine.mjs';

// This is an industry research signal, not an expected-return or security-ranking model.
export const QUANT_MODEL_VERSION='industry-evidence-factor-2.3.0';
export const factorWeights={demand:.32,profitability:.24,investment:.16,construction:.16,costs:.12};
export const quantModelDefinition={
 id:'industry_evidence_factor',
 version:QUANT_MODEL_VERSION,
 scoreRange:'-100 to +100',
 horizon:'未来 1—2 个季度',
 scoreMeaning:'产业直接证据与宏观风险环境的研究信号，不是预期收益率、胜率或个股交易指令。',
 scoringTiers:{
  formal:'正式评分要求全部目标因子具备可评分的直接证据与连续历史。',
  leading:'先行研究信号使用已接入的直接证据与明确标注的代理数据；缺失因子不填零、不视为中性，也不替代正式评分。'
 },
 factorWeights
};

const stateValue={positive:1,neutral:0,negative:-1,missing:null};
const directionValue={positive:1,neutral:0,negative:-1};
const sourceReliability={reported:1,official:1,calculated:.85,project_announcement:.8,proxy:.65,guidance:0,third_party:0,demo:0};
const formalEvidenceTypes=new Set(['reported','official','calculated','project_announcement']);
const cadenceDays={daily:7,monthly:31,quarterly:92,annual:366,event:0};
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const unique=items=>[...new Set(items.filter(Boolean))];
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const median=values=>{const sorted=[...values].filter(numeric).sort((a,b)=>a-b);if(!sorted.length)return null;const center=Math.floor(sorted.length/2);return sorted.length%2?sorted[center]:(sorted[center-1]+sorted[center])/2;};
const targetFor=id=>targets.find(target=>target.id===id);
const directionOf=item=>directionValue[item?.direction]??0;
const evidenceItems=recommendation=>[...(recommendation?.positiveEvidence??[]),...(recommendation?.negativeEvidence??[]),...(recommendation?.neutralEvidence??[])];
const validObservations=series=>(series?.observations??[]).filter(point=>numeric(point?.value));
const leadingOnlyDefinition=definition=>definition?.valueType==='proxy'||definition?.directness==='project_sample'||definition?.scoringTier==='leading_only';
const directFormalDefinition=definition=>formalEvidenceTypes.has(definition?.valueType)&&definition?.recommendationEligible!==false&&!leadingOnlyDefinition(definition);

function historicalStrength(definition,series){
 // Evaluate a recent, fixed comparison window.  A repaired recent history must
 // not remain blocked forever by a gap outside that window; missing periods
 // inside it remain explicit and cannot satisfy the minimum observation count.
 const isReportedRate=['cloud_growth','capex_growth','semiconductor_growth'].includes(definition.family);
 const requiredObservationCount=definition.frequency==='monthly'&&!isReportedRate?16:8;
 const rows=chartRows(definition,series?.observations??[],{range:'all',mode:'value',frequency:definition.frequency});
 const window=rows.slice(-requiredObservationCount);
 const observations=window.filter(point=>numeric(point?.value));
 const missingPeriods=window.filter(point=>!numeric(point?.value)).map(point=>point.periodEnd);
 const diagnostics={observationCount:observations.length,requiredObservationCount,expectedPeriodCount:window.length,missingPeriods,windowStart:window[0]?.periodEnd??null,windowEnd:window.at(-1)?.periodEnd??null,comparisonObservationCount:0};
 if(observations.length<4)return {strength:null,basis:'not_scored',...diagnostics};
 // This is historical normalization, not a point-in-time performance backtest.
 // The immutable calculation input records the exact vintage used for each run.
 const values=[];
 for(let index=0;index<window.length;index++){
  const stats=metricStats(definition,window.slice(0,index+1));
  if(numeric(stats.yoy))values.push(stats.yoy);
 }
 diagnostics.comparisonObservationCount=values.length;
 if(observations.length<requiredObservationCount||values.length<4||missingPeriods.length)return {strength:.45,basis:'directional_early',...diagnostics};
 const current=values.at(-1),history=values.slice(0,-1),center=median(history);
 const mad=center==null?null:median(history.map(value=>Math.abs(value-center)));
 // Normalize in the direction of the observed growth, then apply the approved
 // rule direction outside this function (costs can be inverse).  Taking abs(z)
 // would incorrectly strengthen a positive signal when growth sharply slows.
 // These scales are transparent rules, not fitted return-prediction parameters.
 const aligned=mad!=null&&mad>.000001?Math.sign(current||1)*(current-center)/(1.4826*mad):Math.abs(current)>Math.abs(center??0)?.7:.3;
 return {strength:clamp(Math.max(.1,aligned/3),.1,1),basis:'normalized_history',...diagnostics};
}

function groupedFactorEvidence(recommendation,dimension,definitions,series){
 const groups=new Map();
 for(const item of evidenceItems(recommendation).filter(item=>item.dimension===dimension)){
  const definition=definitions.get(item.metricId);if(!definition)continue;
  const history=historicalStrength(definition,series?.[item.metricId]);
  // Monthly and quarterly company totals describe the same issuer revenue;
  // named business-segment revenues retain their separate family and scope.
  const canonicalFamily=['company_revenue','revenue'].includes(definition.family)?'company_total_revenue':['company_gross_margin','gross_margin'].includes(definition.family)?'company_gross_margin':definition.family??item.metricId;
  const groupKey=`${definition.entity??'industry'}|${canonicalFamily}`;
  const candidate={metricId:item.metricId,direction:directionOf(item),strength:history.strength,basis:history.basis,observationCount:history.observationCount,history,sourceQuality:sourceReliability[definition.valueType]??0,formalEligible:directFormalDefinition(definition),leadingOnly:leadingOnlyDefinition(definition),entity:definition.entity??'industry'};
  const current=groups.get(groupKey);
  // Duplicate observations from one entity / indicator family never add weight.
  const candidateMagnitude=Math.abs((candidate.strength??0)*candidate.direction),currentMagnitude=Math.abs((current?.strength??0)*current?.direction);
  if(!current||(candidate.formalEligible&&!current.formalEligible)||(candidate.formalEligible===current.formalEligible&&candidateMagnitude>currentMagnitude))groups.set(groupKey,candidate);
 }
 return [...groups.values()];
}

function validUntil(recommendation,definitions,series){
 const dates=[];
 for(const item of evidenceItems(recommendation)){
  const definition=definitions.get(item.metricId);
  const observation=(series?.[item.metricId]?.observations??[]).find(point=>point.periodEnd===item.periodEnd&&String(point.version)===String(item.observationVersion));
  const publicationBased=definition?.freshnessBasis==='source_publication';
  const end=Date.parse(String(publicationBased?observation?.publishedAt??'':item.periodEnd??''));
  if(!definition||!Number.isFinite(end))continue;
  const duration=(cadenceDays[publicationBased?definition.sourceReleaseFrequency:definition.frequency]??0)+(publicationBased?definition.sourceReleaseDelayDays??60:definition.normalUpdateDelayDays??60);
  dates.push(new Date(end+duration*86400000).toISOString().slice(0,10));
 }
 return dates.sort().at(0)??null;
}

function macroComponent(signal,{weight,scale,label}){
 if(!signal||signal.reasoningRole!=='available_context'||!numeric(signal.change))return {id:signal?.id??label,label,weight,score:0,status:'excluded',reason:signal?.exclusionReason??'尚无有效比较基期'};
 const normalized=clamp(-signal.change/scale,-1,1);
 return {id:signal.id,label,weight,score:Number((normalized*weight*10).toFixed(1)),status:'included',change:signal.change,changeUnit:signal.changeUnit,latestDate:signal.latestDate};
}

export function buildMacroOverlay(macroSignals=[]){
 const byId=new Map(macroSignals.map(signal=>[signal.id,signal]));
 const components=[
  macroComponent(byId.get('DFII10'),{label:'实际收益率',weight:.45,scale:.25}),
  macroComponent(byId.get('NFCI'),{label:'金融条件',weight:.35,scale:.12}),
  macroComponent(byId.get('PCEPILFE'),{label:'核心 PCE',weight:.20,scale:.75})
 ];
 const included=components.filter(component=>component.status==='included');
 const score=included.length>=2?Math.round(clamp(components.reduce((sum,component)=>sum+component.score,0),-10,10)):0;
 return {score,components,applied:included.length>=2,reason:included.length>=2?'仅作为风险环境调整，不能替代产业需求、盈利或建设证据。':'有效宏观因子不足两项，未应用风险环境调整。',excluded:['初请失业金具有政策与需求的双向传导，保留为背景观察，不进入单向评分。']};
}

function leadingBand(score){
 if(score==null)return '先行研究未形成';
 if(score>=30)return '较强先行信号';
 if(score>=10)return '温和先行信号';
 if(score>-10)return '先行信号分化';
 if(score>-30)return '温和先行压力';
 return '较强先行压力';
}

function leadingQuality(factorCoverage,historyQuality){
 if(factorCoverage>=.8&&historyQuality>=.75)return '较完整先行样本';
 if(factorCoverage>=.65)return '有限先行样本';
 return '探索性先行样本';
}

// A leading signal is intentionally separate from the formal score. It can help
// prioritise research while a project / capacity series is being built, but it
// never treats an unobserved factor as zero or as a neutral observation.
function buildLeadingSignal({recommendation,target,factorContributions,macroOverlay,formalScore}){
 const requiredFactorCount=factorContributions.length;
 const included=factorContributions.filter(factor=>factor.contribution!=null);
 const omitted=factorContributions.filter(factor=>factor.contribution==null);
 const factorCoverage=included.reduce((sum,factor)=>sum+factor.weight,0);
 const demand=factorContributions.find(factor=>factor.id==='demand');
 const requiresDemand=factorContributions.some(factor=>factor.id==='demand');
 const requiredDemandEntityCount=requiresDemand?(target?.minimumDemandEntities??1):0;
 const directDemandEntityCount=requiresDemand?(demand?.directEntityCount??0):0;
 // Broad order and construction proxies cannot manufacture the company / issuer
 // breadth required for a leading demand conclusion.
 const hasRequiredDemand=!requiresDemand||(demand?.contribution!=null&&directDemandEntityCount>=requiredDemandEntityCount);
 const disabled=Boolean(target?.disabledReason);
 const hasMinimumBreadth=included.length>=Math.min(2,requiredFactorCount)&&factorCoverage>=.5;
 const historicalQuality=factorCoverage>0?included.reduce((sum,factor)=>sum+factor.historyQuality*factor.weight,0)/factorCoverage:0;
 const status=formalScore!=null?'not_needed':disabled?'disabled':hasMinimumBreadth&&hasRequiredDemand?'available':'insufficient_evidence';
 const includedNames=included.map(factor=>factor.name);
 const omittedNames=omitted.map(factor=>factor.name);
 const proxyFactorNames=included.filter(factor=>(factor.leadingOnlyMetricIds??[]).length>0).map(factor=>factor.name);
 const sourceBoundary=proxyFactorNames.length?`其中 ${proxyFactorNames.join('、')} 包含广义代理或项目样本，只能用于先行观察，不能替代项目、订单或公司直接证据。`:'';
 const demandBoundary=requiresDemand&&!hasRequiredDemand?`实际需求的直接证据覆盖 ${directDemandEntityCount}/${requiredDemandEntityCount} 个独立主体，尚不足以形成该环节的先行研究信号。`:'';
 const limitation=disabled?target.disabledReason:omittedNames.length?`未覆盖 ${omittedNames.join('、')}；这些因子未被填零或视为中性。${sourceBoundary}${demandBoundary}`:`仍需完成正式评分所要求的连续历史与核验。${sourceBoundary}${demandBoundary}`;
 if(status!=='available')return {
  status,score:null,fundamentalScore:null,scoreBand:leadingBand(null),quality:'先行样本不足',factorCoverageScore:Math.round(factorCoverage*100),historyQualityScore:Math.round(historicalQuality*100),availableFactorCount:included.length,requiredFactorCount,includedFactorIds:included.map(factor=>factor.id),omittedFactorIds:omitted.map(factor=>factor.id),directDemandEntityCount,requiredDemandEntityCount,reason:disabled?'该环节尚无足以形成先行研究信号的直接证据。':demandBoundary||'可用直接证据不足两类、覆盖不足 50%，或缺少实际需求维度。',limitation,action:'继续核验并补齐直接证据，不生成先行研究信号。'
 };
 const observedSignal=included.reduce((sum,factor)=>sum+(factor.contribution??0),0)/factorCoverage;
 // Shrink the displayed magnitude when coverage or history is incomplete, so
 // the same observed direction cannot look as certain as a formal score.
 const coverageScale=.55+factorCoverage*.45;
 const historyScale=.55+historicalQuality*.45;
 const fundamentalScore=Math.round(clamp(observedSignal*coverageScale*historyScale,-100,100));
 const score=Math.round(clamp(fundamentalScore+(macroOverlay.applied?macroOverlay.score:0),-100,100));
 return {
  status,score,fundamentalScore,scoreBand:leadingBand(score),quality:leadingQuality(factorCoverage,historicalQuality),factorCoverageScore:Math.round(factorCoverage*100),historyQualityScore:Math.round(historicalQuality*100),availableFactorCount:included.length,requiredFactorCount,includedFactorIds:included.map(factor=>factor.id),omittedFactorIds:omitted.map(factor=>factor.id),directDemandEntityCount,requiredDemandEntityCount,reason:`仅按已接入的 ${includedNames.join('、')} 计算；正式评分尚未满足完整证据门槛。${sourceBoundary}`,limitation,action:'先行研究：用于决定后续研究优先级；补齐缺失因子并形成连续历史后再复核正式评分。'
 };
}

function researchReadiness({target,factors,formalScore,leadingSignal,reviewAt}){
 const blockers=[];
 const factorReadiness=factors.map(factor=>{
  const diagnostics=factor.metricDiagnostics??[];
  const direct=diagnostics.filter(item=>item.formalEligible);
  const normalized=direct.filter(item=>item.basis==='normalized_history');
  const status=factor.formalContribution!=null?'ready':direct.length?'insufficient_history':'missing_direct_evidence';
  if(status==='missing_direct_evidence')blockers.push({code:diagnostics.length?'directness':'missing_evidence',factorId:factor.id,metricIds:factor.metricIds,actual:direct.length,required:1,remedy:`补齐${factor.name}的可追溯直接观测；广义代理、项目样本及预测不能替代。`});
  if(status==='insufficient_history'){
   const history=direct.map(item=>item.history).sort((a,b)=>b.observationCount-a.observationCount)[0];
   blockers.push({code:history.missingPeriods.length?'history_gap':'short_history',factorId:factor.id,metricIds:direct.map(item=>item.metricId),actual:history.observationCount,required:history.requiredObservationCount,remedy:`补齐最近可比窗口的${history.requiredObservationCount}期直接观测及至少4个同比比较点；${history.missingPeriods.length?`缺期：${history.missingPeriods.join('、')}。`:'当前历史不足。'}`});
  }
  return {factorId:factor.id,name:factor.name,status,metricIds:factor.metricIds,directMetricIds:direct.map(item=>item.metricId),normalizedMetricIds:normalized.map(item=>item.metricId),histories:diagnostics.map(item=>({metricId:item.metricId,formalEligible:item.formalEligible,basis:item.basis,...item.history}))};
 });
 const demand=factors.find(factor=>factor.id==='demand');
 const requiredDemandEntityCount=demand?(target?.minimumDemandEntities??1):0;
 const directDemandEntityCount=demand?.directEntityCount??0;
 const formalDemandEntityCount=demand?.formalEntityCount??0;
 if(requiredDemandEntityCount>formalDemandEntityCount)blockers.push({code:'demand_breadth',factorId:'demand',metricIds:demand?.formalMetricIds??[],actual:formalDemandEntityCount,required:requiredDemandEntityCount,remedy:`需要至少${requiredDemandEntityCount}个独立主体的直接需求及连续历史；当前直接主体${directDemandEntityCount}个，其中符合正式历史门槛${formalDemandEntityCount}个。`});
 if(target?.disabledReason)blockers.push({code:'target_scope',factorId:null,metricIds:[],actual:0,required:1,remedy:target.disabledReason});
 return {stage:formalScore!=null?'formal_research':leadingSignal.status==='available'?'leading_research':'needs_evidence',blockers,factors:factorReadiness,directDemandEntityCount,formalDemandEntityCount,requiredDemandEntityCount,nextReviewAt:reviewAt,investmentValidation:'not_started',investmentValidationReason:'尚未完成证券价格、估值、当时已知数据、交易成本及样本外回测；研究信号未被验证为可交易策略。'};
}

export function buildQuantitativeSignal(recommendation,{definitions=[],series={},macroSignals=[]}={}){
 const definitionMap=definitions instanceof Map?definitions:new Map(definitions.map(definition=>[definition.id,definition]));
 const target=targetFor(recommendation.targetId);
 const required=target?.required??(recommendation.dimensions??[]).filter(dimension=>dimension.state!=='missing').map(dimension=>dimension.id);
 const totalWeight=required.reduce((sum,id)=>sum+(factorWeights[id]??0),0)||1;
 const dimensions=new Map((recommendation.dimensions??[]).map(dimension=>[dimension.id,dimension]));
 const factorContributions=required.map(id=>{
  const dimension=dimensions.get(id)??{id,name:dimensionNames[id]??id,state:'missing',metricIds:[]};
  const grouped=groupedFactorEvidence(recommendation,id,definitionMap,series);
  const scored=grouped.filter(item=>item.strength!=null);
  // Formal factors use only source-bound direct evidence with a normalized
  // history.  Direct but shorter histories stay visible as leading evidence.
  const directScored=scored.filter(item=>item.formalEligible);
  const formalScored=directScored.filter(item=>item.basis==='normalized_history');
  const signed=scored.map(item=>item.direction*(item.strength??0));
  const formalSigned=formalScored.map(item=>item.direction*(item.strength??0));
  const signal=median(signed);
  const formalSignal=median(formalSigned);
  const weight=(factorWeights[id]??0)/totalWeight;
  const contribution=signal==null?null:Number((signal*weight*100).toFixed(1));
  const formalContribution=formalSignal==null?null:Number((formalSignal*weight*100).toFixed(1));
  const entityCount=new Set(scored.map(item=>item.entity)).size;
  const directEntityCount=new Set(directScored.map(item=>item.entity)).size;
  const formalEntityCount=new Set(formalScored.map(item=>item.entity)).size;
  const historyQuality=scored.length?scored.reduce((sum,item)=>sum+(item.basis==='normalized_history'?1:item.basis==='directional_early'?.55:0),0)/scored.length:0;
  const metricDiagnostics=grouped.map(item=>({metricId:item.metricId,formalEligible:item.formalEligible,basis:item.basis,history:item.history}));
  return {id,name:dimensionNames[id]??dimension.name??id,state:dimension.state,weight:Number(weight.toFixed(4)),signal:signal==null?null:Number(signal.toFixed(3)),formalSignal:formalSignal==null?null:Number(formalSignal.toFixed(3)),contribution,formalContribution,metricIds:unique(grouped.map(item=>item.metricId)),formalMetricIds:unique(formalScored.map(item=>item.metricId)),leadingOnlyMetricIds:unique(grouped.filter(item=>item.leadingOnly).map(item=>item.metricId)),sourceGroupCount:grouped.length,directSourceGroupCount:directScored.length,formalSourceGroupCount:formalScored.length,entityCount,directEntityCount,formalEntityCount,historyQuality:Number(historyQuality.toFixed(2)),basis:scored.length===0?'not_scored':scored.every(item=>item.basis==='normalized_history')?'normalized_history':'directional_early',metricDiagnostics};
 });
 const formalCoverage=Number.isFinite(recommendation.formalCoverage)?recommendation.formalCoverage:recommendation.coverage;
 const demandFactor=factorContributions.find(factor=>factor.id==='demand');
 const requiredDemandEntities=target?.minimumDemandEntities??0;
 const formalDemandBreadth=Math.min(1,(demandFactor?.formalEntityCount??0)/Math.max(1,requiredDemandEntities));
 const gatePassed=recommendation.level!=='insufficient_data'&&recommendation.coverage>=1&&formalCoverage>=1&&factorContributions.every(factor=>factor.formalContribution!=null)&&(!demandFactor||requiredDemandEntities===0||(demandFactor.formalEntityCount??0)>=requiredDemandEntities);
 const fundamentalRaw=factorContributions.reduce((sum,factor)=>sum+(factor.formalContribution??0),0);
 const positive=factorContributions.filter(factor=>(factor.formalContribution??0)>0).length;
 const negative=factorContributions.filter(factor=>(factor.formalContribution??0)<0).length;
 const conflictAdjustment=positive&&negative?-Math.sign(fundamentalRaw||1)*Math.min(12,(positive+negative)*3):0;
 const fundamentalScore=gatePassed?Math.round(clamp(fundamentalRaw+conflictAdjustment,-100,100)):null;
 const macroOverlay=buildMacroOverlay(macroSignals);
 const score=fundamentalScore==null?null:Math.round(clamp(fundamentalScore+(macroOverlay.applied?macroOverlay.score:0),-100,100));
 const allGroups=factorContributions.flatMap(factor=>factor.formalMetricIds);
 const sourceQuality=allGroups.length?allGroups.reduce((sum,id)=>sum+(sourceReliability[definitionMap.get(id)?.valueType]??0),0)/allGroups.length:0;
 const historyQuality=factorContributions.length?factorContributions.filter(factor=>factor.formalContribution!=null).length/factorContributions.length:0;
 const dataQualityScore=Math.round(clamp(formalCoverage*45+historyQuality*25+formalDemandBreadth*20+sourceQuality*10,0,100));
 const excludedMetricIds=unique([...recommendation.missingMetrics??[],...evidenceItems(recommendation).filter(item=>validObservations(series?.[item.metricId]).length<4).map(item=>item.metricId)]);
 const hasLeadingOnlySource=factorContributions.some(factor=>factor.contribution!=null&&(factor.leadingOnlyMetricIds??[]).length>0&&(factor.formalContribution==null));
 const hasDirectButShortHistory=factorContributions.some(factor=>(factor.directSourceGroupCount??0)>0&&factor.formalContribution==null);
 const scoringGate=gatePassed?'passed':hasLeadingOnlySource?'blocked_by_directness':hasDirectButShortHistory?'blocked_by_history':recommendation.level==='insufficient_data'?'blocked_by_evidence':'blocked_by_history';
 const calibration=gatePassed?'history_normalized':factorContributions.some(factor=>factor.basis!=='not_scored')?'early_signal':'not_scored';
 const scoreBand=score==null?'正式评分待验证':score>=45?'正向研究信号':score>=15?'轻度正向研究信号':score>-15?'中性研究信号':score>-45?'轻度负向研究信号':'负向研究信号';
 const confidenceReason=`正式直接证据覆盖 ${Math.round(formalCoverage*100)}%；先行研究覆盖 ${Math.round(recommendation.coverage*100)}%；历史质量 ${Math.round(historyQuality*100)}%；实际需求直接覆盖 ${demandFactor?(demandFactor.directEntityCount??0):0}/${requiredDemandEntities} 个主体；来源质量 ${Math.round(sourceQuality*100)}%。`;
 const leadingSignal=buildLeadingSignal({recommendation,target,factorContributions,macroOverlay,formalScore:score});
 const reviewAt=validUntil(recommendation,definitionMap,series);
 const readiness=researchReadiness({target,factors:factorContributions,formalScore:score,leadingSignal,reviewAt});
 return {score,fundamentalScore,macroOverlay,factorContributions,leadingSignal,readiness,coverageScore:Math.round(recommendation.coverage*100),formalCoverageScore:Math.round(formalCoverage*100),dataQualityScore,scoringGate,calibration,scoreBand,confidenceReason,excludedMetricIds,validUntil:reviewAt,factorModelVersion:QUANT_MODEL_VERSION};
}
