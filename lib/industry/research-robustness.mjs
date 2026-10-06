import {createHash} from 'node:crypto';
import {generateRecommendations,dimensionNames} from './engine.mjs';
import {buildQuantitativeSignal,factorWeights,QUANT_MODEL_VERSION} from './quant-model.mjs';

export const ROBUSTNESS_VERSION='research-robustness-1.0.0';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const unique=values=>[...new Set(values.filter(Boolean))];
const evidence=record=>[...(record?.positiveEvidence??[]),...(record?.negativeEvidence??[]),...(record?.neutralEvidence??[])];
const direction=score=>!finite(score)?'unavailable':score>=15?'positive':score<=-15?'negative':'neutral';
const scoreSummary=(record,signal)=>({score:signal.score,direction:direction(signal.score),stance:finite(signal.score)?record.level:'insufficient_data',eligible:signal.scoringGate==='passed',scoringGate:signal.scoringGate,blockingFactors:unique(signal.readiness?.blockers?.map(blocker=>blocker.factorId)??[])});

// Only receives the already time-filtered calculation input archived by the
// research packet. Missing series retain their definitions and become missing;
// dropping an input must never lower the target's required evidence coverage.
export function buildResearchRobustness(inputs,{inputHash=null}={}){
 if(!inputs?.asOfDate||!Array.isArray(inputs.definitions)||!inputs.series)return {version:ROBUSTNESS_VERSION,status:'not_available',asOf:inputs?.asOfDate??null,inputHash,targets:[],reason:'缺少可复算的已归档计算输入。'};
 if(inputs.factorModelVersion&&inputs.factorModelVersion!==QUANT_MODEL_VERSION)return {version:ROBUSTNESS_VERSION,status:'model_version_mismatch',asOf:inputs.asOfDate,inputHash,targets:[],reason:'归档因子版本与当前引擎不同；不能用新规则改写旧版稳定性结果。'};
 const definitions=inputs.definitions,definitionMap=new Map(definitions.map(item=>[item.id,item]));
 const source={definitions,series:inputs.series};
 const recommendations=generateRecommendations(source,inputs.asOfDate);
 const baseOptions={definitions,series:inputs.series,macroSignals:inputs.macroSignals??[]};
 const removalCache=new Map();
 const afterRemoval=ids=>{
  const key=[...ids].sort().join('|');
  if(removalCache.has(key))return removalCache.get(key);
  const series={...inputs.series};
  for(const id of ids)series[id]={...series[id],status:'not_configured',observations:[]};
  const records=new Map(generateRecommendations({definitions,series},inputs.asOfDate).map(record=>[record.targetId,record]));
  const value={series,records};removalCache.set(key,value);return value;
 };
 const output=recommendations.map(record=>{
  const baseline=buildQuantitativeSignal(record,baseOptions),summary=scoreSummary(record,baseline);
  const metricIds=unique(evidence(record).map(item=>item.metricId)).sort();
  const entityIds=unique(metricIds.map(id=>definitionMap.get(id)?.entity)).sort();
  const scenarios=[];
  const append=(id,type,label,change,nextRecord,nextSignal)=>{
   const next=scoreSummary(nextRecord,nextSignal);
   scenarios.push({id,type,label,...change,...next,delta:finite(summary.score)&&finite(next.score)?next.score-summary.score:null,directionChanged:summary.eligible&&next.eligible&&summary.direction!==next.direction,directionFlipped:summary.eligible&&next.eligible&&((summary.direction==='positive'&&next.direction==='negative')||(summary.direction==='negative'&&next.direction==='positive')),eligibilityLost:summary.eligible&&!next.eligible,stanceChanged:summary.eligible&&next.eligible&&summary.stance!==next.stance});
  };
  for(const factor of baseline.factorContributions){
   for(const multiplier of [.8,1.2]){
    const signal=buildQuantitativeSignal(record,{...baseOptions,sensitivityWeightMultipliers:{[factor.id]:multiplier}});
    append(`weight:${factor.id}:${multiplier}`,'factor_weight',`${dimensionNames[factor.id]??factor.id}权重${multiplier<1?'降低':'提高'}20%`,{factorId:factor.id,multiplier},record,signal);
   }
  }
  for(const metricId of metricIds){
   const reduced=afterRemoval([metricId]),next=reduced.records.get(record.targetId);
   append(`metric:${metricId}`,'remove_metric',`移除${definitionMap.get(metricId)?.nameZh??metricId}`,{metricId},next,buildQuantitativeSignal(next,{...baseOptions,series:reduced.series}));
  }
  for(const entity of entityIds){
   const ids=definitions.filter(item=>item.entity===entity).map(item=>item.id),reduced=afterRemoval(ids),next=reduced.records.get(record.targetId);
   append(`entity:${entity}`,'remove_entity',`移除${entity}全部指标`,{entity},next,buildQuantitativeSignal(next,{...baseOptions,series:reduced.series}));
  }
  const scores=[summary.score,...scenarios.map(item=>item.score)].filter(finite);
  const eligibilityLossCount=scenarios.filter(item=>item.eligibilityLost).length;
  const directionFlipCount=scenarios.filter(item=>item.directionFlipped).length;
  const directionChangeCount=scenarios.filter(item=>item.directionChanged).length;
  const stanceChangeCount=scenarios.filter(item=>item.stanceChanged).length;
  const sensitive=type=>scenarios.filter(item=>item.type===type).sort((a,b)=>Number(b.eligibilityLost)-Number(a.eligibilityLost)||Number(b.directionFlipped)-Number(a.directionFlipped)||Math.abs(b.delta??0)-Math.abs(a.delta??0)||a.id.localeCompare(b.id))[0]??null;
  const inputRefs=metricIds.map(metricId=>{
   const definition=definitionMap.get(metricId),series=inputs.series[metricId];
   const rows=(series?.observations??[]).filter(point=>finite(point.value)).sort((a,b)=>String(a.periodEnd).localeCompare(String(b.periodEnd)));
   const latest=rows.at(-1);
   return {metricId,entity:definition?.entity??null,name:definition?.nameZh??metricId,sourceUrl:latest?.sourceUrl??definition?.sourceUrl??null,periodEnd:latest?.periodEnd??null,observationVersion:latest?.version??null,publishedAt:latest?.publishedAt??null,fetchedAt:series?.fetchedAt??latest?.fetchedAt??null,status:series?.status??'not_configured',observationCount:rows.length,historyStart:rows[0]?.periodEnd??null,historyHash:createHash('sha256').update(JSON.stringify(series?.observations??[])).digest('hex')};
  });
  const status=!summary.eligible?'insufficient_evidence':eligibilityLossCount?'evidence_dependent':directionFlipCount||directionChangeCount||stanceChangeCount?'sensitive':'stable_in_test';
  return {targetId:record.targetId,targetName:record.targetName,researchScope:baseline.researchScope,status,baselineScore:summary.score,baselineDirection:summary.direction,baselineStance:summary.stance,baselineEligible:summary.eligible,scoreRange:summary.eligible&&scores.length?{min:Math.min(...scores),max:Math.max(...scores)}:null,scenarioCount:scenarios.length,directionFlipCount,directionChangeCount,stanceChangeCount,eligibilityLossCount,mostSensitiveFactor:sensitive('factor_weight'),mostSensitiveEntity:sensitive('remove_entity'),mostSensitiveMetric:sensitive('remove_metric'),inputRefs,scenarios,summary:!summary.eligible?'正式评分证据仍不足；稳定性检验不会放宽门槛。':eligibilityLossCount?`移除单项指标或主体后，有 ${eligibilityLossCount} 个情景失去正式评分资格，需关注证据集中。`:directionChangeCount||stanceChangeCount?`有 ${directionChangeCount} 个情景改变分数方向分类、${stanceChangeCount} 个情景改变研究行动，结论对输入较敏感。`:'本次固定扰动未改变方向或资格；这只描述输入稳定性，不证明投资收益。'};
 });
 return {version:ROBUSTNESS_VERSION,status:'ready',asOf:inputs.asOfDate,inputHash,factorModelVersion:QUANT_MODEL_VERSION,method:{baseWeights:factorWeights,weightMultipliers:[.8,1.2],renormalize:true,removalUnits:['entire_metric_history','all_metrics_of_entity'],directionThreshold:15,gates:'与正式生产引擎共用完整证据、历史及主体数量门槛',macroTreatment:'保留同一已归档宏观风险调整'},targets:output,limitations:['这是当前输入的敏感性检验，不是投资绩效回测或收益置信区间。','只使用同一截止日的已归档输入；移除指标与主体后重新生成建议并重算，缺失值不填零。','权重只做预先固定的单因子上下20%扰动，其余权重按比例重新归一；没有为提高历史收益搜索参数。','最低主体要求的单一公司样本在移除自身后必然失去资格；应结合覆盖范围理解，不能据此宣称模型错误。']};
}
