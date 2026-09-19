// Every output is deterministic and carries its input observation version.
export const RULE_VERSION='industry-1.1.0';
export const levelLabels={positive_allocation:'积极配置',gradual_attention:'分批关注',neutral_hold:'中性持有',cautious_watch:'谨慎观望',reduce_exposure:'降低暴露',insufficient_data:'暂不形成建议'};
export const dimensionNames={investment:'投资投入',demand:'实际需求',construction:'建设进度',profitability:'盈利兑现',costs:'成本与约束'};
const days=(a,b)=>(Date.parse(a)-Date.parse(b))/86400000;
const numeric=p=>p&&typeof p.value==='number'&&Number.isFinite(p.value);
const rate=(a,b)=>numeric(a)&&numeric(b)&&b.value>0?(a.value/b.value-1)*100:null;
export const percentagePointMetric=def=>def.unit==='%';
const change=(def,a,b)=>percentagePointMetric(def)?numeric(a)&&numeric(b)?a.value-b.value:null:rate(a,b);
export function matchingPeriod(rows,p,months,frequency){
 if(!p)return null;const d=new Date(p.periodEnd+'T00:00:00Z');const endDay=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-months);const year=d.getUTCFullYear(),month=d.getUTCMonth();
 if(frequency==='monthly')return rows.find(x=>x.periodEnd.slice(0,7)===`${year}-${String(month+1).padStart(2,'0')}`)??null;
 const end=new Date(Date.UTC(year,month+1,0));d.setUTCDate(Math.min(endDay,end.getUTCDate()));
 const tolerance=frequency==='daily'?5:10;
 return rows.filter(x=>x.periodEnd<p.periodEnd&&Math.abs(days(x.periodEnd,d.toISOString().slice(0,10)))<=tolerance).sort((a,b)=>Math.abs(days(a.periodEnd,d.toISOString()))-Math.abs(days(b.periodEnd,d.toISOString())))[0]??null;
}
export function metricStats(def,observations,nowISO=new Date().toISOString()){
 const rows=[...observations].sort((a,b)=>a.periodEnd.localeCompare(b.periodEnd));const latest=rows.at(-1)??null;
 const step=def.frequency==='annual'?12:def.frequency==='quarterly'?3:1;
 const prev=matchingPeriod(rows,latest,step,def.frequency),base=matchingPeriod(rows,latest,12,def.frequency),prevBase=matchingPeriod(rows,prev,12,def.frequency);
 const isRate=['cloud_growth','capex_growth','semiconductor_growth'].includes(def.family);
 const yoy=isRate?(numeric(latest)?latest.value:null):change(def,latest,base);const previousYoy=isRate?(numeric(prev)?prev.value:null):change(def,prev,prevBase);
 const qoq=change(def,latest,prev);
 let trend='数据不足';if(yoy!=null&&previousYoy!=null)trend=yoy<0?'同比收缩':yoy===0?'方向不明':yoy>previousYoy+.05?'扩张加速':yoy<previousYoy-.05?'增长放缓':'保持扩张';
 const cadence={daily:7,monthly:31,quarterly:92,annual:366,event:0}[def.frequency];
 const freshness=!numeric(latest)?'missing':days(nowISO,latest.periodEnd)>cadence+(def.normalUpdateDelayDays??60)?'stale':'fresh';
 let consecutiveDeterioration=0,p=latest;
 for(let i=0;i<4&&p;i++){const prior=matchingPeriod(rows,p,step,def.frequency),b=matchingPeriod(rows,p,12,def.frequency),pb=matchingPeriod(rows,prior,12,def.frequency);const g=isRate?p.value:change(def,p,b),pg=isRate?prior?.value:change(def,prior,pb);if(g!=null&&pg!=null&&g<pg-.05)consecutiveDeterioration++;else break;p=prior;}
 return {latest,yoy,qoq,previousYoy,trend,freshness,consecutiveDeterioration,previous:prev};
}
export function chartRows(def,observations,{range='1',mode='value',frequency=def.frequency}={}){
 let raw=[...observations].sort((a,b)=>a.periodEnd.localeCompare(b.periodEnd));
 // Aggregate only complete calendar periods. Fiscal company quarters remain fiscal quarters.
 if(frequency!==def.frequency){
  if(def.frequency!=='monthly'||!['quarterly','annual'].includes(frequency)||def.aggregation==='none')return [];
  const count=frequency==='annual'?12:3;const buckets=new Map();
  for(const p of raw){const m=Number(p.periodEnd.slice(5,7));const key=frequency==='annual'?p.periodEnd.slice(0,4):p.periodEnd.slice(0,4)+'Q'+Math.ceil(m/3);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(p);}
  raw=[...buckets.values()].map(ps=>{const valid=ps.length===count&&ps.every(numeric);const value=!valid?null:def.aggregation==='sum'?ps.reduce((a,p)=>a+p.value,0):def.aggregation==='last'?ps.at(-1).value:ps.reduce((a,p)=>a+p.value,0)/count;return {...ps.at(-1),periodStart:ps[0].periodStart??ps[0].periodEnd,value,version:ps.map(p=>p.version).join('|'),formula:`${frequency}: ${def.aggregation} of ${count} complete monthly observations`,originalItems:{monthlyInputs:JSON.stringify(ps.map(p=>({periodEnd:p.periodEnd,value:p.value,version:p.version})))}}});
 }
 const rows=raw.map(p=>{if(mode==='value')return p;const base=matchingPeriod(raw,p,mode==='yoy'?12:frequency==='quarterly'?3:frequency==='annual'?12:1,frequency);return {...p,value:change(def,p,base),formula:percentagePointMetric(def)?'current - base (percentage points)':'(current / base - 1) * 100',originalItems:{...p.originalItems,displayCurrent:p.value,displayBase:base?.value??null,displayBasePeriod:base?.periodEnd??'missing',displayBaseVersion:base?.version??'missing',sourceFormula:p.formula??'reported'}}});
 const end=rows.at(-1)?.periodEnd;if(!end)return [];const cutoff=range==='all'?'':`${Number(end.slice(0,4))-Number(range)}${end.slice(4)}`;
 // Insert explicit nulls when upstream omitted a monthly or quarterly observation.
 const filtered=rows.filter(p=>p.periodEnd>=cutoff);const result=[];
 for(const p of filtered){const prior=result.at(-1);if(prior&&['monthly','quarterly'].includes(frequency)){const step=frequency==='monthly'?1:3;let y=Number(prior.periodEnd.slice(0,4)),m=Number(prior.periodEnd.slice(5,7))+step;while(m>12){m-=12;y++;}while(`${y}-${String(m).padStart(2,'0')}`<p.periodEnd.slice(0,7)){result.push({...p,periodEnd:`${y}-${String(m).padStart(2,'0')}-01`,value:null,version:'missing',sourceUrl:'',fiscalPeriod:'缺失观测'});m+=step;if(m>12){m-=12;y++;}}}result.push(p);}
 return result;
}
export function historyCompleteness(def,observations){
 const valid=(observations??[]).filter(numeric);
 if(!['monthly','quarterly'].includes(def.frequency)||valid.length<2)return {observedPeriods:valid.length,expectedPeriods:valid.length,missingPeriods:[]};
 const rows=chartRows(def,observations,{range:'all',mode:'value',frequency:def.frequency});
 const missingPeriods=rows.filter(p=>p.value==null&&p.version==='missing').map(p=>p.periodEnd);
 return {observedPeriods:valid.length,expectedPeriods:valid.length+missingPeriods.length,missingPeriods};
}
const coreCloud=['MSFT','GOOG','AMZN','META','ORCL'];
export const targets=[
 {id:'cloud',name:'AI云计算平台',entities:coreCloud,required:['investment','demand','profitability','costs'],minimumDemandEntities:2},
 {id:'data_centers',name:'数据中心建设',entities:coreCloud,required:['investment','demand','construction','costs'],minimumDemandEntities:2},
 {id:'power',name:'电力及配电设备',entities:['ETN','VRT','GEV'],required:['demand','construction','profitability','costs'],minimumDemandEntities:2},
 {id:'servers',name:'AI服务器与网络设备',entities:['DELL','HPE','SMCI','ANET'],required:['investment','demand','profitability','costs'],minimumDemandEntities:2},
 {id:'accelerators',name:'半导体及AI加速器',entities:['NVDA','AMD','AVGO'],required:['investment','demand','profitability','costs'],minimumDemandEntities:2},
 {id:'foundry',name:'晶圆代工',entities:['TSM'],required:['investment','demand','profitability','costs'],minimumDemandEntities:1},
 {id:'packaging',name:'先进封装',entities:['ASX'],required:['investment','demand','profitability','costs'],minimumDemandEntities:1},
 {id:'memory',name:'HBM及存储',entities:['MU'],required:['investment','demand','profitability','costs'],minimumDemandEntities:1},
 {id:'materials',name:'铜、铝等上游材料',entities:[],required:['costs'],minimumDemandEntities:0,disabledReason:'尚未接入可核验的 AI 材料订单、产能、利润与成本转嫁数据；不以商品价格单独形成产业配置建议。'},
 {id:'overall',name:'AI产业链整体',entities:[...coreCloud,'NVDA','AMD','DELL','VRT','TSM','MU'],required:['investment','demand','construction','profitability','costs'],minimumDemandEntities:2}
];
const costFamilies={
 cloud:['electricity'],data_centers:['electricity','equipment_price','copper','aluminum'],power:['electricity','equipment_price','copper','aluminum'],
 servers:['electricity','equipment_price','copper','aluminum'],accelerators:['electricity','equipment_price'],foundry:['electricity','natural_gas','equipment_price'],
 packaging:['electricity','natural_gas','equipment_price'],memory:['electricity','natural_gas','equipment_price'],materials:['copper','aluminum','natural_gas'],
 overall:['electricity','equipment_price','copper','aluminum','natural_gas']
};
function dimensionFor(def,target){
 const own=target.entities.includes(def.entity);const f=def.family;
 if(f==='capex'&&(own||(['servers','accelerators','data_centers','power','memory','foundry','packaging'].includes(target.id)&&coreCloud.includes(def.entity))))return 'investment';
 if(own&&['cloud_revenue','cloud_growth','datacenter_revenue','backlog','server_revenue'].includes(f))return 'demand';
 if(own&&['cloud_margin','gross_margin','operating_cash_flow','free_cash_flow','inventory_days'].includes(f))return 'profitability';
 if(['operational_capacity','construction_capacity'].includes(f)&&['data_centers','power','overall'].includes(target.id))return 'construction';
 if(costFamilies[target.id]?.includes(f))return 'costs';
 return null;
}
const formalEvidence=def=>def.recommendationEligible&&!['demo','guidance','third_party'].includes(def.valueType);
export function ruleReachability(definitions){
 return targets.map(target=>({targetId:target.id,unavailableDimensions:target.required.filter(dimension=>!definitions.some(def=>formalEvidence(def)&&dimensionFor(def,target)===dimension)),disabledReason:target.disabledReason}));
}
export function generateRecommendations(data,nowISO=new Date().toISOString(),previous=[]){
 return targets.map(target=>{
  const dimensions=Object.entries(dimensionNames).map(([id,name])=>({id,name,state:'missing',metricIds:[]}));const positiveEvidence=[],negativeEvidence=[],neutralEvidence=[],missingMetrics=[];let proxyCount=0,validCount=0;const deteriorating=new Set(),cutoffs=[],entities=new Set(),dimensionEvidence=new Map();
  for(const def of data.definitions){const dimension=dimensionFor(def,target);if(!dimension)continue;const series=data.series[def.id];const stats=metricStats(def,series?.observations??[],nowISO);const disallowed=!def.recommendationEligible||['demo','guidance','third_party'].includes(def.valueType)||stats.freshness!=='fresh'||stats.yoy==null||['fetch_failed','pending','not_configured','authorization_required','no_observation'].includes(series?.status)||stats.latest?.isEstimated;
   if(disallowed){missingMetrics.push(def.id);continue;}validCount++;if(def.valueType==='proxy')proxyCount++;if(def.entity&&target.entities.includes(def.entity)&&dimension==='demand')entities.add(def.entity);cutoffs.push(stats.latest.periodEnd);
   const inverse=dimension==='costs'||def.family==='inventory_days';const signal=(stats.yoy>.05?1:stats.yoy<-.05?-1:0)*(inverse?-1:1);const direction=signal>0?'positive':signal<0?'negative':'neutral';
   const explanation=`${def.entity??''} ${def.nameZh}：${stats.latest.periodEnd}，${def.family==='cloud_growth'?'披露同比增速':'同比'} ${stats.yoy.toFixed(2)}${percentagePointMetric(def)&&def.family!=='cloud_growth'?'个百分点':'%'}，${stats.previousYoy==null?'缺少上期增速':`上期增速 ${stats.previousYoy.toFixed(2)}${percentagePointMetric(def)&&def.family!=='cloud_growth'?'个百分点':'%'}`}。${dimension==='costs'?'仅作为成本背景，不证明需求。':stats.trend+'。'}`;
   const item={metricId:def.id,observationVersion:stats.latest.version,direction,explanation,periodEnd:stats.latest.periodEnd,dimension};(direction==='positive'?positiveEvidence:direction==='negative'?negativeEvidence:neutralEvidence).push(item);
   const key=dimension==='costs'?def.family:`${def.entity??'industry'}:${def.family}`;const grouped=dimensionEvidence.get(dimension)??new Map();const bucket=grouped.get(key)??[];bucket.push({...item,signal});grouped.set(key,bucket);dimensionEvidence.set(dimension,grouped);
   if(stats.consecutiveDeterioration>=2&&['capex','cloud_revenue','datacenter_revenue','server_revenue','backlog','cloud_margin','gross_margin'].includes(def.family))deteriorating.add(def.family==='cloud_margin'||def.family==='gross_margin'?'profitability':def.family==='cloud_revenue'||def.family==='datacenter_revenue'||def.family==='server_revenue'?'revenue':def.family);
  }
  for(const d of dimensions){const groups=dimensionEvidence.get(d.id);if(!groups?.size)continue;const representatives=[...groups.values()].map(items=>items.sort((a,b)=>Math.abs(b.signal)-Math.abs(a.signal))[0]);d.metricIds=representatives.map(item=>item.metricId);const score=representatives.reduce((sum,item)=>sum+item.signal,0)/representatives.length;d.state=score>.2?'positive':score<-.2?'negative':'neutral';}
  const requiredDimensions=dimensions.filter(d=>target.required.includes(d.id)),pos=requiredDimensions.filter(d=>d.state==='positive').length,neg=requiredDimensions.filter(d=>d.state==='negative').length,available=requiredDimensions.filter(d=>d.state!=='missing').length;
  const coverage=target.required.length?available/target.required.length:0;const missingRequired=target.required.filter(id=>dimensions.find(d=>d.id===id).state==='missing');const unreachable=ruleReachability(data.definitions).find(r=>r.targetId===target.id)?.unavailableDimensions??[];let level='insufficient_data',reason=target.disabledReason??'关键证据尚未齐备：'+missingRequired.map(id=>dimensionNames[id]).join('、');
  if(!target.disabledReason&&!unreachable.length&&!missingRequired.length&&entities.size>=(target.minimumDemandEntities??2)){
   if(deteriorating.size>=3){level='reduce_exposure';reason='投入、订单、收入、盈利中至少三类指标的同比增速连续两个报告期恶化。';}
   else if(deteriorating.size>=2){level='cautious_watch';reason='至少两类核心指标的同比增速连续两个报告期恶化。';}
   else if(pos>=Math.min(4,target.required.length)&&neg===0&&available===target.required.length){level='positive_allocation';reason='关键维度均有证据，至少四个维度为正面且未出现负面维度。';}
   else if(pos>=3){level='gradual_attention';reason='至少三个维度为正面，但其他维度或反向证据仍需验证。';}
   else if(positiveEvidence.length>0&&negativeEvidence.length>0){level='neutral_hold';reason='正面与反向信号并存，尚未形成一致趋势。';}
   else{level='cautious_watch';reason='有效数据尚未形成足够一致的扩张证据。';}
  }else if(!target.disabledReason){reason=unreachable.length?`尚未配置可用于正式建议的${unreachable.map(id=>dimensionNames[id]).join('、')}指标。`:missingRequired.length?`关键证据尚未齐备：${missingRequired.map(id=>dimensionNames[id]).join('、')}。`:entities.size<(target.minimumDemandEntities??2)?'需求证据覆盖的公司数量不足，暂不外推为整个产业的建议。':'关键证据尚未齐备。';}
  const confidence=level==='insufficient_data'?'low':coverage===1&&proxyCount/Math.max(1,validCount)<.2&&negativeEvidence.length===0&&available===target.required.length?'high':'medium';
  const signature=[RULE_VERSION,target.id,level,confidence,JSON.stringify([coverage,missingMetrics,dimensions]),...data.definitions.filter(d=>dimensionFor(d,target)).map(d=>JSON.stringify([d.id,d.unit,d.methodology,d.recommendationEligible])),...[...positiveEvidence,...negativeEvidence,...neutralEvidence].map(e=>e.metricId+':'+e.observationVersion)].join('|');let hash=2166136261;for(const c of signature)hash=Math.imul(hash^c.charCodeAt(0),16777619)>>>0;
  const prev=[...previous].reverse().find(r=>r.targetId===target.id);const id=target.id+'-'+hash.toString(16);
  return {id,targetType:'industry',targetId:target.id,targetName:target.name,level,confidence,horizon:'medium',generatedAt:prev?.id===id?prev.generatedAt:nowISO,dataCutoffAt:cutoffs.sort().at(-1)??'',evidencePeriodStart:cutoffs.sort()[0]??'',evidencePeriodEnd:cutoffs.sort().at(-1)??'',positiveEvidence,negativeEvidence,neutralEvidence,invalidationConditions:['关键数据超过有效期或来源、统计口径发生变化时，撤销当前建议并重新计算。','资本开支与订单、收入或盈利中至少两类同比增速连续两个报告期下降时，转入谨慎评估。'],watchMetrics:[...new Set([...missingMetrics,...positiveEvidence.map(e=>e.metricId),...negativeEvidence.map(e=>e.metricId)])],ruleVersion:RULE_VERSION,previousRecommendationId:prev?.id===id?prev.previousRecommendationId:prev?.id,previousLevel:prev?.id===id?prev.previousLevel:prev?.level,reason,dimensions,missingMetrics,coverage,requiredDimensionCount:target.required.length,availableDimensionCount:available,changeReason:prev?.id===id?prev.changeReason:prev?`${levelLabels[prev.level]} → ${levelLabels[level]}。${reason} 数据或有效性版本发生变化。`:'首次按已接入真实数据计算；未将首次导入视为历史投资建议。'};
 });
}
