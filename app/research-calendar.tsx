"use client";

import {useCallback,useEffect,useMemo,useState} from 'react';
import {CalendarDays,Download,ExternalLink,Search,RefreshCw} from 'lucide-react';
import {useObserver} from './observer-context';
import {policyCalendar,policyCalendarSourceCheckedAt} from '../lib/policy-calendar';
import {appBase,researchCalendarEndpoint} from '../lib/runtime';
import {beijingDay,parseNotebook,type ResearchNote} from '../lib/research-notebook.mjs';
import {buildResearchCalendar,filterResearchCalendar,researchCalendarIcs,RESEARCH_CALENDAR_CATEGORIES,type MacroReleaseCalendar,type ResearchEventCategory,type ResearchCalendarEvent} from '../lib/research-calendar.mjs';
import './research-calendar.css';

const NOTEBOOK_STORAGE='macro-observatory:research-notebook:v1';
const NOTEBOOK_CHANGE='macro-observatory:notebook-change';
const categories=Object.keys(RESEARCH_CALENDAR_CATEGORIES) as ResearchEventCategory[];
const sourceLabels:Record<string,string>={ready:'已核对日程',cached:'日程缓存',fetch_failed:'来源检查失败',partial_failure:'部分来源检查失败',stale:'日程待复核',not_configured:'来源未配置',unknown:'核对时间未提供',personal:'个人计划'};
const formatClock=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const formatDay=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'UTC',month:'long',day:'numeric',weekday:'short'}).format(new Date(value+'T00:00:00Z'));
function checked(value:string|null){if(!value||!Number.isFinite(Date.parse(value)))return '未提供';return value.length===10?value:new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(value));}
function useCalendarNotes(){
 const [notes,setNotes]=useState<ResearchNote[]>([]),[error,setError]=useState('');
 useEffect(()=>{const read=()=>{try{const raw=localStorage.getItem(NOTEBOOK_STORAGE);setNotes(raw?parseNotebook(raw):[]);setError('');}catch{setError('本机笔记暂时无法读取，复盘计划未显示。');}};const storage=(event:StorageEvent)=>{if(event.key===NOTEBOOK_STORAGE||event.key===null)read();};read();window.addEventListener(NOTEBOOK_CHANGE,read);window.addEventListener('storage',storage);return()=>{window.removeEventListener(NOTEBOOK_CHANGE,read);window.removeEventListener('storage',storage);};},[]);
 return {notes,error};
}
function phase(event:ResearchCalendarEvent,now:string,today:string){
 if(event.category==='review')return event.day<today?'待补复盘':event.day===today?'今天复盘':'计划复盘';
 if(event.at)return Date.parse(event.at)<=Date.parse(now)?'计划时间已到':'即将公布';
 return event.day<today?'日程已过':event.day===today?'来源当地日期为今天':'已公布日期';
}

export function ResearchCalendar({onNavigate}:{onNavigate?:(href:string)=>void}){
 const {inputs,catalog,loading,errors,refresh}=useObserver();
 const notebook=useCalendarNotes();
 const [calendar,setCalendar]=useState<MacroReleaseCalendar|null>(null),[calendarError,setCalendarError]=useState(''),[calendarLoading,setCalendarLoading]=useState(false);
 const [now,setNow]=useState(()=>new Date().toISOString()),[range,setRange]=useState('30'),[activeCategories,setActiveCategories]=useState<ResearchEventCategory[]>(categories),[query,setQuery]=useState(''),[overdue,setOverdue]=useState(true),[routine,setRoutine]=useState(false);
 const [selected,setSelected]=useState<Set<string>>(()=>new Set()),[reminder,setReminder]=useState<'day'|'hour'|'none'>('day'),[notice,setNotice]=useState('');
 const [reload,setReload]=useState(0);
 useEffect(()=>{
  let active=true;let busy=false;
  const load=async()=>{if(busy)return;busy=true;if(active)setCalendarLoading(true);try{const response=await fetch(researchCalendarEndpoint(),{cache:'no-store',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('http');const value=await response.json() as MacroReleaseCalendar;if(!Array.isArray(value.fred)||value.fred.some(row=>!Array.isArray(row.events)))throw Error('schema');if(active){setCalendar(value);setCalendarError('');if(reload>0)setNotice('已读取后台最新日程，来源核对时间见各条记录。');}}catch{if(active){setCalendarError('经济发布日历暂时无法读取；已加载的日程继续保留。');if(reload>0)setNotice('本次检查未完成，保留已加载日程。');}}finally{busy=false;if(active)setCalendarLoading(false);}};
  const update=()=>{if(!document.hidden){setNow(new Date().toISOString());void load();}};
  void load();const timer=window.setInterval(update,300000),clock=window.setInterval(()=>setNow(new Date().toISOString()),60000);window.addEventListener('observer:refresh',update);document.addEventListener('visibilitychange',update);
  return()=>{active=false;clearInterval(timer);clearInterval(clock);window.removeEventListener('observer:refresh',update);document.removeEventListener('visibilitychange',update);};
 },[reload]);
 const model=useMemo(()=>buildResearchCalendar({policyEvents:policyCalendar,policyCheckedAt:policyCalendarSourceCheckedAt,macroCalendar:calendarError&&calendar?{...calendar,fred:calendar.fred.map(row=>({...row,status:row.events.length?'cached':'fetch_failed'}))}:calendar,macro:inputs.macro,industry:inputs.industry,notes:notebook.notes,catalog,now}),[calendar,calendarError,inputs.macro,inputs.industry,notebook.notes,catalog,now]);
 const today=beijingDay(now)!;
 const visible=useMemo(()=>filterResearchCalendar(model.events,{today,range,categories:activeCategories,query,includeOverdue:overdue,includeRoutine:routine}),[model.events,today,range,activeCategories,query,overdue,routine]);
 const days=useMemo(()=>[...new Set(visible.map(event=>event.day))],[visible]);
 const selectedRows=visible.filter(event=>selected.has(event.id));
 const open=useCallback((href:string)=>{if(onNavigate)onNavigate(href);else window.location.assign(href);},[onNavigate]);
 function toggleCategory(category:ResearchEventCategory){setActiveCategories(value=>value.includes(category)?value.filter(item=>item!==category):[...value,category]);}
 function exportSelected(){const text=researchCalendarIcs(selectedRows,{reminder});const url=URL.createObjectURL(new Blob([text],{type:'text/calendar;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=`研究日历-${today}.ics`;link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice(`已导出 ${selectedRows.length} 项日程，可导入手机或电脑日历。`);}
 return <section className="research-calendar" aria-label="统一研究日历">
  <div className="rc-intro"><div><CalendarDays size={24} aria-hidden="true"/><div><h2>把研究安排放在一张日历里</h2><p>央行决议、经济发布、公司财报和笔记复盘，按日期一起查看。</p></div></div><button type="button" onClick={()=>{refresh();setReload(value=>value+1);setNotice('正在检查日程和产业数据。');}} disabled={calendarLoading||loading}><RefreshCw size={15} className={calendarLoading?'spinning':''}/>{calendarLoading||loading?'检查中':'检查日程'}</button></div>
  <div className="rc-coverage" aria-label="已收录的未来日程">{model.byCategory.map(item=><button type="button" key={item.category} onClick={()=>setActiveCategories([item.category])} aria-pressed={activeCategories.length===1&&activeCategories[0]===item.category}><span>{RESEARCH_CALENDAR_CATEGORIES[item.category]}</span><strong>{item.count}<small>项已知日程</small></strong><small>{item.through?`已收录至 ${item.through}`:item.category==='review'?'在观察笔记中设置复盘日期':item.category==='earnings'?'下次官方财报日期尚未收录':loading?'正在读取来源':'暂无已收录的未来日期'}</small></button>)}</div>
  <div className="rc-controls"><div className="rc-categories" aria-label="日程分类">{categories.map(category=><label key={category}><input type="checkbox" checked={activeCategories.includes(category)} onChange={()=>toggleCategory(category)}/>{RESEARCH_CALENDAR_CATEGORIES[category]}</label>)}</div><div className="rc-filters"><label>查看范围<select value={range} onChange={event=>setRange(event.target.value)}><option value="7">未来 7 天</option><option value="30">未来 30 天</option><option value="90">未来 90 天</option><option value="past7">过去 7 天与今天</option></select></label><label className="rc-search"><span><Search size={14}/>搜索</span><input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="央行、公司或指标"/></label><label className="rc-check"><input type="checkbox" checked={overdue} onChange={event=>setOverdue(event.target.checked)}/>同时显示逾期未复盘</label><label className="rc-check"><input type="checkbox" checked={routine} onChange={event=>setRoutine(event.target.checked)}/>包含日常行情发布</label></div></div>
  <p className="rc-time-note">有具体时刻的日程统一显示北京时间；只公布日期的日程保留来源当地日期。</p>
  {(calendarError||notebook.error||errors.length>0)&&<div className="rc-message rc-warning" role="status">{[calendarError,notebook.error,...errors].filter(Boolean).join(' ')}</div>}
  <div className="rc-export"><label className="rc-check"><input type="checkbox" checked={visible.length>0&&selectedRows.length===visible.length} disabled={!visible.length} onChange={event=>setSelected(event.target.checked?new Set(visible.map(item=>item.id)):new Set())}/>选择当前结果（{visible.length}）</label><label>提前提醒<select value={reminder} onChange={event=>setReminder(event.target.value as typeof reminder)}><option value="day">1 天</option><option value="hour">1 小时（仅有时刻的日程）</option><option value="none">不提醒</option></select></label><button type="button" disabled={!selectedRows.length} onClick={exportSelected}><Download size={15}/>导出所选 {selectedRows.length?`(${selectedRows.length})`:''}</button></div>
  {notice&&<p className="rc-message" role="status">{notice}</p>}
  {visible.length?<div className="rc-agenda">{days.map(day=><section key={day} aria-label={day}><header><time dateTime={day}>{formatDay(day)}</time><span>{day===today?'今天':day<today?'已过日期':day.slice(0,4)}</span></header><div>{visible.filter(event=>event.day===day).map(event=><article className={`rc-event rc-event-${event.category}`} key={event.id}><label className="rc-event-check"><input type="checkbox" checked={selected.has(event.id)} aria-label={`选择 ${event.title} ${event.day}`} onChange={change=>setSelected(value=>{const next=new Set(value);if(change.target.checked)next.add(event.id);else next.delete(event.id);return next;})}/></label><div className="rc-event-time"><strong>{event.at?formatClock(event.at):event.category==='review'?'全天':'时刻未公布'}</strong><small>{event.at?'北京时间':event.category==='review'?'个人计划':event.timezone||'来源日期'}</small></div><div className="rc-event-main"><div className="rc-event-title"><span className="rc-kind">{RESEARCH_CALENDAR_CATEGORIES[event.category]}</span><h3>{event.title}</h3></div><p>{event.detail}</p><div className="rc-event-meta"><span>{phase(event,now,today)}</span><span className={['ready','personal'].includes(event.sourceStatus)?'':'rc-source-warning'}>{sourceLabels[event.sourceStatus]??event.sourceStatus}</span>{event.checkedAt&&<span>核对 {checked(event.checkedAt)}</span>}</div><div className="rc-event-links">{event.sourceUrl&&<a href={event.sourceUrl} target="_blank" rel="noopener noreferrer">{event.sourceName}<ExternalLink size={12}/></a>}{event.category==='review'?<button type="button" onClick={()=>open(appBase()+'?page=notebook')}>去复盘 →</button>:event.relatedHref?<button type="button" onClick={()=>open(event.relatedHref!)}>查看相关指标 →</button>:event.category==='policy'?<button type="button" onClick={()=>open(appBase()+'?page=policy-calendar')}>查看央行利率 →</button>:null}</div></div></article>)}</div></section>)}</div>:<div className="rc-empty">{loading||calendarLoading?'正在读取日程…':!activeCategories.length?'请选择至少一种日程。':query?'没有找到匹配的日程，试试其他关键词。':'当前范围没有已收录日程。可以扩大时间范围，或在观察笔记里安排复盘。'}</div>}
  <details className="rc-sources"><summary>日程覆盖与来源状态</summary><p>经济发布日程来自后台已取得的官方日历；财报只显示官方公告明确给出的日期。日程变化后重新导出 ICS，并在个人日历中核对更新。</p><p>央行日程人工核对日期：{policyCalendarSourceCheckedAt}。财报列表与宏观日历随后台采集更新。笔记复盘保存在当前浏览器。</p><div className="rc-source-list">{model.coverage.map(row=><div key={row.id}><strong>{row.title}</strong><span>{sourceLabels[row.status]??row.status}</span><span>{row.note}</span><small>最近核对 {checked(row.checkedAt)}</small>{row.sourceUrl&&<a href={row.sourceUrl} target="_blank" rel="noopener noreferrer">来源 ↗</a>}</div>)}</div>{!calendar?.fred.length&&<p>完整经济日历尚未取得，当前显示指标记录中已有的下一次官方发布时间。</p>}{!inputs.industry&&<p>产业数据尚未加载，公司财报日程等待数据恢复。</p>}</details>
 </section>;
}
export default ResearchCalendar;
