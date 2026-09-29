import {dimensionNames,metricStats,targets} from './engine.mjs';

// This is an industry research signal, not an expected-return or security-ranking model.
export const QUANT_MODEL_VERSION='industry-evidence-factor-2.0.0';
export const factorWeights={demand:.32,profitability:.24,investment:.16,construction:.16,costs:.12};
export const quantModelDefinition={
 id:'industry_evidence_factor',
 version:QUANT_MODEL_VERSION,
 scoreRange:'-100 to +100',
 horizon:'未来 1—2 个季度',
 scoreMeaning:'产业直接证据与宏观风险环境的研究信号，不是预期收益率、胜率或个股交易指令。',
 factorWeights
};

const stateValue={positive:1,neutral:0,negative:-1,missing:null};
const directionValue={positive:1,neutral:0,negative:-1};
const sourceReliability={reported:1,official:1,calculated:.85,project_announcement:.8,proxy:.65,guidance:0,third_party:0,demo:0};
const cadenceDays={daily:7,monthly:31,quarterly:92,annual:366,event:0};
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const unique=items=>[...new Set(items.filter(Boolean))];
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const median=values=>{const sorted=[...values].filter(numeric).sort((a,b)=>a-b);if(!sorted.length)return null;const center=Math.floor(sorted.length/2);return sorted.length%2?sorted[center]:(sorted[center-1]+sorted[center])/2;};
const targetFor=id=>targets.find(target=>target.id===id);
const directionOf=item=>directionValue[item?.direction]??0;
const evidenceItems=recommendation=>[...(recommendation?.positiveEvidence??[]),...(recommendation?.negativeEvidence??[]),...(recommendation?.neutralEvidence??[])];
const validObservations=series=>(series?.observations??[]).filter(point=>numeric(point?.value));

function historicalStrength(definition,series){
 const observations=validObservations(series);
 if(observations.length<4)return {strength:null,basis:'not_scored',observationCount:observations.length};
 // Build each historical YoY observation from data available at that observation date.
 const values=[];
 for(let index=0;index<observations.length;index++){
  const stats=metricStats(definition,observations.slice(0,index+1));
  if(numeric(stats.yoy))values.push(stats.yoy);
 }
 if(observations.length<8||values.length<4)return {strength:.45,basis:'directional_early',observationCount:observations.length};
 const current=values.at(-1),history=values.slice(0,-1),center=median(history);
 const mad=center==null?null:median(history.map(value=>Math.abs(value-center)));
 // A robust magnitude is used only to scale a rule-approved direction.  It never
 // changes that direction, which remains controlled by the direct-evidence engine.
 const robust=mad!=null&&mad>.000001?Math.abs((current-center)/(1.4826*mad)):Math.abs(current)>Math.abs(center??0)?.7:.3;
 return {strength:clamp(Math.max(.25,robust/3),.25,1),basis:'normalized_history',observationCount:observations.length};
}

function groupedFactorEvidence(recommendation,dimension,definitions,series){
 const groups=new Map();
 for(const item of evidenceItems(recommendation).filter(item=>item.dimension===dimension)){
  const definition=definitions.get(item.metricId);if(!definition)continue;
  const history=historicalStrength(definition,series?.[item.metricId]);
  const groupKey=`${definition.entity??'industry'}|${definition.family??item.metricId}`;
  const candidate={metricId:item.metricId,direction:directionOf(item),strength:history.strength,basis:history.basis,observationCount:history.observationCount,sourceQuality:sourceReliability[definition.valueType]??0,entity:definition.entity??'industry'};
  const current=groups.get(groupKey);
  // Duplicate observations from one entity / indicator family never add weight.
  if(!current||Math.abs((candidate.strength??0)*candidate.direction)>Math.abs((current.strength??0)*current.direction))groups.set(groupKey,candidate);
 }
 return [...groups.values()];
}

function validUntil(recommendation,definitions){
 const dates=[];
 for(const item of evidenceItems(recommendation)){
  const definition=definitions.get(item.metricId);const end=Date.parse(String(item.periodEnd??''));
  if(!definition||!Number.isFinite(end))continue;
  const duration=(cadenceDays[definition.frequency]??0)+(definition.normalUpdateDelayDays??60);
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
  const signed=scored.map(item=>item.direction*(item.strength??0));
  const signal=median(signed);
  const weight=(factorWeights[id]??0)/totalWeight;
  const contribution=signal==null?null:Number((signal*weight*100).toFixed(1));
  const entityCount=new Set(scored.map(item=>item.entity)).size;
  const historyQuality=scored.length?scored.reduce((sum,item)=>sum+(item.basis==='normalized_history'?1:item.basis==='directional_early'?.55:0),0)/scored.length:0;
  return {id,name:dimensionNames[id]??dimension.name??id,state:dimension.state,weight:Number(weight.toFixed(4)),signal:signal==null?null:Number(signal.toFixed(3)),contribution,metricIds:unique(grouped.map(item=>item.metricId)),sourceGroupCount:grouped.length,entityCount,historyQuality:Number(historyQuality.toFixed(2)),basis:scored.length===0?'not_scored':scored.every(item=>item.basis==='normalized_history')?'normalized_history':'directional_early'};
 });
 const gatePassed=recommendation.level!=='insufficient_data'&&recommendation.coverage>=1&&factorContributions.every(factor=>factor.contribution!=null);
 const fundamentalRaw=factorContributions.reduce((sum,factor)=>sum+(factor.contribution??0),0);
 const positive=factorContributions.filter(factor=>(factor.signal??0)>0).length;
 const negative=factorContributions.filter(factor=>(factor.signal??0)<0).length;
 const conflictAdjustment=positive&&negative?-Math.sign(fundamentalRaw||1)*Math.min(12,(positive+negative)*3):0;
 const fundamentalScore=gatePassed?Math.round(clamp(fundamentalRaw+conflictAdjustment,-100,100)):null;
 const macroOverlay=buildMacroOverlay(macroSignals);
 const score=fundamentalScore==null?null:Math.round(clamp(fundamentalScore+(macroOverlay.applied?macroOverlay.score:0),-100,100));
 const allGroups=factorContributions.flatMap(factor=>factor.metricIds);
 const sourceQuality=allGroups.length?allGroups.reduce((sum,id)=>sum+(sourceReliability[definitionMap.get(id)?.valueType]??0),0)/allGroups.length:0;
 const historyQuality=factorContributions.length?factorContributions.reduce((sum,factor)=>sum+factor.historyQuality,0)/factorContributions.length:0;
 const demandFactor=factorContributions.find(factor=>factor.id==='demand');
 const requiredDemandEntities=target?.minimumDemandEntities??1;
 const breadth=Math.min(1,(demandFactor?.entityCount??0)/Math.max(1,requiredDemandEntities));
 const dataQualityScore=Math.round(clamp(recommendation.coverage*45+historyQuality*25+breadth*20+sourceQuality*10,0,100));
 const excludedMetricIds=unique([...recommendation.missingMetrics??[],...evidenceItems(recommendation).filter(item=>validObservations(series?.[item.metricId]).length<4).map(item=>item.metricId)]);
 const scoringGate=gatePassed?'passed':recommendation.level==='insufficient_data'?'blocked_by_evidence':'blocked_by_history';
 const calibration=factorContributions.every(factor=>factor.basis==='normalized_history')?'calibrated':factorContributions.some(factor=>factor.basis!=='not_scored')?'early_signal':'not_scored';
 const scoreBand=score==null?'评分暂停':score>=45?'正向研究信号':score>=15?'轻度正向研究信号':score>-15?'中性研究信号':score>-45?'轻度负向研究信号':'负向研究信号';
 const confidenceReason=`覆盖 ${Math.round(recommendation.coverage*100)}%；历史质量 ${Math.round(historyQuality*100)}%；需求实体覆盖 ${Math.round(breadth*100)}%；来源质量 ${Math.round(sourceQuality*100)}%。`;
 return {score,fundamentalScore,macroOverlay,factorContributions,coverageScore:Math.round(recommendation.coverage*100),dataQualityScore,scoringGate,calibration,scoreBand,confidenceReason,excludedMetricIds,validUntil:validUntil(recommendation,definitionMap),factorModelVersion:QUANT_MODEL_VERSION};
}
