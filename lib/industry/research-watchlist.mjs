import {compareCheckpoints} from './research-evolution.mjs';
import {chartRows,metricStats} from './engine.mjs';

export const WATCHLIST_VERSION='research-attention-1.0.0';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const day=value=>String(value??'').slice(0,10);
const elapsed=(a,b)=>(Date.parse(a)-Date.parse(b))/86400000;
// Stable event identities do not contain fetch timestamps or the browser's time.
const identity=parts=>parts.map(value=>encodeURIComponent(String(value??''))).join('|');
export function buildResearchWatchlist({ledger=[],signals=[],industry={},valuation={},robustness={}}={}, {asOf=new Date().toISOString().slice(0,10)}={}){
 const events=new Map(),definitions=new Map((industry.definitions??[]).map(d=>[d.id,d]));
 const targetsFor=id=>signals.filter(s=>(s.factorContributions??[]).some(f=>f.metricIds.includes(id))).map(s=>s.targetId);
 const add=event=>{const prior=events.get(event.id);if(!prior||event.date>prior.date)events.set(event.id,event);};
 const records=ledger.filter(r=>day(r.recordedAt)<=asOf).slice().sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt));
 for(let i=1;i<records.length;i++){
  const current=records[i];if(elapsed(asOf,day(current.recordedAt))>30)continue;
  for(const row of compareCheckpoints(records[i-1],current).sectors){
   const invalidated=row.previousTier==='formal'&&row.currentTier!=='formal';
   if(invalidated||row.ruleChanged||row.previousStance!==row.currentStance||finite(row.delta)&&Math.abs(row.delta)>=10){
    const kind=invalidated?'invalidated':row.ruleChanged?'rule_changed':'signal_changed';
    add({id:identity([kind,row.targetId,current.recordId??current.id]),kind,priority:invalidated?3:2,date:day(current.recordedAt),targetIds:[row.targetId],entities:[],title:`${row.targetName}：${invalidated?'正式结论需要重新核验':row.ruleChanged?'计算规则更新':'研究判断有变化'}`,description:row.ruleChanged?'规则版本变化，分数不直接相减。':row.delta!=null?`研究分由 ${row.previousScore} 变为 ${row.currentScore}，变化 ${row.delta>0?'+':''}${row.delta} 分。`:'证据层级或研究方向发生变化，查看对应证据。',metricIds:row.evidence.map(e=>e.metricId),sourceUrl:row.evidence.find(e=>e.sourceUrl)?.sourceUrl??null,reason:row.reasons.join('；')});
   }
   for(const evidence of row.evidence.filter(e=>['new_report','revision','expired','source_state'].includes(e.kind))){
    const d=definitions.get(evidence.metricId),kind=evidence.kind;
    add({id:identity([kind,evidence.metricId,evidence.currentPeriod,evidence.currentValue,evidence.version]),kind,priority:kind==='expired'?3:kind==='revision'?2:1,date:day(current.recordedAt),targetIds:targetsFor(evidence.metricId),entities:d?.entity?[d.entity]:[],title:`${evidence.name}：${{new_report:'有新披露',revision:'历史数据修订',expired:'超出有效窗口',source_state:'来源状态变化'}[kind]}`,description:`${evidence.previousPeriod??'此前'}：${evidence.previousValue??'缺失'} → ${evidence.currentPeriod??'当前'}：${evidence.currentValue??'缺失'} ${evidence.unit??''}`,metricIds:[evidence.metricId],sourceUrl:evidence.sourceUrl??null,reason:evidence.reason??''});
   }
  }
 }
 for(const d of definitions.values()){
  if(!['company_revenue','revenue','cloud_revenue','backlog','orders'].includes(d.family)||d.frequency!=='quarterly')continue;
  const s=industry.series?.[d.id];if(!['ready','cached'].includes(s?.status))continue;
  const observations=(s.observations??[]).filter(p=>day(p.periodEnd)<=asOf&&(!p.publishedAt||day(p.publishedAt)<=asOf));
  const rows=chartRows(d,observations,{range:'all',mode:'value',frequency:'quarterly'});
  const growth=[2,1,0].map(offset=>metricStats(d,rows.slice(0,rows.length-offset)).yoy);
  if(growth.every(finite)&&growth[0]>growth[1]&&growth[1]>growth[2]){
   const last=observations.at(-1),targetIds=targetsFor(d.id);if(!targetIds.length)continue;
   add({id:identity(['slowing',d.id,last?.periodEnd,...growth]),kind:'slowing',priority:2,date:last?.publishedAt?day(last.publishedAt):day(last?.periodEnd),targetIds,entities:[d.entity],title:`${d.entity} ${d.nameZh}：同比增速连续两期下降`,description:`最近三期同比 ${growth.map(v=>v.toFixed(1)+'%').join(' → ')}；需核对订单、利润率及业务口径。`,metricIds:[d.id],sourceUrl:last?.sourceUrl??d.sourceUrl,reason:'同一指标的季度同比比较；不将增速下降自动解释为收入下降。'});
  }
 }
 for(const row of robustness.targets??[]){
  if(!row.eligibilityLossCount&&!row.directionFlipCount)continue;
  add({id:identity(['sensitivity',row.targetId,row.baselineScore,row.eligibilityLossCount,row.directionFlipCount]),kind:'sensitivity',priority:2,date:asOf,targetIds:[row.targetId],entities:[],title:`${row.targetName}：检查关键证据依赖`,description:`敏感性检验中，${row.eligibilityLossCount??0} 种情况失去正式评分资格，${row.directionFlipCount??0} 种情况信号方向改变。`,metricIds:[],reason:'这是对当前计算条件的诊断，查看稳健性页中的具体原因。'});
 }
 for(const company of valuation.companies??[]){
  const h=company.history;if(h?.status!=='available')continue;
  const metric=['pe','ps'].find(k=>finite(h.metrics?.[k]?.percentile)&&(h.metrics[k].percentile<=10||h.metrics[k].percentile>=90));if(!metric)continue;
  const percentile=h.metrics[metric].percentile;
  add({id:identity(['valuation',company.entity,company.priceAt,metric,Math.floor(percentile/10)]),kind:'valuation',priority:1,date:company.priceAt,entities:[company.entity],targetIds:[],title:`${company.entity}：${metric.toUpperCase()} 接近已知历史区间${percentile>=90?'高位':'低位'}`,description:`位于可比历史样本的 ${percentile.toFixed(0)}% 分位；先检查增长与盈利是否同步变化。`,metricIds:[],sourceUrl:company.sourceUrl,reason:`历史样本 ${h.count??0} 个，覆盖 ${h.from??'—'} 至 ${h.to??'—'}。分位不是合理价值结论。`});
 }
 return {version:WATCHLIST_VERSION,asOf,windowDays:30,events:[...events.values()].sort((a,b)=>b.priority-a.priority||b.date.localeCompare(a.date)||a.id.localeCompare(b.id)),method:'最近30天的重要结论与披露变化，加上当前增速、稳健性及可用历史估值提醒。关注范围和已读状态只保存在本浏览器。'};
}
export {filterResearchWatchlist} from './watchlist-preferences.mjs';
