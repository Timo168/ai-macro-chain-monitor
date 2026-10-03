import {dimensionNames,ruleReachability,metricStats} from './engine.mjs';
import {buildQuantitativeSignal,quantModelDefinition,QUANT_MODEL_VERSION} from './quant-model.mjs';

export const RESEARCH_SCORE_VERSION=`research-2.1.0 / ${QUANT_MODEL_VERSION}`;
export const RESEARCH_PROMPT_VERSION='2026-10-03.2';
export const researchModelStatusLabels={ready:'推理模型已生成',cached:'模型暂时不可用 · 展示上次成功结果',not_configured:'推理模型未配置 · 展示量化证据层',fetch_failed:'推理模型调用失败 · 展示量化证据层',rejected:'模型输出未通过证据校验 · 展示量化证据层'};

const levelScores={positive_allocation:2,gradual_attention:1,neutral_hold:0,cautious_watch:-1,reduce_exposure:-2,insufficient_data:null};
const levelLabels={positive_allocation:'积极配置',gradual_attention:'分批关注',neutral_hold:'中性持有',cautious_watch:'谨慎观望',reduce_exposure:'降低暴露',insufficient_data:'暂不形成建议'};
const researchActions={positive_allocation:'提高研究关注',gradual_attention:'维持并分批跟踪',neutral_hold:'维持中性跟踪',cautious_watch:'降低研究关注',reduce_exposure:'降低研究关注',insufficient_data:'仅监测，补齐证据'};
const confidenceScores={low:1,medium:2,high:3};
const tradeDirective=/买入|卖出|加仓|减仓|建仓|清仓|目标价|止损|仓位|股票代码|个股推荐|推荐个股|荐股|增持|减持|超配|低配|\b(?:buy|sell|long|short|overweight|underweight|target\s*price|position(?:ing)?|ticker)\b/i;
const unsupportedClaim=/(?:必然|一定|必定|保证|确保).{0,24}(?:导致|推动|收益|回报|上涨|下跌)|(?:确认|证实|已证明|证明了).{0,20}因果|(?:收益率|胜率|投资回报率|目标回报|收益保证)/i;
const companyAliases={
 MSFT:['Microsoft','微软'],GOOG:['Alphabet','Google','谷歌'],META:['Meta','脸书'],AMZN:['Amazon','亚马逊'],ORCL:['Oracle','甲骨文'],NVDA:['Nvidia','英伟达'],DELL:['Dell','戴尔'],AMD:['Advanced Micro Devices','超威'],TSM:['TSMC','Taiwan Semiconductor','台积电'],HPE:['Hewlett Packard Enterprise','惠普企业'],MU:['Micron','美光'],VRT:['Vertiv','维谛'],ETN:['Eaton','伊顿'],AVGO:['Broadcom','博通'],SMCI:['Super Micro','超微电脑'],ANET:['Arista','Arista Networks'],GEV:['GE Vernova']
};
const validStances=new Set(Object.keys(levelScores));
const value=point=>typeof point?.value==='number'&&Number.isFinite(point.value)?point.value:null;
const unique=items=>[...new Set(items.filter(Boolean))];
const dateOf=point=>String(point?.date??point?.periodEnd??'');
const referenceKey=reference=>`${reference.metricId}|${reference.observationVersion}|${reference.periodEnd}`;
const escapePattern=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function companyMentionFor(packet){
 const entities=(packet?.fullSiteContext?.industryMetrics??[]).filter(metric=>metric?.category!=='costs'&&/^[A-Z]{2,6}$/.test(String(metric?.entity??''))).map(metric=>String(metric.entity));
 const terms=unique([...Object.keys(companyAliases),...Object.values(companyAliases).flat(),...entities,...entities.flatMap(entity=>companyAliases[entity]??[])]);
 if(!terms.length)return /$^/;
 return new RegExp(terms.map(term=>/^[A-Z0-9]{2,8}$/.test(term)?`\\b${escapePattern(term)}\\b`:escapePattern(term)).join('|'),'i');
}

const primaryMacroSpecs=[
 {id:'DFII10',name:'美国十年期实际收益率',unit:'%',frequency:'日度',frequencyKey:'daily',comparison:20,kind:'point',role:'primary'},
 {id:'DGS10',name:'美国十年期名义国债收益率',unit:'%',frequency:'日度',frequencyKey:'daily',comparison:20,kind:'point',role:'primary'},
 {id:'NFCI',name:'芝加哥联储金融条件指数',unit:'指数点',frequency:'周度',frequencyKey:'weekly',comparison:4,kind:'point',role:'primary'},
 {id:'PCEPILFE',name:'核心 PCE 价格指数',unit:'指数',frequency:'月度',frequencyKey:'monthly',comparison:3,kind:'percent',role:'primary'},
 {id:'ICSA',name:'初次申请失业救济人数',unit:'人',frequency:'周度',frequencyKey:'weekly',comparison:4,kind:'percent',role:'primary'},
 {id:'DCOILBRENTEU',name:'布伦特原油',unit:'美元／桶',frequency:'日度',frequencyKey:'daily',comparison:20,kind:'percent',role:'primary'},
 {id:'MKT_COPPER',name:'铜期货市场参考',unit:'美元／磅',frequency:'日度',frequencyKey:'daily',comparison:20,kind:'percent',role:'market_reference'},
 {id:'MKT_GOLD',name:'黄金期货市场参考',unit:'美元／金衡盎司',frequency:'日度',frequencyKey:'daily',comparison:20,kind:'percent',role:'market_reference'},
 {id:'MKT_SILVER',name:'白银期货市场参考',unit:'美元／金衡盎司',frequency:'日度',frequencyKey:'daily',comparison:20,kind:'percent',role:'market_reference'},
 {id:'EIA_US_COMMERCIAL',name:'美国商业部门平均电价',unit:'美分／千瓦时',frequency:'月度',frequencyKey:'monthly',comparison:3,kind:'percent',role:'primary'}
];

function frequencyLabel(frequency){return {daily:'日度',weekly:'周度',monthly:'月度',quarterly:'季度',annual:'年度',event:'事件'}[frequency]??frequency??'未说明频率';}
function comparisonWindow(frequency){return {daily:20,weekly:4,monthly:3,quarterly:2,annual:1}[frequency]??3;}
function freshnessDays(frequency){return {daily:10,weekly:28,monthly:75,quarterly:150,annual:460}[frequency]??90;}
function latestSeriesPoint(series){return [...(series?.observations??[])].filter(point=>value(point)!==null).sort((a,b)=>dateOf(a).localeCompare(dateOf(b))).at(-1)??null;}
function comparisonPoint(series,count){const rows=[...(series?.observations??[])].filter(point=>value(point)!==null).sort((a,b)=>dateOf(a).localeCompare(dateOf(b)));return rows.at(-1-count)??null;}
function latestIndustryPoint(series){return [...(series?.observations??[])].sort((a,b)=>dateOf(a).localeCompare(dateOf(b))).at(-1)??null;}
function observationVersion(metricId,point){return String(point?.version??point?.sourceVersion??`observed:${metricId}:${dateOf(point)}:${value(point)??'missing'}`);}
function compactObservation(metricId,point){if(!point)return null;return {periodStart:point.periodStart??null,periodEnd:point.periodEnd??point.date??null,fiscalPeriod:point.fiscalPeriod??null,value:value(point),publishedAt:point.publishedAt??point.sourcePublishedAt??null,fetchedAt:point.fetchedAt??null,sourceUrl:point.sourceUrl??'',version:observationVersion(metricId,point),isEstimated:Boolean(point.isEstimated),isRestated:Boolean(point.isRestated)};}
function freshnessAnchor(point,frequency){
 const published=point?.publishedAt??point?.sourcePublishedAt;
 if(published&&Number.isFinite(Date.parse(String(published))))return String(published);
 const observed=dateOf(point);const time=Date.parse(observed);
 if(!Number.isFinite(time)||frequency!=='monthly')return observed;
 const parsed=new Date(time);
 return new Date(Date.UTC(parsed.getUTCFullYear(),parsed.getUTCMonth()+1,0)).toISOString().slice(0,10);
}
function isFresh(point,frequency){const time=Date.parse(freshnessAnchor(point,frequency));return Number.isFinite(time)&&Date.now()-time<=freshnessDays(frequency)*86400000;}
function isUsableStatus(status){return ['ready','reviewed','cached','official_decision'].includes(status);}

function macroSignal(spec,series){
 const latest=latestSeriesPoint(series),prior=comparisonPoint(series,spec.comparison);
 const current=value(latest),base=value(prior);
 const status=series?.status??'not_configured';
 const fresh=isFresh(latest,spec.frequencyKey);
 const eligible=current!==null&&isUsableStatus(status)&&fresh;
 const exclusionReason=current===null?'尚无已发布数值':!isUsableStatus(status)?`数据状态为 ${status}`:!fresh?'已超过该频率的正常更新窗口':null;
 const change=current===null||base===null?null:spec.kind==='point'?current-base:base===0?null:(current/base-1)*100;
 const reference={metricId:spec.id,observationVersion:observationVersion(spec.id,latest),periodEnd:dateOf(latest),sourceUrl:latest?.sourceUrl??series?.sourceUrl??'',sourcePublishedAt:latest?.publishedAt??latest?.sourcePublishedAt??null};
 return {id:spec.id,name:spec.name,unit:spec.unit,frequency:spec.frequency,role:spec.role??'supplementary',reasoningRole:eligible?(spec.role==='market_reference'?'background_only':'available_context'):'excluded',exclusionReason,latestDate:dateOf(latest),latestValue:current,comparisonDate:dateOf(prior),comparisonValue:base,change,changeUnit:spec.kind==='point'?'百分点':'%',sourceUrl:reference.sourceUrl,status,reference};
}
function sourceForMetric(definition,series){const latest=latestIndustryPoint(series);return {metricId:definition.id,name:`${definition.entity??''} ${definition.nameZh??definition.name??definition.id}`.trim(),sourceUrl:latest?.sourceUrl??definition.sourceUrl??'',periodEnd:dateOf(latest),observationVersion:observationVersion(definition.id,latest),status:series?.status??'not_configured'};}
function sourceForSignal(signal){return {metricId:signal.id,name:signal.name,sourceUrl:signal.sourceUrl??'',periodEnd:signal.latestDate??'',observationVersion:signal.reference?.observationVersion??'',status:signal.status??'not_configured'};}
function supplementalMacroSpecs(macro,macroDefinitions){
 const primary=new Set(primaryMacroSpecs.map(spec=>spec.id));
 const definitions=new Map((macroDefinitions??[]).map(definition=>[definition.id,definition]));
 return Object.keys(macro?.series??{}).filter(id=>!primary.has(id)).sort().map(id=>{
  const definition=definitions.get(id)??{};const series=macro.series[id]??{};const frequencyKey=definition.frequency??series.frequency??'monthly';
  return {id,name:definition.name??series.name??id,unit:definition.unit??series.unit??'未说明单位',frequency:frequencyLabel(frequencyKey),frequencyKey,comparison:comparisonWindow(frequencyKey),kind:definition.unit==='%'||id==='NFCI'?'point':'percent',role:id.startsWith('MKT_')?'market_reference':'supplementary'};
 });
}
function compactIndustryMetric(definition,series,asOfDate){
 const observations=[...(series?.observations??[])].sort((a,b)=>dateOf(a).localeCompare(dateOf(b))).slice(-3).map(point=>compactObservation(definition.id,point));
 const latest=observations.at(-1);
 const status=series?.status??'not_configured';
 const hasObservation=observations.some(point=>point?.value!==null);
 const latestEstimated=Boolean(latest?.isEstimated);
 const freshness=metricStats(definition,series?.observations??[],asOfDate).freshness;
 const reasoningRole=!hasObservation||!isUsableStatus(status)||latestEstimated||freshness!=='fresh'?'excluded':definition.recommendationEligible?'available_context':'background_only';
 const exclusionReason=!hasObservation?'尚无已发布观测':!isUsableStatus(status)?`数据状态为 ${status}`:latestEstimated?'最新值为估算值':freshness!=='fresh'?'已超过该指标来源的正常发布窗口':definition.recommendationEligible?'':'未纳入量化配置规则，仅作背景观察';
 return {metricId:definition.id,name:`${definition.entity??''} ${definition.nameZh??definition.nameEn??definition.id}`.trim(),entity:definition.entity??null,category:definition.category??null,family:definition.family??null,stages:definition.aiChainStage??[],unit:definition.unit??'',frequency:definition.frequency??'',valueType:definition.valueType??'',recommendationEligible:Boolean(definition.recommendationEligible),reasoningRole,exclusionReason,freshness,sourceName:definition.sourceName??'',sourceUrl:latest?.sourceUrl??definition.sourceUrl??'',status,observations};
}
function policySignals(policyRates,policyDecisions){
 const decisions=policyDecisions?.decisions??[];
 const verified=new Set((policyDecisions?.checks??[]).filter(check=>check.decisionStatus==='verified').map(check=>check.bankId));
 return (policyRates?.series??[]).map(series=>{
  const decision=[...decisions].filter(item=>item.bankId===series.id).sort((a,b)=>String(b.effectiveDate??b.announcementDate??'').localeCompare(String(a.effectiveDate??a.announcementDate??''))).at(0);
  const decisionDate=decision?.effectiveDate??decision?.announcementDate??'';
  const verifiedDecision=Boolean(decision&&verified.has(series.id));
  const useDecision=Boolean(verifiedDecision&&decisionDate&&decisionDate>=String(series.latestObservationDate??''));
  const latestValue=useDecision?(decision.midpoint??decision.upper??decision.lower??null):(typeof series.latestValue==='number'?series.latestValue:null);
  const status=useDecision?'official_decision':series.status??policyRates?.status??'not_configured';
  const sourceUrl=useDecision?decision.statementUrl??series.sourceUrl??'':series.sourceUrl??'';
  const reference={metricId:`POLICY.${series.id}`,observationVersion:String(useDecision?decision.archive?.statementSha256??`policy:${series.id}:${decisionDate}:${latestValue??'missing'}`:`policy:${series.id}:${series.latestObservationDate??''}:${latestValue??'missing'}`),periodEnd:useDecision?decisionDate:String(series.latestObservationDate??''),sourceUrl,sourcePublishedAt:useDecision?decision?.announcementDate??null:null};
  return {id:reference.metricId,name:`${series.country??''} ${series.name??series.id}`.trim(),unit:'%',frequency:'政策决议／月末',role:'policy_rate',reasoningRole:latestValue!==null&&isUsableStatus(status)?'available_context':'excluded',exclusionReason:latestValue===null?'尚无已发布利率':!isUsableStatus(status)?`数据状态为 ${status}`:null,latestDate:reference.periodEnd,latestValue,comparisonDate:'',comparisonValue:null,change:useDecision?(decision.changeBps??null):null,changeUnit:useDecision?'基点':'',sourceUrl,status,reference,action:useDecision?decision?.action??null:null,decisionDate:useDecision?decision?.announcementDate??null:null,decisionStatus:useDecision?'verified':decision?'source_checked':'no_official_decision'};
 }).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
}
function projectContext(projects){
 const records=(projects??[]).map(project=>{
  const latest=[...(project.statusHistory??[])].sort((a,b)=>String(a.date).localeCompare(String(b.date))).at(-1);
  const periodEnd=latest?.date??project.announcedAt??'';
  const capacityMw=typeof latest?.capacityMw==='number'?latest.capacityMw:typeof project.powerCapacityMw==='number'?project.powerCapacityMw:null;
  const sourceUrl=latest?.sourceUrl??project.sourceUrls?.[0]??'';
  return {id:`PROJECT.${project.id}`,name:project.name,owner:project.owner??'',country:project.country??'',region:project.region??'',status:project.status??'unknown',capacityMw,latestEventDate:periodEnd,latestEventStatus:latest?.status??project.status??'unknown',reasoningRole:'background_only',exclusionReason:'项目级公开样本覆盖不完整，不进入全球建设或配置评分。',sourceUrl,reference:{metricId:`PROJECT.${project.id}`,observationVersion:`project:${project.id}:${periodEnd}:${latest?.status??project.status??'unknown'}:${capacityMw??'missing'}`,periodEnd,sourceUrl,sourcePublishedAt:null},note:latest?.note??project.notes??''};
 });
 const byStatus=Object.fromEntries(records.reduce((map,record)=>map.set(record.status,(map.get(record.status)??0)+1),new Map()).entries());
 return {records,statusCounts:byStatus};
}
function industryEventContext(events){
 return (events??[]).map(event=>({id:`EVENT.${event.id}`,name:`${event.entity??''} ${event.title??event.id}`.trim(),date:event.date??'',kind:event.kind??'event',isConfirmed:Boolean(event.isConfirmed),observationNature:event.observationNature??'actual',reasoningRole:event.isConfirmed?'background_only':'excluded',exclusionReason:event.isConfirmed?'事件披露仅作背景观察，不单独改变配置评分。':'未核验事件不进入推理依据。',sourceUrl:event.sourceUrl??'',reference:{metricId:`EVENT.${event.id}`,observationVersion:event.version??`event:${event.id}:${event.date??''}`,periodEnd:event.date??'',sourceUrl:event.sourceUrl??'',sourcePublishedAt:event.date??null},description:event.description??''}));
}
function policyDecisionContext(policyDecisions){
 const checks=new Map((policyDecisions?.checks??[]).map(check=>[check.bankId,check]));
 return (policyDecisions?.decisions??[]).map(decision=>{
  const check=checks.get(decision.bankId);const verified=check?.decisionStatus==='verified';const periodEnd=decision.effectiveDate??decision.announcementDate??'';const id=`DECISION.${decision.bankId}.${decision.announcementDate??periodEnd}`;
  return {id,name:`${decision.country??''} ${decision.bank??decision.bankId}`.trim(),announcementDate:decision.announcementDate??'',effectiveDate:decision.effectiveDate??null,lower:decision.lower??null,upper:decision.upper??null,midpoint:decision.midpoint??null,action:decision.action??null,changeBps:decision.changeBps??null,reasoningRole:verified?'available_context':'excluded',exclusionReason:verified?'':'仅完成来源检查，尚未作为已核验政策决议使用。',sourceUrl:decision.statementUrl??'',reference:{metricId:id,observationVersion:String(decision.archive?.statementSha256??`decision:${decision.bankId}:${decision.announcementDate??periodEnd}`),periodEnd,sourceUrl:decision.statementUrl??'',sourcePublishedAt:decision.announcementDate??null}};
 });
}
function evidenceRef(item,definitions,industry){
 const definition=definitions.get(item.metricId)??{id:item.metricId,nameZh:item.metricId,sourceUrl:''};
 const series=industry?.series?.[item.metricId];
 const observation=[...(series?.observations??[])].find(point=>String(point.version??'')===String(item.observationVersion??'')&&dateOf(point)===String(item.periodEnd??''))??[...(series?.observations??[])].find(point=>dateOf(point)===String(item.periodEnd??''))??latestIndustryPoint(series);
 return {metricId:item.metricId,observationVersion:String(item.observationVersion??observationVersion(item.metricId,observation)),periodEnd:String(item.periodEnd??dateOf(observation)),sourceUrl:observation?.sourceUrl??definition.sourceUrl??'',sourcePublishedAt:observation?.publishedAt??null,direction:item.direction??'neutral',dimension:item.dimension??''};
}
function leadingOnlyDefinition(definition){
 return definition?.valueType==='proxy'||definition?.directness==='project_sample'||definition?.scoringTier==='leading_only';
}
function marketRegimeFor(sectors){
 const usable=sectors.filter(sector=>sector.stance!=='insufficient_data');
 if(!usable.length)return 'insufficient_evidence';
 const positive=usable.some(sector=>(sector.score??0)>0),negative=usable.some(sector=>(sector.score??0)<0);
 if(positive&&negative)return 'mixed_evidence';
 if(positive)return 'positive_evidence';
 if(negative)return 'negative_evidence';
 return 'mixed_evidence';
}

function permittedInstitutionalReports(reports){
 const allowedNature=new Set(['actual','estimate','forecast']);
 return (reports??[]).filter(report=>report.modelUseAllowed===true&&['ready','cached'].includes(report.status)&&report.id&&report.version&&report.sourceUrl&&report.publishedAt).map(report=>{
  const facts=(report.facts??[]).filter(fact=>allowedNature.has(fact.nature??report.observationNature)&&typeof fact.value==='number'&&Number.isFinite(fact.value)&&fact.period).map(fact=>{
   const nature=fact.nature??report.observationNature;
   return {period:String(fact.period),value:fact.value,label:fact.label??'',nature,modelRole:nature==='actual'?'context':'scenario_only',reference:{metricId:`REPORT.${report.id}`,observationVersion:String(report.version),periodEnd:String(fact.period),sourceUrl:report.sourceUrl,sourcePublishedAt:report.publishedAt}};
  });
  return {id:report.id,publisher:report.publisher,title:report.title,publishedAt:report.publishedAt,sourceUrl:report.sourceUrl,licenseUrl:report.licenseUrl??null,licenseNote:report.licenseNote??'',status:report.status,version:report.version,modelUseAllowed:true,observationNature:report.observationNature,modelRole:facts.every(fact=>fact.nature==='actual')?'context':'scenario_only',scope:report.scope,unit:report.unit,facts,methodology:report.methodology,fetchedAt:report.fetchedAt??null,boundary:'机构报告仅作为已许可背景或预测情景，未作为目标正式评分的直接指标。'};
 }).filter(report=>report.facts.length);
}

export function buildResearchPacket(industry,macro,macroDefinitions=[],policyRates={},policyDecisions={},options={}){
 const asOfDate=String(options.asOfDate??new Date().toISOString().slice(0,10)).slice(0,10);
 const definitions=new Map((industry?.definitions??[]).map(definition=>[definition.id,definition]));
 const recommendations=industry?.recommendations??[];
 const reachability=new Map(ruleReachability(industry?.definitions??[]).map(item=>[item.targetId,item]));
 const macroSignals=[...primaryMacroSpecs,...supplementalMacroSpecs(macro,macroDefinitions)].map(spec=>macroSignal(spec,macro?.series?.[spec.id]));
 const sectorSignals=recommendations.map(recommendation=>{
  const evidence=[...(recommendation.positiveEvidence??[]),...(recommendation.negativeEvidence??[]),...(recommendation.neutralEvidence??[])];
  // `evidenceRefs` is deliberately reserved for direct, recommendation-eligible
  // source evidence.  Proxies and project samples remain auditable through the
  // separate leading list, but cannot be cited as formal evidence by the model.
  const directEvidence=evidence.filter(item=>{const definition=definitions.get(item.metricId);return Boolean(definition)&&definition.recommendationEligible!==false&&!leadingOnlyDefinition(definition);});
  const leadingEvidence=evidence.filter(item=>leadingOnlyDefinition(definitions.get(item.metricId)));
  const evidenceRefs=directEvidence.map(item=>evidenceRef(item,definitions,industry));
  const leadingEvidenceRefs=leadingEvidence.map(item=>evidenceRef(item,definitions,industry));
  const unavailable=(reachability.get(recommendation.targetId)?.unavailableDimensions??[]).map(id=>`尚未配置：${dimensionNames[id]??id}指标`);
  const knownMissing=unique([...(recommendation.missingMetrics??[]),...unavailable]);
  const quant=buildQuantitativeSignal(recommendation,{definitions,series:industry?.series??{},macroSignals});
  const stance=quant.score==null?'insufficient_data':recommendation.level;
  const gapReason=recommendation.level==='insufficient_data'&&recommendation.reason?recommendation.reason:quant.leadingSignal?.reason??recommendation.reason??'连续可比历史或直接需求证据不足';
  const missingMetrics=stance==='insufficient_data'&&!knownMissing.length?[`研究边界：${gapReason}`]:knownMissing;
  const researchAction=quant.score==null?(quant.leadingSignal?.status==='available'?quant.leadingSignal.action:researchActions.insufficient_data):(researchActions[stance]??researchActions.insufficient_data);
  return {targetId:recommendation.targetId,targetName:recommendation.targetName,stance,researchAction,confidence:quant.score==null?'low':recommendation.confidence,coverage:recommendation.coverage,formalCoverage:recommendation.formalCoverage??recommendation.coverage,requiredDimensionCount:recommendation.requiredDimensionCount??0,availableDimensionCount:recommendation.availableDimensionCount??0,formalAvailableDimensionCount:recommendation.formalAvailableDimensionCount??recommendation.availableDimensionCount??0,reason:quant.score==null?gapReason:recommendation.reason,dataCutoffAt:recommendation.dataCutoffAt,evidenceSummary:{positive:(recommendation.positiveEvidence??[]).length,contrary:(recommendation.negativeEvidence??[]).length,neutral:(recommendation.neutralEvidence??[]).length},evidenceRefs,leadingEvidenceRefs,missingMetrics,invalidationConditions:recommendation.invalidationConditions??[],...quant};
 });
 const policyRateSignals=policySignals(policyRates,policyDecisions);
 const industryMetrics=[...(industry?.definitions??[])].sort((a,b)=>a.id.localeCompare(b.id)).map(definition=>compactIndustryMetric(definition,industry?.series?.[definition.id],asOfDate));
 const projects=projectContext(industry?.projects);
 const industryEvents=industryEventContext(industry?.events);
 const policyDecisionEvents=policyDecisionContext(policyDecisions);
 const institutionalReports=permittedInstitutionalReports(industry?.researchReports);
 const sources=industryMetrics.map(metric=>sourceForMetric(definitions.get(metric.metricId)??{id:metric.metricId,nameZh:metric.name,sourceUrl:metric.sourceUrl},industry?.series?.[metric.metricId]));
 const sourceRefs=[...sources,...macroSignals.map(sourceForSignal),...policyRateSignals.map(sourceForSignal),...projects.records.map(project=>({metricId:project.id,name:project.name,sourceUrl:project.sourceUrl,periodEnd:project.latestEventDate,observationVersion:project.reference.observationVersion,status:project.status})),...industryEvents.map(event=>({metricId:event.id,name:event.name,sourceUrl:event.sourceUrl,periodEnd:event.date,observationVersion:event.reference.observationVersion,status:event.reasoningRole})),...policyDecisionEvents.map(event=>({metricId:event.id,name:event.name,sourceUrl:event.sourceUrl,periodEnd:event.reference.periodEnd,observationVersion:event.reference.observationVersion,status:event.reasoningRole})),...institutionalReports.map(report=>({metricId:`REPORT.${report.id}`,name:`${report.publisher} ${report.title}`,sourceUrl:report.sourceUrl,periodEnd:report.publishedAt,observationVersion:report.version,status:report.status}))];
 const availableContextRefs=[...industryMetrics.filter(metric=>metric.reasoningRole!=='excluded').flatMap(metric=>metric.observations.map(point=>({metricId:metric.metricId,observationVersion:point.version,periodEnd:String(point.periodEnd??''),sourceUrl:point.sourceUrl??'',sourcePublishedAt:point.publishedAt??null}))),...macroSignals.filter(signal=>signal.reasoningRole!=='excluded').map(signal=>signal.reference),...policyRateSignals.filter(signal=>signal.reasoningRole!=='excluded').map(signal=>signal.reference),...projects.records.map(project=>project.reference),...industryEvents.filter(event=>event.reasoningRole!=='excluded').map(event=>event.reference),...policyDecisionEvents.filter(event=>event.reasoningRole!=='excluded').map(event=>event.reference),...institutionalReports.flatMap(report=>report.facts.map(fact=>fact.reference))];
 const allCutoffs=[...sectorSignals.map(signal=>signal.dataCutoffAt),...macroSignals.map(signal=>signal.latestDate),...policyRateSignals.map(signal=>signal.latestDate),...projects.records.map(project=>project.latestEventDate),...industryEvents.map(event=>event.date),...policyDecisionEvents.map(event=>event.reference.periodEnd)].filter(Boolean).sort();
 const fullSiteContext={industryMetrics,macroSignals,policyRates:policyRateSignals,projects,industryEvents,policyDecisionEvents};
 // Archive the entire numerical history used by normalization, not only the
 // three observations selected for the language-model context.  modelPrompt
 // deliberately selects a small allowed fact set and never sends this archive.
 const calculationInputs=JSON.parse(JSON.stringify({schemaVersion:'1',factorModelVersion:QUANT_MODEL_VERSION,asOfDate,industryGeneratedAt:industry?.generatedAt??null,definitions:industry?.definitions??[],series:industry?.series??{},recommendations,macroSignals,institutionalReports}));
 const observationManifest=Object.entries(industry?.series??{}).sort(([a],[b])=>a.localeCompare(b)).flatMap(([metricId,series])=>(series.observations??[]).map(point=>({metricId,...compactObservation(metricId,point)})));
 const inputCoverage={industryMetricCount:industryMetrics.length,industryObservedMetricCount:industryMetrics.filter(metric=>metric.observations.some(point=>point?.value!==null)).length,macroSignalCount:macroSignals.length,macroObservedSignalCount:macroSignals.filter(signal=>signal.latestValue!==null).length,policyRateCount:policyRateSignals.length,policyDecisionCount:policyDecisionEvents.length,projectRecordCount:projects.records.length,industryEventCount:industryEvents.length};
 return {schemaVersion:'2',scoreVersion:RESEARCH_SCORE_VERSION,promptVersion:RESEARCH_PROMPT_VERSION,dataCutoffAt:allCutoffs.at(-1)??'',quantitative:{model:quantModelDefinition,sectorSignals,overall:sectorSignals.find(signal=>signal.targetId==='overall')??null},marketRegime:marketRegimeFor(sectorSignals),macroSignals,policyRateSignals,institutionalReports,fullSiteContext,inputCoverage,calculationInputs,observationManifest,contextRefs:availableContextRefs,sourceRefs:[...new Map(sourceRefs.map(source=>[source.metricId,source])).values()],dataGaps:sectorSignals.flatMap(signal=>signal.missingMetrics.map(metricId=>({targetId:signal.targetId,metricId}))),guardrails:['量化信号由已验证的规则引擎计算；推理模型不能覆盖数据门槛。','正式评分要求完整的目标因子、直接来源与连续历史；项目样本、广义代理和间接口径只能形成先行研究信号，不能替代正式评分。','先行研究信号要求实际需求的直接证据达到目标规定的独立主体数量；代理数据不能凑足该覆盖门槛。缺失因子不填零、不视为中性。','产业直接证据使用需求、盈利、投入、建设和成本五类因子；同一公司及指标族去重后再聚合，宏观只以最多 ±10 分调整风险环境。','未发布、获取失败、过期或估算数据会明确标为 excluded，不可被模型当作结论证据。','机构报告按每个fact区分actual、estimate、forecast；实际调查仅作背景，估算与预测只能作情景，均不能自行补齐正式评分门槛。未授权或modelUseAllowed不是true的报告不得输入推理模型。','模型只能使用本数据包中的指标、观测版本与来源，不自行补充外部事实、新闻、价格或估值。','输出仅是产业环节的研究暴露倾向，不包含个股买卖、目标价或仓位建议。']};
}

export function buildFallbackAnalysis(packet){
 const sectors=packet.quantitative.sectorSignals;
 const overall=packet.quantitative.overall;
 const orderedEvidence=sector=>{
  const selected=['demand','profitability','construction','investment','costs'].flatMap(id=>sector.factorContributions?.find(factor=>factor.id===id)?.formalMetricIds??[]);
  const order=new Map(selected.map((id,index)=>[id,index]));
  return [...sector.evidenceRefs].sort((a,b)=>(order.get(a.metricId)??999)-(order.get(b.metricId)??999));
 };
 const formalOrLeadingText=signal=>{
  if(signal?.score!=null)return `正式综合研究信号 ${signal.score>0?'+':''}${signal.score}/100（基本面 ${signal.fundamentalScore>0?'+':''}${signal.fundamentalScore}，宏观风险调整 ${signal.macroOverlay?.score>0?'+':''}${signal.macroOverlay?.score??0}）。`;
  if(signal?.leadingSignal?.status==='available')return `正式评分待验证；先行研究信号 ${signal.leadingSignal.score>0?'+':''}${signal.leadingSignal.score}/100，仅覆盖 ${signal.leadingSignal.availableFactorCount}/${signal.leadingSignal.requiredFactorCount} 类因子（${signal.leadingSignal.quality}），实际需求直接证据 ${signal.leadingSignal.directDemandEntityCount}/${signal.leadingSignal.requiredDemandEntityCount} 个主体。${signal.leadingSignal.limitation}`;
  return `正式评分待验证：${signal?.scoringGate==='blocked_by_history'?'连续历史不足':signal?.scoringGate==='blocked_by_directness'?'当前仅有代理或间接口径':'关键直接证据尚未齐备'}。`;
 };
  const overallLabel=overall?.score==null&&overall?.leadingSignal?.status==='available'?'先行研究':overall?.stance==='insufficient_data'?'证据待补齐':levelLabels[overall?.stance]??overall?.stance;
 return {origin:'deterministic',overallStance:overall?.stance??'insufficient_data',summary:overall?`量化证据层对 AI 产业链整体当前处于“${overallLabel}”阶段；${formalOrLeadingText(overall)} 可用维度 ${overall.availableDimensionCount}/${overall.requiredDimensionCount}，数据截至 ${overall.dataCutoffAt||'尚无统一截止期'}。`:'尚未取得可用于量化结论的产业数据。',marketRegime:packet.marketRegime,confidence:overall?.confidence??'low',sectorViews:sectors.map(sector=>({targetId:sector.targetId,stance:sector.stance,thesis:`${sector.reason} ${formalOrLeadingText(sector)}`,evidenceRefs:orderedEvidence(sector).map(({metricId,observationVersion,periodEnd})=>({metricId,observationVersion,periodEnd})),contextRefs:[],missingMetricIds:sector.missingMetrics,risks:sector.readiness?.blockers?.length?sector.readiness.blockers.map(blocker=>blocker.remedy):sector.missingMetrics.length?[`当前正式因子门槛已通过；另有 ${sector.missingMetrics.length} 项补充指标仍待核验，应继续核对需求、成本与盈利是否一致。`]:['仍需持续核对需求、成本与盈利是否一致。'],nextEvidence:sector.invalidationConditions.slice(0,2).length?sector.invalidationConditions.slice(0,2):['核对下一期正式披露与数据状态。']})),limitations:['这是可复算的产业证据因子模型；外部推理模型尚未配置。','前瞻观察分只用于研究优先级，不能取代正式评分、回测或交易决策。','不同公司的财季与口径并不完全一致；数据中心项目样本也不代表全球总量。','本结果仅限产业层面研究，不评估个体证券或回报。']};
}

export function modelPrompt(packet){
 const allowedContext=item=>item.reasoningRole==='excluded'?{metricId:item.metricId??item.id,name:item.name,status:item.status??'excluded',reasoningRole:'excluded',exclusionReason:item.exclusionReason}:item;
 const fullSiteContext={...packet.fullSiteContext,industryMetrics:(packet.fullSiteContext.industryMetrics??[]).map(allowedContext),macroSignals:(packet.fullSiteContext.macroSignals??[]).map(allowedContext),policyRates:(packet.fullSiteContext.policyRates??[]).map(allowedContext),industryEvents:(packet.fullSiteContext.industryEvents??[]).map(allowedContext),policyDecisionEvents:(packet.fullSiteContext.policyDecisionEvents??[]).map(allowedContext)};
 const facts={schemaVersion:packet.schemaVersion,scoreVersion:packet.scoreVersion,promptVersion:packet.promptVersion,dataCutoffAt:packet.dataCutoffAt,marketRegime:packet.marketRegime,quantitative:packet.quantitative,fullSiteContext,institutionalReports:packet.institutionalReports??[],dataGaps:packet.dataGaps,guardrails:packet.guardrails};
 return `你是受证据约束的 AI 产业链研究分析师。只能使用下面 JSON 数据包中的事实，不可使用任何外部知识、新闻、价格、估值或未经提供的数字。\n\n输出只讨论未来 1—2 个季度的“产业环节研究暴露倾向”，严禁输出个股、公司名称、股票代码、买入/卖出、目标价、仓位、收益率或胜率。不得把相关性写成因果。\n\n每个 sectorView 的 stance 与 overallStance 必须和数据包对应的确定性结论完全一致。若 stance 是 insufficient_data，必须在 missingMetricIds 中列出数据包已知的缺项，不能凭推测补齐；若该目标带有 leadingSignal，最多将其解释为“先行研究信号”，必须说明其覆盖范围与 limitation，严禁把它写成正式评分或投资指令。evidenceRefs 只能引用该目标的 exact evidenceRefs，是规则直接证据。contextRefs 只能引用 fullSiteContext 或 institutionalReports 中精确的 reference，且仅作为背景或情景观测，不能改变结论等级。机构fact nature为estimate或forecast时，必须明确写成估算或预测情景，不能转述为已实现事实。fullSiteContext 中 reasoningRole 为 excluded 的数据不可引用或转述为结论。每个产业目标都必须保留至少一项风险和后续验证条件。\n\n每个产业目标还须输出 positiveCase（正面证据）、contraryCase（反向证据或明确尚缺），以及三个条件性 scenarios：base、upside、downside；每个情景包含 assumption、implication、invalidation 和精确 evidenceRefs。情景是假设，不是预测或已发生的事实，不给概率或未经提供的数字。invalidation 明确说明什么可观测变化会使判断失效；已有风险不允许省略。\n\n数据包：\n${JSON.stringify(facts)}`;
}

export function modelJsonSchema(packet){
 const reference={type:'object',additionalProperties:false,required:['metricId','observationVersion','periodEnd'],properties:{metricId:{type:'string'},observationVersion:{type:'string'},periodEnd:{type:'string'}}};
 const refs={type:'array',items:reference},strings={type:'array',items:{type:'string'}};
 const stance={type:'string',enum:Object.keys(levelScores)};
 return {type:'json_schema',name:'industry_research_conclusion',strict:true,schema:{type:'object',additionalProperties:false,required:['overallStance','summary','marketRegime','confidence','sectorViews','limitations'],properties:{overallStance:stance,summary:{type:'string'},marketRegime:{type:'string',enum:['positive_evidence','mixed_evidence','negative_evidence','insufficient_evidence']},confidence:{type:'string',enum:['high','medium','low']},limitations:strings,sectorViews:{type:'array',items:{type:'object',additionalProperties:false,required:['targetId','stance','thesis','evidenceRefs','contextRefs','missingMetricIds','risks','nextEvidence','positiveCase','contraryCase','scenarios'],properties:{targetId:{type:'string',enum:packet.quantitative.sectorSignals.map(signal=>signal.targetId)},stance,thesis:{type:'string'},evidenceRefs:refs,contextRefs:refs,missingMetricIds:strings,risks:strings,nextEvidence:strings,positiveCase:{type:'string'},contraryCase:{type:'string'},scenarios:{type:'array',items:{type:'object',additionalProperties:false,required:['name','assumption','implication','invalidation','evidenceRefs'],properties:{name:{type:'string',enum:['base','upside','downside']},assumption:{type:'string'},implication:{type:'string'},invalidation:{type:'string'},evidenceRefs:refs}}}}}}}}};
}

export function validateModelAnalysis(raw,packet,{requireScenarios=false}={}){
 if(!raw||typeof raw!=='object'||!Array.isArray(raw.sectorViews))throw Error('模型输出不是可用的结构化研究结论');
 const expected=new Map(packet.quantitative.sectorSignals.map(signal=>[signal.targetId,signal]));
 const allowedContext=new Set((packet.contextRefs??[]).map(referenceKey));
 const scenarioReferences=new Set([...(packet.institutionalReports??[]).flatMap(report=>report.facts.filter(fact=>fact.modelRole==='scenario_only').map(fact=>referenceKey(fact.reference))),...(packet.fullSiteContext.industryEvents??[]).filter(event=>event.observationNature==='forecast').map(event=>referenceKey(event.reference))]);
 const seen=new Set();
 const companyMention=companyMentionFor(packet);
 const checkText=(text,label)=>{if(typeof text!=='string'||!text.trim())throw Error(`模型输出缺少 ${label}`);if(tradeDirective.test(text)||companyMention.test(text))throw Error('模型输出包含个股交易指令或公司层面推荐');if(unsupportedClaim.test(text))throw Error('模型输出包含未经证据支持的因果或收益断言');return text.trim();};
 if(raw.overallStance!==(packet.quantitative.overall?.stance??'insufficient_data'))throw Error('模型输出试图覆盖整体量化证据门槛');
 if(raw.marketRegime!==packet.marketRegime)throw Error('模型输出试图覆盖量化环境分类');
 const quantitativeConfidence=packet.quantitative.overall?.confidence??'low';
 if(!confidenceScores[raw.confidence]||confidenceScores[raw.confidence]>confidenceScores[quantitativeConfidence])throw Error('模型输出试图提高数据置信度');
 if(raw.overallStance==='insufficient_data'&&!/(暂不形成|证据不足|数据不足)/.test(String(raw.summary)))throw Error('整体证据不足时必须明确说明数据边界');
 const normalizeRefs=references=>{if(!Array.isArray(references)||references.some(reference=>!reference||['metricId','observationVersion','periodEnd'].some(key=>typeof reference[key]!=='string'||!reference[key])))throw Error('模型引用缺少完整指标、日期或观测版本');return unique(references.map(referenceKey)).map(key=>{const [metricId,observationVersion,periodEnd]=key.split('|');return {metricId,observationVersion,periodEnd};});};
 const sectorViews=raw.sectorViews.map(view=>{
  const signal=expected.get(view.targetId);if(!signal||seen.has(view.targetId))throw Error('模型输出包含未知或重复的产业目标');seen.add(view.targetId);
  if(!validStances.has(view.stance)||view.stance!==signal.stance)throw Error('模型输出试图覆盖量化证据层的配置门槛');
  const allowedEvidence=new Set(signal.evidenceRefs.map(referenceKey));
  const evidenceRefs=normalizeRefs(view.evidenceRefs),contextRefs=normalizeRefs(view.contextRefs);
  if(evidenceRefs.some(reference=>!allowedEvidence.has(referenceKey(reference))))throw Error('模型输出引用了不在本目标证据包中的观测版本');
  if(contextRefs.some(reference=>!allowedContext.has(referenceKey(reference))))throw Error('模型输出引用了不在网站数据包中的背景观测');
  const missingMetricIds=unique((view.missingMetricIds??[]).filter(id=>typeof id==='string'));
  if(missingMetricIds.some(id=>!signal.missingMetrics.includes(id)))throw Error('模型输出引用了未知的数据缺口');
  if(signal.stance!=='insufficient_data'&&!evidenceRefs.length)throw Error('有结论的产业目标必须引用至少一条规则证据');
  if(signal.stance==='insufficient_data'&&!missingMetricIds.length)throw Error('数据不足的产业目标必须列出缺少的指标');
  if(!Array.isArray(view.risks)||!view.risks.length||!Array.isArray(view.nextEvidence)||!view.nextEvidence.length)throw Error('每个产业目标必须保留风险和后续验证条件');
  const texts=[view.thesis,...view.risks,...view.nextEvidence];texts.forEach((text,index)=>checkText(text,`说明 ${index+1}`));
  if(contextRefs.some(reference=>scenarioReferences.has(referenceKey(reference)))&&!/估算|估计|预测|情景/.test(texts.join(' ')))throw Error('引用机构估算或预测时必须明确说明情景边界');
  let scenarioFields={};
  if(requireScenarios||view.scenarios){
   if(!Array.isArray(view.scenarios)||view.scenarios.length!==3||new Set(view.scenarios.map(s=>s.name)).size!==3||view.scenarios.some(s=>!['base','upside','downside'].includes(s.name)))throw Error('必须提供基础、改善、恶化三个不同的条件性情景');
   const scenarios=view.scenarios.map(scenario=>{
    const refs=normalizeRefs(scenario.evidenceRefs);
    if(refs.some(ref=>!allowedEvidence.has(referenceKey(ref))&&!allowedContext.has(referenceKey(ref))))throw Error('情景引用不属于本目标或允许的背景数据');
    return {name:scenario.name,assumption:checkText(scenario.assumption,'情景假设'),implication:checkText(scenario.implication,'条件性影响'),invalidation:checkText(scenario.invalidation,'判断失效条件'),evidenceRefs:refs};
   });
   scenarioFields={positiveCase:checkText(view.positiveCase,'正面证据'),contraryCase:checkText(view.contraryCase,'反向证据'),scenarios};
  }
  return {...scenarioFields,targetId:view.targetId,stance:view.stance,thesis:checkText(view.thesis,'结论说明'),evidenceRefs,contextRefs,missingMetricIds,risks:view.risks.slice(0,5).map((text,index)=>checkText(text,`风险 ${index+1}`)),nextEvidence:view.nextEvidence.slice(0,5).map((text,index)=>checkText(text,`后续观察 ${index+1}`))};
 });
 if(seen.size!==expected.size)throw Error('模型输出遗漏了产业目标');
 return {origin:'model',overallStance:raw.overallStance,summary:checkText(raw.summary,'整体摘要'),marketRegime:raw.marketRegime,confidence:raw.confidence,sectorViews,limitations:(raw.limitations??[]).slice(0,6).map((text,index)=>checkText(text,`限制 ${index+1}`))};
}
