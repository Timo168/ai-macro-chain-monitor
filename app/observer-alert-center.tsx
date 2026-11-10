"use client";
import {createContext,useContext,useEffect,useMemo,useState,type ReactNode,type FormEvent} from 'react';
import {Bell,Check,Download,Pause,Play,Plus,Trash2} from 'lucide-react';
import {useObserver} from './observer-context';
import {beijing,format} from '@/lib/data';
import type {ObservationItem} from '@/lib/observer-types';
import {appBase} from '@/lib/runtime';
import {applyObserverReadFailures} from '@/lib/observer-read-state.mjs';
import {ALERTS_STORAGE_KEY,alertRuleDescription,evaluateObserverAlerts,normalizeAlertRule,parseAlertStorage,serializeAlertStorage,type AlertRule,type AlertHistory} from '@/lib/observer-alerts.mjs';
import './observer-alert-center.css';

type Saved=ReturnType<typeof parseAlertStorage>;
type Result=ReturnType<typeof evaluateObserverAlerts>['results'][number];
type AlertContextValue={saved:Saved;results:Result[];error:string;ready:boolean;update:(change:(current:Saved)=>Saved)=>boolean};
const AlertContext=createContext<AlertContextValue|null>(null);
const CHANGE='macro-observatory:alerts-change';
function read():Saved{const parsed=parseAlertStorage(localStorage.getItem(ALERTS_STORAGE_KEY));if(parsed.status==='corrupt')throw Error('提醒记录无法读取，请先导出原始记录备份。已有内容已保留。');return parsed;}
function errorText(error:unknown){return error instanceof Error?error.message:'浏览器未允许保存，请检查本地存储设置。';}
function download(text:string,name:string){const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function AlertCenterProvider({children,macroError=false}:{children:ReactNode;macroError?:boolean}){
 const {catalog,errors}=useObserver();
 const [saved,setSaved]=useState<Saved>(()=>parseAlertStorage(null)),[error,setError]=useState(''),[ready,setReady]=useState(false);
 const [results,setResults]=useState<Result[]>([]);
 useEffect(()=>{const sync=()=>{try{setSaved(read());setError('');setReady(true)}catch(error){setError(errorText(error));setReady(false)}};const storage=(event:StorageEvent)=>{if(event.key===ALERTS_STORAGE_KEY||event.key===null)sync()};sync();addEventListener(CHANGE,sync);addEventListener('storage',storage);return()=>{removeEventListener(CHANGE,sync);removeEventListener('storage',storage)}},[]);
 const items=useMemo(()=>applyObserverReadFailures(catalog,errors,macroError),[catalog,errors,macroError]);
 function update(change:(current:Saved)=>Saved){try{const current=read(),next=change(current);const encoded=serializeAlertStorage(next.rules,next.state,next.history);localStorage.setItem(ALERTS_STORAGE_KEY,encoded);setSaved(parseAlertStorage(encoded));setError('');dispatchEvent(new Event(CHANGE));return true}catch(error){setError(errorText(error));return false}}
 useEffect(()=>{
  if(!ready||!catalog.length)return;
  try{
   const current=read(),evaluated=evaluateObserverAlerts(current.rules,items,current.state);
   setResults(evaluated.results);
   const byId=new Map(items.map(item=>[item.id,item]));
   const existingIds=new Set(current.history.map(event=>event.id));
   const added:AlertHistory[]=evaluated.events.filter(event=>event.fingerprint&&!existingIds.has(event.fingerprint)).map(event=>{const item=byId.get(event.itemId)!;return {id:event.fingerprint!,ruleId:event.ruleId,itemId:event.itemId,title:item.title,description:event.reason,date:event.date!,value:event.value!,unit:item.unit,triggeredAt:event.triggeredAt,read:false,href:item.href,sourceUrl:item.sourceUrl??undefined}});
   const history=[...added,...current.history].slice(0,200);
   const encoded=serializeAlertStorage(current.rules,evaluated.nextState,history);
   if(encoded!==serializeAlertStorage(current.rules,current.state,current.history)){localStorage.setItem(ALERTS_STORAGE_KEY,encoded);setSaved(parseAlertStorage(encoded));}
   setError('');
  }catch(error){setError(errorText(error));}
 },[items,ready,saved.rules]);
 return <AlertContext.Provider value={{saved,results,error,ready,update}}>{children}</AlertContext.Provider>;
}
function useAlerts(){const value=useContext(AlertContext);if(!value)throw Error('AlertCenterProvider missing');return value;}
export function AlertSummary({onNavigate}:{onNavigate:(href:string)=>void}){
 const {saved,error,ready}=useAlerts();const unread=saved.history.filter(event=>!event.read).length;
 return <section className="alert-summary" aria-label="我的提醒"><div><Bell size={18}/><strong>{unread?`${unread} 条提醒待查看`:'我的提醒'}</strong><span>{error?'提醒存储需要检查':!ready?'正在读取提醒…':saved.rules.length?`${saved.rules.filter(rule=>rule.enabled).length} 条规则启用 · ${unread?'有符合条件的新观测':'暂无新触发'}`:'设置你关心的数值和变化条件'}</span></div><button onClick={()=>onNavigate(appBase()+'?page=alerts')}>{unread?'查看提醒':'管理提醒'} ↗</button></section>;
}
const kinds=[['above','数值高于'],['below','数值低于'],['change_up','较上期上升至少'],['change_down','较上期下降至少'],['consecutive_up','连续上升'],['consecutive_down','连续下降'],['new_observation','出现新一期数据']] as const;
function thresholdUnit(kind:string,item?:ObservationItem){return kind.startsWith('consecutive')?'次变化':kind.startsWith('change')&&item?.unit==='%'?'个百分点':item?.unit??'';}
export default function ObserverAlertCenter({onNavigate}:{onNavigate:(href:string)=>void}){
 const {saved,results,error,ready,update}=useAlerts();const {catalog:rawCatalog,loading,errors}=useObserver();
 const catalog=useMemo(()=>applyObserverReadFailures(rawCatalog,errors),[rawCatalog,errors]);
 const [query,setQuery]=useState(''),[itemId,setItemId]=useState('macro:DGS10'),[kind,setKind]=useState<AlertRule['kind']>('above'),[threshold,setThreshold]=useState('5'),[notice,setNotice]=useState(''),[filter,setFilter]=useState('unread');
 const available=useMemo(()=>catalog.filter(item=>item.kind!=='policy'),[catalog]);
 const choices=useMemo(()=>available.filter(item=>`${item.title} ${item.searchTerms}`.toLowerCase().includes(query.trim().toLowerCase())),[available,query]);
 const selected=available.find(item=>item.id===itemId),byId=new Map(catalog.map(item=>[item.id,item])),byRule=new Map(results.map(result=>[result.ruleId,result]));
 const history=saved.history.filter(event=>filter==='all'||!event.read);
 function add(event:FormEvent){event.preventDefault();setNotice('');const rule=normalizeAlertRule({id:crypto.randomUUID(),itemId,kind,threshold:kind==='new_observation'?0:Number(threshold),enabled:true,createdAt:new Date().toISOString()});if(!rule||!selected||(!threshold.trim()&&kind!=='new_observation')){setNotice('请填写有效的指标与条件。');return;}const success=update(current=>{if(current.rules.length>=100)throw Error('最多保存 100 条规则，请先清理已不用的规则。');if(current.rules.some(existing=>existing.itemId===rule.itemId&&existing.kind===rule.kind&&existing.threshold===rule.threshold))throw Error('相同条件已经存在。');return {...current,rules:[...current.rules,rule]};});if(success)setNotice(kind==='new_observation'?'已保存。以首次成功读取的观测期为起点，之后有新一期数据时提醒。':'已保存。当前数值满足条件时会立即生成一条提醒。');}
 function changeRule(rule:AlertRule,action:'toggle'|'remove'){update(current=>({...current,rules:action==='remove'?current.rules.filter(row=>row.id!==rule.id):current.rules.map(row=>row.id===rule.id?{...row,enabled:!row.enabled}:row)}));}
 function markRead(id?:string){update(current=>({...current,history:current.history.map(event=>!id||id===event.id?{...event,read:true}:event)}));}
 function exportBackup(){try{const raw=localStorage.getItem(ALERTS_STORAGE_KEY)??serializeAlertStorage([],{},[]);download(raw,'观察台-提醒备份.json');setNotice('提醒规则与最近 200 条触发记录已导出。');}catch(error){setNotice(errorText(error));}}
 return <div className="alert-center">
  <div className="alert-intro"><div><strong>把值得关注的变化交给规则</strong><p>打开网站或数据更新时检查；同一观测不会重复提醒。规则与最近 200 条记录保存在当前浏览器。</p></div><button type="button" onClick={exportBackup}><Download size={15}/>导出提醒记录</button></div>
  {error&&<p className="alert-error" role="alert">{error}</p>}
  <section className="alert-panel"><h2><Plus size={18}/>添加提醒</h2><form onSubmit={add} className="alert-form">
   <label>查找指标<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="如美债、美元、核心 PCE、微软"/></label>
   <label className="alert-select">观察指标<select value={itemId} onChange={event=>setItemId(event.target.value)} required aria-label="提醒观察指标">{!choices.some(item=>item.id===itemId)&&selected&&<option value={selected.id}>{selected.title}</option>}{choices.map(item=><option key={item.id} value={item.id}>{item.title} · {item.unit}</option>)}</select></label>
   <label>触发条件<select value={kind} onChange={event=>{const next=event.target.value as AlertRule['kind'];setKind(next);if(next.startsWith('consecutive'))setThreshold('2')}}>{kinds.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
   {kind!=='new_observation'&&<label>阈值（{thresholdUnit(kind,selected)}）<input type="number" value={threshold} onChange={event=>setThreshold(event.target.value)} step={kind.startsWith('consecutive')?'1':'any'} min={kind.startsWith('consecutive')?'1':kind.startsWith('change')?'0':undefined} max={kind.startsWith('consecutive')?'24':undefined} required/></label>}
   <button className="alert-primary" type="submit" disabled={!ready||!selected}>保存提醒</button>
  </form>{loading&&<p role="status">正在加载其余指标，已加载的可先设置。</p>}{!choices.length&&query&&<p>没有匹配的指标，请换一个名称或代码。</p>}{selected&&<p className="alert-hint">当前：{selected.title} {selected.value} {selected.unit} · 观测 {selected.period} · {selected.status}。{kind.startsWith('consecutive')?'连续 2 次变化需要 3 个连续观测期。':kind.startsWith('change')?'变化按图表显示单位计算。':''}</p>}<p className="alert-hint">站内提醒在打开网页时运行；未来日程可在研究日历中导入个人日历。</p><p role="status" className="alert-feedback">{notice}</p></section>
  <section className="alert-panel"><h2>我的规则 <small>{saved.rules.length} 条</small></h2>{!saved.rules.length&&<p className="alert-empty">先添加一条，例如“两年期收益率高于 4%”或“核心 PCE 连续上升 2 次”。</p>}
   <div className="alert-rule-list">{saved.rules.map(rule=>{const item=byId.get(rule.itemId),result=byRule.get(rule.id);return <article key={rule.id}><div><strong>{item?.title??rule.itemId}</strong><p>{alertRuleDescription(rule,item)}</p><small className={result?.state==='unavailable'?'alert-warning':''}>{!rule.enabled?'已暂停':result?.reason??'等待数据读取'}{result?.date?' · '+result.date:''}</small></div><div className="alert-actions">{item&&<button type="button" onClick={()=>onNavigate(item.href)}>查看图表 ↗</button>}<button onClick={()=>changeRule(rule,'toggle')} aria-label={`${rule.enabled?'暂停':'启用'}${item?.title??rule.itemId}提醒`}>{rule.enabled?<Pause size={14}/>:<Play size={14}/>} {rule.enabled?'暂停':'启用'}</button><button onClick={()=>changeRule(rule,'remove')} aria-label={`删除${item?.title??rule.itemId}提醒规则`}><Trash2 size={14}/>删除规则</button></div></article>})}</div>
  </section>
  <section className="alert-panel"><div className="alert-section-title"><h2>触发记录</h2><div className="alert-actions"><button aria-pressed={filter==='unread'} onClick={()=>setFilter('unread')}>待查看</button><button aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>全部</button><button onClick={()=>markRead()} disabled={!saved.history.some(event=>!event.read)}><Check size={14}/>全部标记已看</button></div></div>
   {!history.length&&<p className="alert-empty">{filter==='unread'?'目前没有待查看的触发记录。':'满足规则后，这里会留下数值、观测日期与来源。'}</p>}
   <div className="alert-event-list">{history.map(event=><article key={event.id}><div><strong>{event.title}</strong><span className="alert-event-value">{format(event.value)} {event.unit}</span><p>{event.description}</p><small>观测 {event.date} · 首次提醒 {beijing(event.triggeredAt)}（北京）{event.read?' · 已查看':''}</small></div><div className="alert-actions"><button onClick={()=>{markRead(event.id);onNavigate(event.href)}}>查看图表 ↗</button>{event.sourceUrl&&<a href={event.sourceUrl} target="_blank" rel="noreferrer">来源 ↗</a>}{!event.read&&<button onClick={()=>markRead(event.id)}>标记已看</button>}</div></article>)}</div>
  </section>
 </div>;
}
