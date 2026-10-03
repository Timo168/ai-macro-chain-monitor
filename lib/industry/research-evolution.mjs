// Immutable, source-bound checkpoints. A fetch timestamp is not a new signal.
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const displayed=signal=>finite(signal?.score)?{tier:'formal',score:signal.score}:signal?.leadingSignal?.status==='available'&&finite(signal.leadingSignal.score)?{tier:'leading',score:signal.leadingSignal.score}:{tier:'unavailable',score:null};
export function researchCheckpoint(result){
 const metrics=(result.evidence?.inputSnapshot?.fullSiteContext?.industryMetrics??[]).map(metric=>({metricId:metric.metricId,name:metric.name,unit:metric.unit,status:metric.status,freshness:metric.freshness,reasoningRole:metric.reasoningRole,exclusionReason:metric.exclusionReason,observations:(metric.observations??[]).map(point=>({periodEnd:point.periodEnd,value:point.value,publishedAt:point.publishedAt,version:point.version,sourceUrl:point.sourceUrl}))}));
 const signals=(result.quantitative?.sectorSignals??[]).map(signal=>({targetId:signal.targetId,targetName:signal.targetName,stance:signal.stance,confidence:signal.confidence,scoringGate:signal.scoringGate,...displayed(signal),formalScore:signal.score,leadingScore:signal.leadingSignal?.score??null,dataQualityScore:signal.dataQualityScore,validUntil:signal.validUntil,factorModelVersion:signal.factorModelVersion,factors:(signal.factorContributions??[]).map(factor=>({id:factor.id,name:factor.name,contribution:factor.formalContribution??null,leadingContribution:factor.contribution??null,metricIds:factor.metricIds??[],basis:factor.basis})),macroScore:signal.macroOverlay?.score??null,macroComponents:signal.macroOverlay?.components??[],missingMetrics:signal.missingMetrics??[]}));
 const semantic={signals,metrics:metrics.map(metric=>({...metric,status:metric.reasoningRole==='excluded'?metric.status:'available',observations:metric.observations.map(({version,sourceUrl,...point})=>point)}))};
 const id=hash(semantic);
 return {schemaVersion:'1',id,recordId:hash([id,result.generatedAt,result.inputHash]),recordedAt:result.generatedAt,inputHash:result.inputHash,modelVersion:result.quantitative?.model?.version??null,signals,metrics,dataCutoffs:result.dataCutoffs,origin:'live_archive'};
}
export function appendCheckpoint(ledger,current){
 const records=Array.isArray(ledger)?ledger:[];
 const last=records.at(-1);
 // Keep the FIRST time the input was actually archived, including A -> B -> A.
 if(last?.id===current.id&&last?.origin===current.origin)return {records,current:last,previous:records.at(-2)??null,appended:false};
 return {records:[...records,current],current,previous:last??null,appended:true};
}
export function compareCheckpoints(previous,current,{unchanged=false}={}){
 if(!previous)return {status:'first_record',previousAt:null,currentAt:current.recordedAt,summary:'首份可追溯研究快照，后续与这份记录比较。',sectors:[]};
 const before=new Map(previous.metrics.map(metric=>[metric.metricId,metric]));
 const changed=[];
 for(const metric of current.metrics){
  const old=before.get(metric.metricId),a=old?.observations?.at(-1),b=metric.observations?.at(-1);
  let kind=null;
  if(!old||(!a&&b))kind='new_evidence';
  else if(b?.periodEnd!==a?.periodEnd)kind='new_report';
  else if(b?.value!==a?.value||JSON.stringify((old.observations??[]).map(p=>[p.periodEnd,p.value]))!==JSON.stringify((metric.observations??[]).map(p=>[p.periodEnd,p.value])))kind='revision';
  else if(old.freshness!==metric.freshness)kind=metric.freshness==='fresh'?'freshness_recovered':'expired';
  else if(old.reasoningRole!==metric.reasoningRole||old.status!==metric.status)kind='source_state';
  if(kind)changed.push({metricId:metric.metricId,name:metric.name,kind,previousValue:a?.value??null,currentValue:b?.value??null,previousPeriod:a?.periodEnd??null,currentPeriod:b?.periodEnd??null,unit:metric.unit,sourceUrl:b?.sourceUrl??'',version:b?.version??'',reason:metric.exclusionReason??''});
 }
 for(const metric of previous.metrics)if(!current.metrics.some(m=>m.metricId===metric.metricId))changed.push({metricId:metric.metricId,name:metric.name,kind:'removed',previousValue:metric.observations?.at(-1)?.value??null,currentValue:null,unit:metric.unit,reason:'指标从当前配置中移除。'});
 const oldSignals=new Map(previous.signals.map(signal=>[signal.targetId,signal]));
 const sectors=current.signals.map(signal=>{
  const old=oldSignals.get(signal.targetId);
  const ruleChanged=Boolean(old&&old.factorModelVersion!==signal.factorModelVersion);
  const comparable=!ruleChanged&&old?.tier===signal.tier&&finite(old?.score)&&finite(signal.score);
  const factors=signal.factors.map(factor=>{const prior=old?.factors?.find(f=>f.id===factor.id);const a=signal.tier==='formal'?prior?.contribution:prior?.leadingContribution;const b=signal.tier==='formal'?factor.contribution:factor.leadingContribution;return {...factor,previous:a??null,current:b??null,delta:comparable&&finite(a)&&finite(b)?Math.round((b-a)*100)/100:null};});
  const ids=new Set(signal.factors.flatMap(f=>f.metricIds));
  const evidence=changed.filter(metric=>ids.has(metric.metricId));
  const kinds=new Set(evidence.map(e=>e.kind));
  const delta=comparable?signal.score-old.score:null;
  const expired=evidence.filter(e=>e.kind==='expired');
  const macroChanged=Boolean(old&&old.macroScore!==signal.macroScore);
  const changedSignal=!old||old.tier!==signal.tier||old.score!==signal.score||old.stance!==signal.stance||old.scoringGate!==signal.scoringGate||JSON.stringify(old.factors)!==JSON.stringify(signal.factors)||macroChanged||ruleChanged;
  const reasons=[ruleChanged?'计算规则版本变化':null,kinds.has('new_report')?'新报告期数据进入计算':null,kinds.has('revision')?'已披露历史数值修订':null,expired.length?'证据超过更新窗口，被移出可用范围':null,kinds.has('source_state')?'来源状态或证据资格变化':null,macroChanged?'宏观风险调整变化':null].filter(Boolean);
  const macroDelta=comparable&&finite(old?.macroScore)&&finite(signal.macroScore)?signal.macroScore-old.macroScore:null;
  const residualDelta=delta==null?null:Math.round((delta-factors.reduce((sum,f)=>sum+(f.delta??0),0)-(macroDelta??0))*100)/100;
  return {targetId:signal.targetId,targetName:signal.targetName,changed:changedSignal,previousTier:old?.tier??null,currentTier:signal.tier,previousScore:old?.score??null,currentScore:signal.score,delta,previousStance:old?.stance??null,currentStance:signal.stance,macroDelta,residualDelta,factors,evidence,reasons:reasons.length?reasons:[changedSignal?'证据覆盖或历史标准化结果变化':'本环节结论未变化'],expiredCount:expired.length,ruleChanged};
 });
 const count=sectors.filter(s=>s.changed).length;
 return {status:unchanged?'unchanged':'compared',previousAt:previous.recordedAt,currentAt:current.recordedAt,summary:unchanged?'本次后台检查没有产生新的有效结论；下方保留最近一次变化。':count?`${count} 个产业环节的分数、证据层级或研究方向发生变化。`:'数据证据更新，产业环节结论保持不变。',sectors,note:'因子变化可复算；相关财报是计算依据，不等同于金融市场因果或收益归因。'};
}
