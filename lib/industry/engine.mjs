// Every output is deterministic and carries its input observation version.
export const RULE_VERSION='industry-1.0.1';
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
  raw=[...buckets.values()].map(ps=>{const valid=ps.length===count&&ps.every(numeric);const value=!valid?null:def.aggregation==='sum'?ps.reduce((a,p)=>a+p.value,0):def.aggregation==='last'?ps.at(-1).value:ps.reduce((a,p)=>a+p.value,0)/count;return {...ps.at(-1),periodStart:ps[0].periodStart??ps[0].periodEnd,value,version:ps.map(p=>p.version).join('|')}});
 }
 const rows=raw.map(p=>({...p,value:mode==='value'?p.value:change(def,p,matchingPeriod(raw,p,mode==='yoy'?12:frequency==='quarterly'?3:frequency==='annual'?12:1,frequency))}));
 const end=rows.at(-1)?.periodEnd;if(!end)return [];const cutoff=range==='all'?'':`${Number(end.slice(0,4))-Number(range)}${end.slice(4)}`;
 // Insert explicit nulls when upstream omitted a monthly or quarterly observation.
 const filtered=rows.filter(p=>p.periodEnd>=cutoff);const result=[];
 for(const p of filtered){const prior=result.at(-1);if(prior&&['monthly','quarterly'].includes(frequency)){const step=frequency==='monthly'?1:3;let y=Number(prior.periodEnd.slice(0,4)),m=Number(prior.periodEnd.slice(5,7))+step;while(m>12){m-=12;y++;}while(`${y}-${String(m).padStart(2,'0')}`<p.periodEnd.slice(0,7)){result.push({...p,periodEnd:`${y}-${String(m).padStart(2,'0')}-01`,value:null,version:'missing',sourceUrl:'',fiscalPeriod:'缺失观测'});m+=step;if(m>12){m-=12;y++;}}}result.push(p);}
 return result;
}
const coreCloud=['MSFT','GOOG','AMZN','META','ORCL'];
export const targets=[
 {id:'cloud',name:'AI云计算平台',entities:coreCloud,required:['investment','demand','profitability','costs']},
 {id:'data_centers',name:'数据中心建设',entities:coreCloud,required:['investment','demand','construction','costs']},
 {id:'power',name:'电力及配电设备',entities:['ETN','VRT','GEV'],required:['demand','construction','profitability','costs']},
 {id:'servers',name:'AI服务器与网络设备',entities:['DELL','HPE','SMCI','ANET'],required:['investment','demand','profitability','costs']},
 {id:'accelerators',name:'半导体及AI加速器',entities:['NVDA','AMD','AVGO'],required:['investment','demand','profitability','costs']},
 {id:'foundry',name:'晶圆代工',entities:['TSM'],required:['investment','demand','profitability','costs']},
 {id:'packaging',name:'先进封装',entities:['ASX'],required:['investment','demand','construction','profitability']},
 {id:'memory',name:'HBM及存储',entities:['MU'],required:['investment','demand','profitability','costs']},
 {id:'materials',name:'铜、铝等上游材料',entities:[],required:['investment','demand','profitability','costs']},
 {id:'overall',name:'AI产业链整体',entities:[...coreCloud,'NVDA','AMD','DELL','VRT','TSM','MU'],required:['investment','demand','construction','profitability','costs']}
];
function dimensionFor(def,target){
 const own=target.entities.includes(def.entity);const f=def.family;
 if(f==='capex'&&(own||(['servers','accelerators','data_centers','power','memory','foundry','packaging'].includes(target.id)&&coreCloud.includes(def.entity))))return 'investment';
 if(own&&['cloud_revenue','cloud_growth','datacenter_revenue','backlog','server_revenue'].includes(f))return 'demand';
 if(own&&['cloud_margin','gross_margin','operating_cash_flow','free_cash_flow','inventory_days'].includes(f))return 'profitability';
 if(['operational_capacity','construction_capacity'].includes(f))return 'construction';
 if(['copper','aluminum','natural_gas','electricity','equipment_price'].includes(f))return 'costs';
 return null;
}
export function generateRecommendations(data,nowISO=new Date().toISOString(),previous=[]){
 return targets.map(target=>{
  const dimensions=Object.entries(dimensionNames).map(([id,name])=>({id,name,state:'missing',metricIds:[]}));const positiveEvidence=[],negativeEvidence=[],neutralEvidence=[],missingMetrics=[];let proxyCount=0,validCount=0,expectedCount=0;const deteriorating=new Set(),cutoffs=[],entities=new Set();
  for(const def of data.definitions){const dimension=dimensionFor(def,target);if(!dimension)continue;expectedCount++;const series=data.series[def.id];const stats=metricStats(def,series?.observations??[],nowISO);const disallowed=!def.recommendationEligible||['demo','guidance','third_party'].includes(def.valueType)||stats.freshness!=='fresh'||stats.yoy==null||series?.status==='fetch_failed'||series?.status==='pending'||stats.latest?.isEstimated;
   if(disallowed){missingMetrics.push(def.id);continue;}validCount++;if(def.valueType==='proxy')proxyCount++;if(def.entity&&target.entities.includes(def.entity)&&dimension==='demand')entities.add(def.entity);cutoffs.push(stats.latest.periodEnd);
   const inverse=dimension==='costs'||def.family==='inventory_days';const signal=(stats.yoy>.05?1:stats.yoy<-.05?-1:0)*(inverse?-1:1);const direction=signal>0?'positive':signal<0?'negative':'neutral';
   const explanation=`${def.entity??''} ${def.nameZh}：${stats.latest.periodEnd}，${def.family==='cloud_growth'?'披露同比增速':'同比'} ${stats.yoy.toFixed(2)}${percentagePointMetric(def)&&def.family!=='cloud_growth'?'个百分点':'%'}，${stats.previousYoy==null?'缺少上期增速':`上期增速 ${stats.previousYoy.toFixed(2)}${percentagePointMetric(def)&&def.family!=='cloud_growth'?'个百分点':'%'}`}。${dimension==='costs'?'仅作为成本背景，不证明需求。':stats.trend+'。'}`;
   const item={metricId:def.id,observationVersion:stats.latest.version,direction,explanation,periodEnd:stats.latest.periodEnd,dimension};(direction==='positive'?positiveEvidence:direction==='negative'?negativeEvidence:neutralEvidence).push(item);
   dimensions.find(x=>x.id===dimension).metricIds.push(def.id);
   if(stats.consecutiveDeterioration>=2&&['capex','cloud_revenue','datacenter_revenue','server_revenue','backlog','cloud_margin','gross_margin'].includes(def.family))deteriorating.add(def.family==='cloud_margin'||def.family==='gross_margin'?'profitability':def.family==='cloud_revenue'||def.family==='datacenter_revenue'||def.family==='server_revenue'?'revenue':def.family);
  }
  for(const d of dimensions){const pos=positiveEvidence.filter(e=>e.dimension===d.id).length,neg=negativeEvidence.filter(e=>e.dimension===d.id).length;if(d.metricIds.length)d.state=pos&&neg?'neutral':pos?'positive':neg?'negative':'neutral';}
  const pos=dimensions.filter(d=>d.state==='positive').length,neg=dimensions.filter(d=>d.state==='negative').length,available=dimensions.filter(d=>d.state!=='missing').length;
  const coverage=expectedCount?validCount/expectedCount:0;const missingRequired=target.required.filter(id=>dimensions.find(d=>d.id===id).state==='missing');let level='insufficient_data',reason='关键证据尚未齐备：'+missingRequired.map(id=>dimensionNames[id]).join('、');
  if(!missingRequired.length&&coverage>=.7&&entities.size>=2){
   if(deteriorating.size>=3){level='reduce_exposure';reason='投入、订单、收入、盈利中至少三类指标的同比增速连续两个报告期恶化。';}
   else if(deteriorating.size>=2){level='cautious_watch';reason='至少两类核心指标的同比增速连续两个报告期恶化。';}
   else if(pos>=4&&neg===0&&available===5){level='positive_allocation';reason='至少四个维度为正面，五个维度均有证据且无负面维度。';}
   else if(pos>=3){level='gradual_attention';reason='至少三个维度为正面，但其他维度或反向证据仍需验证。';}
   else if(positiveEvidence.length>0&&negativeEvidence.length>0){level='neutral_hold';reason='正面与反向信号并存，尚未形成一致趋势。';}
   else{level='cautious_watch';reason='有效数据尚未形成足够一致的扩张证据。';}
  }else if(!missingRequired.length)reason=coverage<.7?'可用核心指标不足70%，暂不形成建议。':'目前主要由单一公司支持，暂不外推为整个产业的建议。';
  const confidence=level==='insufficient_data'?'low':coverage>=.95&&proxyCount/Math.max(1,validCount)<.2&&negativeEvidence.length===0&&available===5?'high':'medium';
  const signature=[RULE_VERSION,target.id,level,confidence,JSON.stringify([coverage,missingMetrics,dimensions]),...data.definitions.filter(d=>dimensionFor(d,target)).map(d=>JSON.stringify([d.id,d.unit,d.methodology,d.recommendationEligible])),...[...positiveEvidence,...negativeEvidence,...neutralEvidence].map(e=>e.metricId+':'+e.observationVersion)].join('|');let hash=2166136261;for(const c of signature)hash=Math.imul(hash^c.charCodeAt(0),16777619)>>>0;
  const prev=[...previous].reverse().find(r=>r.targetId===target.id);const id=target.id+'-'+hash.toString(16);
  return {id,targetType:'industry',targetId:target.id,targetName:target.name,level,confidence,horizon:'medium',generatedAt:prev?.id===id?prev.generatedAt:nowISO,dataCutoffAt:cutoffs.sort()[0]??'',positiveEvidence,negativeEvidence,neutralEvidence,invalidationConditions:['关键数据超过有效期或来源、统计口径发生变化时，撤销当前建议并重新计算。','资本开支与订单、收入或盈利中至少两类同比增速连续两个报告期下降时，转入谨慎评估。'],watchMetrics:[...new Set([...missingMetrics,...positiveEvidence.map(e=>e.metricId),...negativeEvidence.map(e=>e.metricId)])],ruleVersion:RULE_VERSION,previousRecommendationId:prev?.id===id?prev.previousRecommendationId:prev?.id,previousLevel:prev?.id===id?prev.previousLevel:prev?.level,reason,dimensions,missingMetrics,coverage,changeReason:prev?.id===id?prev.changeReason:prev?`${levelLabels[prev.level]} → ${levelLabels[level]}。${reason} 数据或有效性版本发生变化。`:'首次按已接入真实数据计算；未将首次导入视为历史投资建议。'};
 });
}
