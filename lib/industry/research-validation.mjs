import {addMonths} from './research-tracking.mjs';

export const RESEARCH_VALIDATION_VERSION='research-validation-1.0.0';
export const validationCostBps=[0,10,25,50];
export const validationScoreBands=[
 {id:'strong_negative',label:'≤ −45',lower:-100,upper:-45},
 {id:'negative',label:'−45 至 −15',lower:-45,upper:-15},
 {id:'neutral',label:'−15 至 15',lower:-15,upper:15},
 {id:'positive',label:'15 至 45',lower:15,upper:45},
 {id:'strong_positive',label:'≥ 45',lower:45,upper:100}
];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const day=value=>String(value??'').slice(0,10);
const validDay=value=>/^\d{4}-\d{2}-\d{2}$/.test(value??'')&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
// A date-only saved result is only known at the END of that Beijing day.
// It must not train a signal recorded earlier on the same day.
const timestamp=value=>!value?NaN:validDay(value)?Date.parse(value+'T23:59:59.999+08:00'):Date.parse(value);
const mean=values=>values.length?Number((values.reduce((sum,value)=>sum+value,0)/values.length).toFixed(4)):null;
const median=values=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:mean([sorted[middle-1],sorted[middle]]);};
const scoreBand=score=>score<=-45?'strong_negative':score<=-15?'negative':score<15?'neutral':score<45?'positive':'strong_positive';
const marketRegime=score=>!finite(score)?'unknown':score>=3?'macro_tailwind':score<=-3?'macro_headwind':'macro_mixed';
const costReturn=(gross,bps)=>((1+gross/100)*(1-bps/10000)**2-1)*100;
const costsFor=row=>validationCostBps.map(costBpsPerSide=>{
 const netReturn=costReturn(row.grossReturn,costBpsPerSide),benchmarkNetReturn=costReturn(row.benchmarkReturn,costBpsPerSide);
 return {costBpsPerSide,netReturn:Number(netReturn.toFixed(4)),benchmarkNetReturn:Number(benchmarkNetReturn.toFixed(4)),excessReturn:Number((netReturn-benchmarkNetReturn).toFixed(4))};
});
const baseKey=row=>JSON.stringify([row.targetId,row.factorModelVersion,row.tier,row.months,row.basketVersion,row.symbols,row.benchmark]);
function aggregates(rows){
 return {count:rows.length,meanGrossReturn:mean(rows.map(row=>row.grossReturn)),meanBenchmarkReturn:mean(rows.map(row=>row.benchmarkReturn)),medianGrossReturn:median(rows.map(row=>row.grossReturn)),worstArchivedDrawdown:rows.some(row=>finite(row.archivedMaxDrawdown))?Math.min(...rows.map(row=>row.archivedMaxDrawdown).filter(finite)):null,costScenarios:validationCostBps.map(costBpsPerSide=>{
  const values=rows.map(row=>row.costScenarios.find(item=>item.costBpsPerSide===costBpsPerSide));
  return {costBpsPerSide,count:rows.length,meanNetReturn:mean(values.map(row=>row.netReturn)),meanBenchmarkNetReturn:mean(values.map(row=>row.benchmarkNetReturn)),meanExcessReturn:mean(values.map(row=>row.excessReturn)),medianNetReturn:median(values.map(row=>row.netReturn))};
 })};
}

// This is a descriptive evaluation of real archived follow-ups. It never
// reconstructs signals, fetches prices, fits weights, or manufactures a past
// sample from the current data. Frozen matured windows remain the source.
export function buildResearchValidation(ledger,tracking,{asOf,registeredAt=null}={}){
 if(!validDay(asOf))throw Error('Research validation requires an explicit valid asOf date');
 const cutoff=timestamp(asOf),registration=timestamp(registeredAt),registrationValid=Number.isFinite(registration)&&registration<=cutoff;
 const records=new Map();
 for(const record of Array.isArray(ledger)?ledger:[]){
  if(record.origin!=='live_archive'||!record.inputHash||!Number.isFinite(timestamp(record.recordedAt))||timestamp(record.recordedAt)>cutoff)continue;
  const id=record.recordId??record.id;if(!id)continue;
  // Ambiguous record identities cannot prove which signal was archived.
  records.set(id,records.has(id)?null:record);
 }
 const candidates=[],excluded=[],seen=new Set();let pendingCount=0;
 for(const cohort of tracking?.cohorts??[]){
  const record=records.get(cohort.checkpointId),signal=record?.signals?.find(item=>item.targetId===cohort.targetId);
  const reject=(months,reason)=>excluded.push({cohortId:cohort.id??null,targetId:cohort.targetId??null,months,reason});
  const linked=record&&signal&&cohort.inputHash===record.inputHash&&cohort.recordedAt===record.recordedAt&&cohort.tier===signal.tier&&cohort.score===signal.score&&['formal','leading'].includes(signal.tier)&&finite(signal.score)&&signal.score>=-100&&signal.score<=100&&Boolean(signal.factorModelVersion)&&(!cohort.factorModelVersion||cohort.factorModelVersion===signal.factorModelVersion);
  for(const window of cohort.windows??[]){
   if(!linked){reject(window.months,'unmatched_live_archive');continue;}
   if(window.status!=='matured'){pendingCount++;continue;}
   if(![1,3,6].includes(window.months)){reject(window.months,'unsupported_horizon');continue;}
   const dates=[window.entryAt,window.maturityAt,window.exitAt];
   if(!dates.every(validDay)||window.entryAt<=day(record.recordedAt)||window.maturityAt!==addMonths(window.entryAt,window.months)||window.exitAt<window.maturityAt||window.exitAt>asOf||Date.parse(window.exitAt)-Date.parse(window.maturityAt)>7*86400000||Date.parse(window.entryAt)-Date.parse(day(record.recordedAt))>7*86400000||!Number.isFinite(timestamp(window.evaluatedAt))||timestamp(window.evaluatedAt)>cutoff||day(window.evaluatedAt)<window.exitAt||cohort.entry?.date&&cohort.entry.date!==window.entryAt){reject(window.months,'invalid_or_future_window');continue;}
   const names=[...(cohort.symbols??[]),cohort.benchmark];
   if(!cohort.symbols?.length||new Set(cohort.symbols).size!==cohort.symbols.length||!cohort.benchmark||!cohort.basketVersion||names.some(name=>!window.priceVersions?.[name]?.version||!['ready','cached'].includes(window.priceVersions[name].status))){reject(window.months,'missing_frozen_price_lineage');continue;}
   if(!finite(window.grossReturn)||window.grossReturn< -100||!finite(window.benchmarkReturn)||window.benchmarkReturn< -100||!finite(cohort.costBpsPerSide)||cohort.costBpsPerSide<0||cohort.costBpsPerSide>500){reject(window.months,'missing_gross_returns_or_cost_basis');continue;}
   const id=`${cohort.id}:${window.months}`;
   if(seen.has(id)){reject(window.months,'duplicate_frozen_window');continue;}seen.add(id);
   const row={id,cohortId:cohort.id,checkpointId:cohort.checkpointId,inputHash:record.inputHash,recordedAt:record.recordedAt,targetId:signal.targetId,targetName:signal.targetName,tier:signal.tier,score:signal.score,scoreBand:scoreBand(signal.score),factorModelVersion:signal.factorModelVersion,basketVersion:cohort.basketVersion,symbols:[...cohort.symbols].sort(),benchmark:cohort.benchmark,months:window.months,entryAt:window.entryAt,maturityAt:window.maturityAt,exitAt:window.exitAt,evaluatedAt:window.evaluatedAt,evaluationPhase:registrationValid&&timestamp(record.recordedAt)>=registration?'prospective':'exploratory',marketRegime:marketRegime(signal.macroScore),macroScore:signal.macroScore??null,grossReturn:window.grossReturn,benchmarkReturn:window.benchmarkReturn,archivedMaxDrawdown:finite(window.maxDrawdown)?window.maxDrawdown:null,archivedCostBpsPerSide:cohort.costBpsPerSide,priceVersions:window.priceVersions};
   row.costScenarios=costsFor(row);candidates.push(row);
  }
 }
 // Earliest recorded signal wins without looking at performance or score band.
 // The same target/version/tier/horizon cannot contribute overlapping windows,
 // including windows on either side of registration or in different regimes.
 const windows=[],lastExit=new Map();
 candidates.sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.entryAt.localeCompare(b.entryAt)||a.id.localeCompare(b.id));
 for(const row of candidates){
  const key=baseKey(row),end=lastExit.get(key);
  if(end&&row.entryAt<=end){excluded.push({cohortId:row.cohortId,targetId:row.targetId,months:row.months,reason:'overlapping_window',overlapsThrough:end});continue;}
  lastExit.set(key,row.exitAt);windows.push(row);
 }
 for(const row of windows){
  const prior=windows.filter(item=>item.id!==row.id&&baseKey(item)===baseKey(row)&&item.exitAt<day(row.recordedAt)&&timestamp(item.evaluatedAt)<timestamp(row.recordedAt));
  const sameBand=prior.filter(item=>item.scoreBand===row.scoreBand);
  const priorMean=sameBand.length>=5?mean(sameBand.map(item=>item.costScenarios.find(cost=>cost.costBpsPerSide===10).excessReturn)):null;
  row.walkForward={status:sameBand.length>=5?'prior_baseline_available':'insufficient_prior_samples',trainingCutoff:row.recordedAt,trainingWindowIds:prior.map(item=>item.id),trainingCount:prior.length,sameBandCount:sameBand.length,minimumSameBandCount:5,priorMeanExcessReturnAt10Bps:priorMean,realizedExcessReturnAt10Bps:row.costScenarios.find(cost=>cost.costBpsPerSide===10).excessReturn};
 }
 const groupsMap=new Map();
 for(const row of windows){const key=JSON.stringify([baseKey(row),row.evaluationPhase]);if(!groupsMap.has(key))groupsMap.set(key,[]);groupsMap.get(key).push(row);}
 const groups=[...groupsMap.values()].map(rows=>{
  const first=rows[0];return {targetId:first.targetId,targetName:first.targetName,factorModelVersion:first.factorModelVersion,tier:first.tier,months:first.months,basketVersion:first.basketVersion,symbols:first.symbols,benchmark:first.benchmark,evaluationPhase:first.evaluationPhase,...aggregates(rows),sampleAdequacy:rows.length>=20?'descriptive_sample':'insufficient_sample',firstEntryAt:rows[0].entryAt,lastExitAt:rows.at(-1).exitAt,scoreBands:validationScoreBands.map(band=>({...band,...aggregates(rows.filter(row=>row.scoreBand===band.id))})),marketRegimes:['macro_tailwind','macro_mixed','macro_headwind','unknown'].map(id=>({id,...aggregates(rows.filter(row=>row.marketRegime===id))})),walkForward:{trainedCount:rows.filter(row=>row.walkForward.status==='prior_baseline_available').length,untrainedCount:rows.filter(row=>row.walkForward.status!=='prior_baseline_available').length}};
 });
 const prospectiveCount=windows.filter(row=>row.evaluationPhase==='prospective').length;
 const status=!windows.length?'awaiting_maturity':prospectiveCount?'collecting_prospective':'exploratory_only';
 return {version:RESEARCH_VALIDATION_VERSION,status,asOf,registeredAt:registrationValid?registeredAt:null,registrationStatus:registrationValid?'registered':'not_registered',method:{scoreBands:validationScoreBands,costBpsPerSide:validationCostBps,horizonsMonths:[1,3,6],nonOverlap:'按目标、因子版本、证据层级、期限和篮子口径，取最早记录且不重叠的完整区间；不按收益、分数组或市场环境选择。',sampleThreshold:20,trainingMinimumSameBandCount:5,training:'滚动对照仅使用信号记录前已经到期且已保存的同版本、同层级、同期限历史；同分数组至少五个样本才展示过去均值，无拟合或调参。',registration:'登记前记录只作探索；登记后真实留存信号才进入前瞻观察。前瞻不是已证实有效的策略。',returnFormula:'(1 + 冻结毛收益 / 100) × (1 - 每侧成本基点 / 10000)^2 - 1；样本与基准同口径。',marketRegime:'按当时归档 macroScore：≥3 为宏观顺风，≤−3 为逆风，其余为混合；缺失单列。'},counts:{ledgerRecords:records.size,candidateWindows:candidates.length,acceptedWindows:windows.length,prospectiveWindows:prospectiveCount,exploratoryWindows:windows.length-prospectiveCount,pendingWindows:pendingCount,excludedWindows:excluded.length},groups,windows,excluded,summary:!windows.length?'真实留存结论尚无可验证的期满区间；继续记录，暂不显示收益有效性结论。':`已保留 ${windows.length} 个按目标去重叠的期满区间，其中登记后前瞻 ${prospectiveCount} 个；按模型版本和证据层级分别展示。`,limitations:['这些是预设样本篮子的结论后表现，不是已执行交易，也不是个股收益预测。','分数组、每侧成本和取样规则预先固定；不搜索历史最优分界或权重。','不同期限及不同产业仍可能共享证券和日期，不能把所有分组相加当作独立样本或生成统一胜率。','样本数二十只是描述性展示阈值，不代表统计显著、策略验证或盈利保证；本页不估计胜率或 Sharpe。','成本场景从原始毛收益重新计算；回撤沿用已冻结的原成本口径，不虚构其他成本下的每日路径。','历史版本、正式与先行信号分开；负分仍观察做多样本篮子，不取反冒充做空结果。','已保存的期满结果及行情版本是事实依据；登记前数据仅作探索，后来的修订不替换这些结果。']};
}
