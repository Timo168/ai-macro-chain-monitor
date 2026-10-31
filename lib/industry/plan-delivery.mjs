import {eventDay} from '../observation-events.mjs';
const validNumber=n=>typeof n==='number'&&Number.isFinite(n);
const validSource=record=>record&&typeof record.sourceUrl==='string'&&record.sourceUrl.startsWith('https://')&&Boolean(eventDay(record.publishedAt));

export function evaluatePlanDelivery(plan,now=new Date().toISOString()){
 const today=eventDay(now),actual=plan.actual;
 const versions=(plan.versions??[]).filter(version=>validSource(version)&&validNumber(version.low)&&validNumber(version.high)&&version.low>=0&&version.high>=version.low&&eventDay(version.publishedAt)<=today&&eventDay(version.publishedAt)<=plan.periodEnd).sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt));
 const base={initial:versions[0]??null,latest:versions.at(-1)??null,versions,status:'not_configured',label:'指引待匹配',reason:'尚未取得可核验、带明确期限的先行指引。',actual:null,initialDeviationPct:null,latestDeviationPct:null};
 if(!versions.length)return base;
 if(!actual||!validSource(actual)||eventDay(actual.publishedAt)>today)return {...base,status:plan.periodEnd>=today?'period_open':'awaiting_actual',label:plan.periodEnd>=today?'期限未满':'等待同口径实际值',reason:plan.periodEnd>=today?'全年期限尚未结束，不以未完成全年目标判定失败。':'报告期已结束，但尚未取得完整期间的同口径实际值。'};
 const mismatch=['entity','currency','unit','scope','periodStart','periodEnd'].filter(key=>!plan[key]||plan[key]!==actual[key]);
 if(mismatch.length||actual.isEstimated||!validNumber(actual.value))return {...base,status:'basis_mismatch',label:'口径待核验',reason:`实际值不可直接比较${mismatch.length?'：'+mismatch.join('、'):''}；不以不同口径替代。`};
 const prior=versions.filter(version=>eventDay(version.publishedAt)<eventDay(actual.publishedAt));
 if(!prior.length)return {...base,status:'not_prior',label:'缺少事前计划',reason:'计划必须先于实际值公布；事后披露不能当作预测。'};
 if(plan.periodEnd>today||eventDay(actual.publishedAt)<plan.periodEnd)return {...base,status:'period_open',label:'期限未满',reason:'尚无完整期间结束后的正式结果。'};
 const initial=prior[0],latest=prior.at(-1),midpoint=version=>(version.low+version.high)/2;
 const relative=version=>midpoint(version)>0?(actual.value/midpoint(version)-1)*100:null;
 return {...base,initial,latest,versions:prior,actual,status:'comparable',label:actual.value<latest.low?'低于指引区间':actual.value>latest.high?'高于指引区间':'落在指引区间',reason:'同公司、同币种、同口径、同期间；与结果公布前最后一条已核验指引比较。',initialDeviationPct:relative(initial),latestDeviationPct:relative(latest)};
}

export function planSourceState(plan,data,reviewedAt){
 const update=data?.financialUpdates?.find(item=>item.entity===plan.entity);
 const releaseDate=eventDay(update?.release?.publishedAt);
 if(update?.sourceStatus==='fetch_failed'||update?.sourceStatus==='cached')return {status:update.sourceStatus,label:update.sourceStatus==='fetch_failed'?'来源获取失败 · 保留人工核验快照':'来源缓存 · 保留人工核验快照'};
 if(!plan.actual&&releaseDate&&releaseDate>eventDay(reviewedAt))return {status:'needs_review',label:'发现较新财报 · 指引待再次核验'};
 return {status:'reviewed',label:'人工核验快照 · 非自动抓取指引'};
}

export function pendingPlanEntities(data,plans){
 const present=new Set(plans.map(plan=>plan.entity));
 return (data?.definitions??[]).filter(def=>def.family==='capex'&&def.entity&&!present.has(def.entity)).map(def=>{
  const series=data.series?.[def.id],latest=series?.observations?.filter(p=>validNumber(p.value)).at(-1);
  return {entity:def.entity,metricId:def.id,name:def.nameZh,status:series?.status??'not_configured',sourceUrl:latest?.sourceUrl??def.sourceUrl,periodEnd:latest?.periodEnd??null,reason:'已接入实际资本开支；尚缺同期限、同租赁口径的官方事前指引，不计算兑现率。'};
 });
}
