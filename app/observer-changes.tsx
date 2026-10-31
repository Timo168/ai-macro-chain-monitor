"use client";
import {useEffect,useMemo,useState} from 'react';
import {beijing} from '@/lib/data';
import {buildVisitSnapshot,compareVisitSnapshots,mergeVisitBaseline,validVisitSnapshot,stateLabel} from '@/lib/observer-changes.mjs';
import {useObserver} from './observer-context';
import {PanelToggle,PanelBody,usePanelDisclosure} from './panel-disclosure';
import './observer-changes.css';

const KEY='macro-observatory:visit-baseline:v1';
const kinds=[['all','全部变化'],['new','新增观测'],['revision','修订与补齐'],['failure','获取失败'],['recovery','已恢复']] as const;
export function ObserverChanges({onNavigate}:{onNavigate:(href:string)=>void}){
 const {inputs,catalog,loading,errors,refresh}=useObserver();
 const [baseline,setBaseline]=useState<ReturnType<typeof buildVisitSnapshot>|null>(null),[ready,setReady]=useState(false),[storageError,setStorageError]=useState(false),[kind,setKind]=useState('all'),[limit,setLimit]=useState(6);
 const fold=usePanelDisclosure('overview:changes',{defaultOpen:true});
 const snapshot=useMemo(()=>buildVisitSnapshot(inputs,catalog),[inputs,catalog]);
 useEffect(()=>{try{const stored=JSON.parse(localStorage.getItem(KEY)??'null');if(validVisitSnapshot(stored))setBaseline(stored);}catch{setStorageError(true)}setReady(true)},[]);
 function save(){const next=mergeVisitBaseline(baseline,snapshot);try{localStorage.setItem(KEY,JSON.stringify(next));setStorageError(false)}catch{setStorageError(true)}setBaseline(next);}
 useEffect(()=>{
  if(!ready||loading||!snapshot.scopes.length)return;
  if(!baseline){save();return;}
  const missing=snapshot.scopes.filter(scope=>!baseline.scopes.includes(scope));
  if(missing.length){
   const next={...baseline,scopes:[...baseline.scopes,...missing],records:{...baseline.records,...Object.fromEntries(Object.entries(snapshot.records).filter(([,row])=>missing.includes(row.scope)))}};
   try{localStorage.setItem(KEY,JSON.stringify(next))}catch{setStorageError(true)}setBaseline(next);
  }
 },[ready,loading,snapshot,baseline]); // A newly loaded module establishes its own baseline.
 const events=useMemo(()=>compareVisitSnapshots(baseline,snapshot),[baseline,snapshot]);
 const visible=events.filter(event=>kind==='all'||event.kind===kind);
 const issues=Object.values(snapshot.records).filter(row=>row.bad);
 return <section className="observer-changes" aria-label="跨模块变化与更新状态">
  <div className="observer-changes-heading"><div><span className="eyebrow">SINCE YOUR LAST REVIEW</span><h2>这次打开，哪些值得看</h2><p>{baseline?`与 ${beijing(baseline.observedAt)}（北京）确认的版本比较`:'首次打开将建立对比基线，历史数据不计为刚刚发布。'}</p></div><PanelToggle open={fold.open} onToggle={fold.toggle} controls={fold.contentId} label="跨模块变化与更新状态"/></div>
  <div className="observer-change-counts">{kinds.slice(1).map(([id,label])=><button key={id} aria-pressed={kind===id} onClick={()=>{setKind(id);setLimit(6);fold.setOpen(true)}}><strong>{events.filter(event=>event.kind===id).length}</strong><span>{label}</span></button>)}</div>
  <PanelBody open={fold.open} id={fold.contentId}>
   <div className="observer-change-controls"><div>{kinds.map(([id,label])=><button key={id} aria-pressed={kind===id} onClick={()=>{setKind(id);setLimit(6)}}>{label}</button>)}</div><button onClick={save} disabled={loading||!snapshot.scopes.length}>标记当前变化已看</button><button onClick={refresh}>核对跨模块更新</button></div>
   <p className="observer-change-note">只比较观测数值、历史修订与来源状态。重新抓取但数据没变，不计入变化；尚未到月度发布日也不算失败。首次成功加载的模块先建立基线，不把整段历史计为新增。此处数量为变化条目数。</p>
   {loading&&<p role="status">正在核对产业、估值和央行数据…</p>}
   {storageError&&<p role="alert">浏览器暂不能保存对比基线，本次仍可查看；刷新后可能无法保留记录。</p>}
   {!!errors.length&&<p role="alert">{errors.join('；')}。未读取模块不会被算成数据消失。</p>}
   <ul className="observer-change-list">{visible.slice(0,limit).map((event,index)=><li key={event.id+index}><div><span>{kinds.find(([id])=>id===event.kind)?.[1]}</span><strong>{event.title}</strong><p>{event.description}</p></div>{event.href&&<button onClick={()=>onNavigate(event.href)}>查看对应数据 ↗</button>}</li>)}</ul>
   {!loading&&!visible.length&&<p className="observer-change-empty">该范围内没有新的变化。当前来源问题仍显示在下方，未因“已看”而消失。</p>}
   {visible.length>limit&&<button onClick={()=>setLimit(value=>value+10)}>再显示 10 条</button>}
   <details><summary>当前需要核对的来源 · {issues.length} 项</summary>{issues.length?<ul>{issues.map(row=><li key={row.id}>{row.title}：{stateLabel(row.status)}{row.period&&` · 最后有效观测 ${row.period}`}{row.href&&<button onClick={()=>onNavigate(row.href)}>查看</button>}</li>)}</ul>:<p>已加载范围内暂无获取失败或发布延迟。未配置、待授权和未发布不等于已经接通。</p>}</details>
  </PanelBody>
 </section>;
}
