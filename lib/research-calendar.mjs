import {beijingDay,safeSourceUrl} from './research-notebook.mjs';

export const RESEARCH_CALENDAR_CATEGORIES={policy:'央行决议',macro:'经济数据',earnings:'公司财报',review:'我的复盘'};
const releaseGroups={
 10:{title:'美国 CPI 与核心 CPI',ids:['CPIAUCNS','CPILFENS','CPIAUCSL','CPILFESL']},
 50:{title:'美国非农就业与失业率',ids:['PAYEMS','UNRATE']},
 54:{title:'美国 PCE 与核心 PCE',ids:['PCEPI','PCEPILFE']},
 180:{title:'美国初次申请失业救济人数',ids:['ICSA']},
 221:{title:'芝加哥联储金融条件指数',ids:['NFCI']},
 18:{title:'美国国债收益率（H.15）',ids:['DGS2','DGS10','DFII10'],routine:true},
 17:{title:'美联储美元汇率指数（H.10）',ids:['DTWEXBGS']},
 212:{title:'EIA 能源价格数据',ids:['DCOILBRENTEU'],routine:true},
};
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
// A clock without an offset cannot safely become a Beijing event time.
const validInstant=value=>typeof value==='string'&&validDay(value.slice(0,10))&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
function timing(value){
 if(validDay(value))return {day:value,at:null,timeBasis:'date_only'};
 if(validInstant(value))return {day:beijingDay(value),at:new Date(value).toISOString(),timeBasis:'beijing'};
 return null;
}
export function calendarDayOffset(day,amount){if(!validDay(day)||!Number.isFinite(amount))return null;return new Date(Date.parse(day+'T00:00:00Z')+amount*86400000).toISOString().slice(0,10);}
function freshness(status,checkedAt,now){
 if(['cached','fetch_failed','partial_failure','not_configured'].includes(status))return status;
 if(!['ready','ok'].includes(status))return 'unknown';
 if(!checkedAt)return 'unknown';
 const value=Date.parse(checkedAt);
 if(!Number.isFinite(value))return 'unknown';
 return Date.parse(now)-value>7*86400000?'stale':'ready';
}
function related(catalog,ids){return (catalog??[]).find(item=>ids.some(id=>item.id===id||item.id===`macro:${id}`||item.id.startsWith(`macro:${id}:`)));}

/** Only explicit source schedules enter the calendar. Check times and fiscal ends never do. */
export function buildResearchCalendar({policyEvents=[],policyCheckedAt=null,macroCalendar=null,macro=null,industry=null,notes=[],catalog=[],now=new Date().toISOString()}={}){
 const events=[],coverage=[],seen=new Set();
 const today=beijingDay(now);
 function add(row){
  const time=timing(row.when);if(!time||seen.has(row.id))return;
  const sourceUrl=safeSourceUrl(row.sourceUrl);
  if(row.category!=='review'&&!sourceUrl)return;
  seen.add(row.id);events.push({...row,...time,sourceUrl,when:undefined});
 }
 for(const event of policyEvents){
  if(event.scheduleType!=='official')continue;
  add({id:`policy:${event.id}`,category:'policy',title:`${event.bank} · 利率决议`,entity:event.country??'',when:event.announcedAt??event.decisionDate,detail:event.title,sourceUrl:event.sourceUrl,sourceName:event.bank,sourceStatus:freshness('ready',policyCheckedAt,now),checkedAt:policyCheckedAt,timezone:event.timezone??'',relatedHref:null});
 }
 const coveredGroups=new Set();
 for(const entry of macroCalendar?.fred??[]){
  const group=releaseGroups[entry.releaseId];if(!group)continue;
  const link=related(catalog,group.ids);
  const status=freshness(entry.status,entry.fetchedAt,now);
  const before=events.length;
  for(const event of entry.events??[])add({id:`macro:${entry.releaseId}:${event.scheduledAt}`,category:'macro',title:group.title,entity:'美国',when:event.scheduledAt,detail:'官方发布日程',sourceUrl:event.calendarUrl??entry.sourceUrl,sourceName:entry.releaseId===54&&entry.sourceUrl?.includes('bea.gov')?'美国经济分析局 BEA':'FRED 发布日历',sourceStatus:status,checkedAt:entry.fetchedAt??null,timezone:'',relatedHref:link?.href??null,routine:group.routine===true});
  if(events.length>before)coveredGroups.add(Number(entry.releaseId));
  coverage.push({id:`macro:${entry.releaseId}`,category:'macro',title:group.title,status,checkedAt:entry.fetchedAt??null,sourceUrl:safeSourceUrl(entry.sourceUrl),note:(entry.events??[]).length?'已载入官方日程':'尚未取得发布日程'});
 }
 // The per-series publication record is an official-calendar fallback, not the next polling time.
 for(const [rid,group] of Object.entries(releaseGroups)){
  if(coveredGroups.has(Number(rid)))continue;
  const candidates=group.ids.map(id=>macro?.series?.[id]).filter(series=>series?.publication?.nextReleaseAt&&['ok','ready','cached'].includes(series.publication.calendarStatus)&&safeSourceUrl(series.publication.calendarSource));
  for(const series of candidates){const publication=series.publication,link=related(catalog,group.ids);add({id:`macro:${rid}:${publication.nextReleaseAt}`,category:'macro',title:group.title,entity:'美国',when:publication.nextReleaseAt,detail:'最近一次取得的官方计划发布时间',sourceUrl:publication.calendarSource,sourceName:'指标发布日历',sourceStatus:freshness(publication.calendarStatus,series.checkedAt??series.fetchedAt,now),checkedAt:series.checkedAt??series.fetchedAt??null,timezone:'',relatedHref:link?.href??null,routine:group.routine===true});}
 }
 for(const update of industry?.financialUpdates??[]){
  const status=freshness(update.sourceStatus,update.lastSuccessfulAt??update.checkedAt,now);
  const link=(catalog??[]).find(item=>item.kind==='industry'&&item.id.startsWith(`industry:${update.entity}.`));
  for(const [kind,release] of [['published',update.release],['upcoming',update.upcoming]]){
   if(!release)continue;
   // publishedAt on an upcoming announcement is the announcement date, NOT its earnings event date.
   const when=kind==='upcoming'?(release.releaseAt??release.eventAt):release.publishedAt;
   const time=timing(when);if(!time)continue;
   add({id:`earnings:${update.entity}:${release.fiscalYear}:Q${release.quarter}:${time.day}`,category:'earnings',title:`${update.entity} · FY${release.fiscalYear} Q${release.quarter} 财报`,entity:update.entity,when,detail:kind==='published'?'已发布财报':release.title??'官方已公布的财报日程',sourceUrl:release.url,sourceName:`${update.entity} 投资者关系`,sourceStatus:status,checkedAt:update.lastSuccessfulAt??update.checkedAt??null,timezone:'来源未给出具体时刻',relatedHref:link?.href??null});
  }
  coverage.push({id:`earnings:${update.entity}`,category:'earnings',title:update.entity,status,checkedAt:update.lastSuccessfulAt??update.checkedAt??null,sourceUrl:safeSourceUrl(update.sourceUrl),note:timing(update.upcoming?.releaseAt??update.upcoming?.eventAt)?'已取得下次财报日程':'下次财报日期尚未收录'});
 }
 for(const note of notes){
  if(note.reviewStatus==='completed'||!validDay(note.reviewOn))continue;
  add({id:`review:${note.id}`,category:'review',title:note.title,entity:'我的复盘',when:note.reviewOn,detail:note.snapshot?.title?`回看：${note.snapshot.title}`:'按计划回看研究笔记',sourceUrl:null,sourceName:'当前浏览器的研究笔记',sourceStatus:'personal',checkedAt:note.updatedAt??null,timezone:'北京时间',relatedHref:null});
 }
 events.sort((a,b)=>a.day.localeCompare(b.day)||(a.at??'').localeCompare(b.at??'')||a.title.localeCompare(b.title,'zh-CN'));
 const byCategory=Object.keys(RESEARCH_CALENDAR_CATEGORIES).map(category=>{
  const rows=events.filter(event=>event.category===category&&event.day>=today);
  return {category,count:rows.length,through:rows.at(-1)?.day??null};
 });
 return {events,coverage,byCategory};
}

export function filterResearchCalendar(events,{today,range='30',categories=Object.keys(RESEARCH_CALENDAR_CATEGORIES),query='',includeOverdue=true,includeRoutine=false}={}){
 if(!validDay(today))return [];
 const from=range==='past7'?calendarDayOffset(today,-7):today;
 const to=range==='past7'?today:calendarDayOffset(today,Number(range)-1);
 if(!to)return [];
 const needle=query.trim().toLocaleLowerCase();
 return events.filter(event=>(includeRoutine||!event.routine)&&categories.includes(event.category)&&((event.day>=from&&event.day<=to)||(range!=='past7'&&includeOverdue&&event.category==='review'&&event.day<today))&&(!needle||[event.title,event.entity,event.detail,event.sourceName].join(' ').toLocaleLowerCase().includes(needle)));
}

const escapeIcs=value=>String(value??'').replaceAll('\\','\\\\').replace(/\r\n|\r|\n/g,'\\n').replaceAll(';','\\;').replaceAll(',','\\,');
const icsStamp=value=>new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
// RFC 5545: fold by UTF-8 octets; a continuation space counts toward 75 bytes.
function foldIcs(line){const rows=[];let part='',size=0;for(const character of line){const bytes=new TextEncoder().encode(character).length;if(size+bytes>75){rows.push(part);part=' ';size=1;}part+=character;size+=bytes;}rows.push(part);return rows.join('\r\n');}
export function researchCalendarIcs(events,{now=new Date().toISOString(),reminder='day'}={}){
 if(!validInstant(now))throw new Error('导出时间无效。');
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//AI Macro Observatory//Research Calendar//ZH','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
 for(const event of [...new Map(events.map(event=>[event.id,event])).values()]){
  if(!validDay(event.day)||event.at&&!validInstant(event.at))continue;
  const description=[event.detail,event.at?'北京时间显示；日历按所在时区转换':`日期按来源日历；${event.timezone||'具体时刻未提供'}`,event.sourceName,event.sourceStatus==='ready'?'':`来源状态：${event.sourceStatus}`,safeSourceUrl(event.sourceUrl)].filter(Boolean).join('\n');
  lines.push('BEGIN:VEVENT',`UID:${encodeURIComponent(event.id)}@ai-macro-observatory`,`DTSTAMP:${icsStamp(now)}`,event.at?`DTSTART:${icsStamp(event.at)}`:`DTSTART;VALUE=DATE:${event.day.replaceAll('-','')}`);
  if(!event.at)lines.push(`DTEND;VALUE=DATE:${calendarDayOffset(event.day,1).replaceAll('-','')}`);
  lines.push(`SUMMARY:${escapeIcs(event.title)}`,`DESCRIPTION:${escapeIcs(description)}`);
  if(safeSourceUrl(event.sourceUrl))lines.push(`URL:${safeSourceUrl(event.sourceUrl)}`);
  if(reminder!=='none')lines.push('BEGIN:VALARM',`TRIGGER:${reminder==='hour'&&event.at?'-PT1H':'-P1D'}`,'ACTION:DISPLAY',`DESCRIPTION:${escapeIcs(event.title)}`,'END:VALARM');
  lines.push('END:VEVENT');
 }
 lines.push('END:VCALENDAR');return lines.map(foldIcs).join('\r\n')+'\r\n';
}
