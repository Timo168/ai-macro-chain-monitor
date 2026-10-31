const DAY=/^\d{4}-\d{2}-\d{2}$/;
export function eventDay(value){
 if(typeof value!=='string'||!value)return null;
 if(DAY.test(value)){const stamp=Date.parse(value);return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value?value:null;}
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return null;
 return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
const safeUrl=value=>typeof value==='string'&&/^https:\/\//.test(value)?value:null;

// An observation period, scrape time, and publication date are deliberately distinct.
export function buildObservationEvents(inputs={},now=new Date().toISOString()){
 const out=[],today=eventDay(now),industry=inputs.industry;
 const add=(event)=>{if(!event.date||!safeUrl(event.sourceUrl))return;out.push({...event,scheduled:event.date>today});};
 for(const [id,series] of Object.entries(inputs.macro?.series??{})){
  if(!series.sourcePublishedAt)continue;
  add({id:`macro:${id}:${series.sourcePublishedAt}`,kind:'macro',title:`${id} 来源发布更新`,date:eventDay(series.sourcePublishedAt),publishedAt:series.sourcePublishedAt,dateBasis:'来源发布时间',seriesIds:[id],sourceUrl:series.sourceUrl,status:series.status,version:series.revision??null,fetchedAt:series.fetchedAt,observationDate:series.observations?.filter(p=>p.value!=null).at(-1)?.date??null});
 }
 for(const decision of inputs.policyDecisions?.decisions??[]){
  const publishedAt=decision.announcedAt||decision.announcementDate;
  add({id:`policy:${decision.bankId}:${decision.announcementDate}`,kind:'policy',title:`${decision.bank} · ${decision.lower===decision.upper?decision.upper:`${decision.lower}–${decision.upper}`}%`,date:eventDay(publishedAt),publishedAt,dateBasis:decision.announcedAt?'公告时间（北京时间）':'官方公告日期（当地）',entity:decision.bankId,seriesIds:[],sourceUrl:decision.statementUrl,status:inputs.policyDecisions.status,version:inputs.policyDecisions.generatedAt,fetchedAt:decision.fetchedAt});
 }
 for(const update of industry?.financialUpdates??[]){
  const release=update.release;
  if(!release?.publishedAt)continue;
  add({id:`release:${update.entity}:${release.publishedAt}`,kind:'release',title:`${update.entity} · ${release.title}`,entity:update.entity,date:eventDay(release.publishedAt),publishedAt:release.publishedAt,dateBasis:'官方财报发布日期',seriesIds:update.currentMetricIds??[],sourceUrl:release.url,status:update.sourceStatus,version:release.version??industry.generatedAt,fetchedAt:update.lastSuccessfulAt,observationDate:update.ingestedPeriodEnd});
 }
 for(const def of industry?.definitions??[]){
  const series=industry.series?.[def.id];
  for(const observation of series?.observations??[]){
   const publishedAt=observation.publishedAt||observation.filingDate;
   if(!publishedAt)continue;
   add({id:`observation-release:${def.id}:${publishedAt}`,kind:'release',title:`${def.entity??def.nameZh} · 财报/来源公布`,entity:def.entity,date:eventDay(publishedAt),publishedAt,dateBasis:observation.publishedAt?'来源发布日期':'文件提交日期',seriesIds:[def.id],sourceUrl:observation.sourceUrl,status:series.status,version:observation.version,fetchedAt:observation.fetchedAt,observationDate:observation.periodEnd});
  }
 }
 for(const event of industry?.events??[]){
  if(!event.isConfirmed)continue;
  add({id:`industry:${event.id}`,kind:event.kind==='guidance'?'guidance':event.kind==='release'?'release':'project',title:event.title,entity:event.entity,date:eventDay(event.date),publishedAt:event.date,dateBasis:event.kind==='release'?'官方财报日程日期':'官方公告日期',seriesIds:[],sourceUrl:event.sourceUrl,status:event.status??'reviewed',version:event.version??industry.generatedAt,fetchedAt:event.fetchedAt});
 }
 const unique=new Map();
 for(const event of out){
  const key=`${event.kind}|${event.entity??''}|${event.date}|${event.sourceUrl}`;
  const previous=unique.get(key);
  if(previous){previous.seriesIds=[...new Set([...previous.seriesIds,...event.seriesIds])];continue}
  unique.set(key,event);
 }
 return [...unique.values()].sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
}

/** @param {any[]} events @param {{seriesIds?:string[],entity?:string|null,includePolicy?:boolean}} options */
export function eventsForChart(events,{seriesIds=[],entity=null,includePolicy=false}={}){
 const ids=new Set(seriesIds);
 return events.filter(event=>event.kind==='policy'?includePolicy:entity?event.entity===entity:event.seriesIds.some(id=>ids.has(id)));
}

// For categorical axes, mark the first available observation ON OR AFTER the
// event. Outside-range publications stay in the list; never invent a data point.
export function alignEventsToRows(events,rows,dateKey='date'){
 const dates=[...new Set(rows.map(row=>eventDay(row[dateKey])).filter(Boolean))].sort();
 return events.map(event=>{
  const positionDate=!event.scheduled&&dates.length&&event.date>=dates[0]&&event.date<=dates.at(-1)?dates.find(date=>date>=event.date)??null:null;
  return {...event,positionDate,aligned:Boolean(positionDate&&positionDate!==event.date)};
 });
}
