"use client";
import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {ArrowDown,ArrowUp,ArrowUpRight,Check,ExternalLink,Pin,Plus,Search,X} from 'lucide-react';
import type {ObservationItem} from '@/lib/observer-types';
import {beijing} from '@/lib/data';
import {appBase} from '@/lib/runtime';
import {defaultObserverPins,observerPinsEvent,observerPinsKey,parseObserverPins,searchObserverItems,updateObserverPins} from '@/lib/observer-preferences.mjs';
import './observer-workspace.css';

type Props={items:ObservationItem[];loading:boolean;onOpen:(item:ObservationItem)=>void};
const kindNames:Record<string,string>={all:'全部',macro:'宏观与商品',industry:'产业与公司',valuation:'公司估值',policy:'央行利率'};
let inMemoryPins:string[]|null=null;
let memoryOnly=false;
function readPins(){if(memoryOnly&&inMemoryPins)return inMemoryPins;try{return parseObserverPins(localStorage.getItem(observerPinsKey)) as string[];}catch{memoryOnly=true;return inMemoryPins??[...defaultObserverPins];}}
function useObserverPins(){
 const [ids,setIds]=useState<string[]>(defaultObserverPins),[saved,setSaved]=useState(true);
 useEffect(()=>{const sync=()=>{setIds(readPins());setSaved(!memoryOnly)};const storage=(event:StorageEvent)=>{if(event.key===observerPinsKey||event.key===null){memoryOnly=false;sync()}};sync();addEventListener(observerPinsEvent,sync);addEventListener('storage',storage);return()=>{removeEventListener(observerPinsEvent,sync);removeEventListener('storage',storage)}},[]);
 function update(id:string,action:'toggle'|'up'|'down'){
  const next=updateObserverPins(readPins(),id,action) as string[];inMemoryPins=next;
  try{localStorage.setItem(observerPinsKey,JSON.stringify({version:1,ids:next}));memoryOnly=false;setSaved(true)}catch{memoryOnly=true;setSaved(false)}
  setIds(next);dispatchEvent(new Event(observerPinsEvent));
 }
 return {ids,update,saved};
}
export function ObserverPin({itemId,title}:{itemId:string;title:string}){
 const {ids,update,saved}=useObserverPins();const pinned=ids.includes(itemId);
 return <span className="observer-pin-wrap"><button type="button" className={'observer-pin '+(pinned?'is-pinned':'')} onClick={()=>update(itemId,'toggle')} aria-pressed={pinned} aria-label={`${pinned?'从工作台移除':'固定到工作台'}${title}`} title={pinned?'已固定，点击移除':'固定到我的工作台'}><Pin size={14} fill={pinned?'currentColor':'none'}/><span>{pinned?'已固定':'固定'}</span></button>{!saved&&<small role="status">仅本次有效</small>}</span>;
}
function MiniTrend({item}:{item:ObservationItem}){
 const points=(item.points??[]).slice(-30);const values=points.flatMap(point=>point.value!=null&&Number.isFinite(point.value)?[point.value]:[]);
 if(values.length<2)return <span className="observer-trend-empty">历史点不足，暂不绘线</span>;
 const dates=points.map(point=>Date.parse(point.date)),minimum=Math.min(...values),maximum=Math.max(...values),first=Math.min(...dates),last=Math.max(...dates);let drawing=false;
 const path=points.map((point,index)=>{if(point.value==null||!Number.isFinite(point.value)||!Number.isFinite(dates[index])){drawing=false;return ''}const x=3+(last===first?0:(dates[index]-first)/(last-first))*174,y=44-(maximum===minimum?0.5:(point.value-minimum)/(maximum-minimum))*38;const command=drawing?'L':'M';drawing=true;return `${command}${x.toFixed(1)},${y.toFixed(1)}`}).join(' ');
 return <svg className="observer-trend" viewBox="0 0 180 50" role="img" aria-label={`${item.title}最近${points.length}期趋势，缺值处留空`}><title>同一指标最近 {points.length} 期，缺值不连接{item.kind==='policy'?'；小图为月末历史，最新决议单独显示':''}</title><path d={path} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round"/></svg>;
}
function ResultList({items,onOpen}:{items:ObservationItem[];onOpen:Props['onOpen']}){
 return <ul className="observer-results">{items.map(item=><li key={item.id}><button type="button" className="observer-result-open" onClick={()=>onOpen(item)}><span className="observer-result-name"><small>{kindNames[item.kind]}</small><strong>{item.title}</strong><span>{item.subtitle}</span></span><span className="observer-result-data"><b>{item.value} <small>{item.unit}</small></b><span>{item.period}</span><small className={item.warning?'observer-warning':''}>{item.status}</small></span><ArrowUpRight size={17}/></button><ObserverPin itemId={item.id} title={item.title}/></li>)}</ul>;
}
export function ObserverWorkspace({items,loading,onOpen}:Props){
 const {ids,update,saved}=useObserverPins();const [adding,setAdding]=useState(false),[query,setQuery]=useState(''),[visible,setVisible]=useState(12),[feedback,setFeedback]=useState('');
 const byId=useMemo(()=>new Map(items.map(item=>[item.id,item])),[items]);
 const choices=useMemo(()=>searchObserverItems(items,query).filter((item:ObservationItem)=>!ids.includes(item.id)) as ObservationItem[],[items,query,ids]);
 function move(id:string,action:'up'|'down'){update(id,action);setFeedback(`${byId.get(id)?.title??id}已${action==='up'?'上移':'下移'}。`)}
 return <section className="observer-workspace" aria-label="我的工作台"><div className="observer-section-heading"><div><h2>我的工作台</h2><p>把常看的指标放在一起。数值沿用来源口径，观察期与检查时间分别保留。</p></div><button type="button" className="observer-action" aria-expanded={adding} onClick={()=>setAdding(value=>!value)}><Plus size={16}/>{adding?'收起添加列表':'添加指标'}</button></div><p className="observer-storage-note">排列与收藏保存在当前浏览器，可随时通过 ↑ ↓ 调整顺序。{!saved&&<strong>浏览器未允许保存，本次修改仅在当前页面有效。</strong>}</p><p className="observer-sr-only" role="status">{feedback}</p>
  {adding&&<div className="observer-add-box"><label>查找要固定的指标<input type="search" value={query} onChange={event=>{setQuery(event.target.value);setVisible(12)}} placeholder="如黄金、核心 PCE、微软、MSFT、日本"/></label>{loading&&<p role="status">其余数据正在加载，已加载的指标可先添加。</p>}<ResultList items={choices.slice(0,visible)} onOpen={onOpen}/>{choices.length>visible&&<button type="button" className="observer-action" onClick={()=>setVisible(value=>value+12)}>再显示 12 项（剩余 {choices.length-visible}）</button>}{!choices.length&&<p>{loading?'正在补充搜索目录…':query?'没有匹配的未收藏指标，可以换一个名称或代码。':'当前所有已加载指标均已固定。'}</p>}</div>}
  {!ids.length&&<div className="observer-empty"><Pin size={23}/><h3>工作台还没有指标</h3><p>点击“添加指标”，或在图表与搜索结果旁点击“固定”。</p><button type="button" className="observer-action" onClick={()=>setAdding(true)}>选择指标</button></div>}
  <div className="observer-card-grid">{ids.map((id,index)=>{const item=byId.get(id);return <article className="observer-card" key={id}><div className="observer-card-header"><div><span className="observer-kicker">{item?kindNames[item.kind]:'已固定的指标'}</span><h3>{item?.title??id}</h3></div><button type="button" className="observer-icon-button" onClick={()=>{update(id,'toggle');setFeedback(`已从工作台移除${item?.title??id}。`)}} aria-label={`从工作台移除${item?.title??id}`} title="取消固定"><X size={16}/></button></div>{item?<><p className="observer-card-subtitle">{item.subtitle}</p><div className="observer-card-value"><div><strong>{item.value}</strong><small>{item.unit}</small></div><MiniTrend item={item}/></div><div className="observer-card-status"><span className={item.warning?'observer-warning':''}>{item.status}</span><span>观测 {item.period}</span></div><div className="observer-card-footer"><small>最近检查 {item.checkedAt?beijing(item.checkedAt):'尚无记录'}</small><div>{item.sourceUrl&&<a href={item.sourceUrl} target="_blank" rel="noreferrer">来源 <ExternalLink size={12}/></a>}<button type="button" className="observer-open" onClick={()=>onOpen(item)}>查看图表 <ArrowUpRight size={14}/></button></div></div></>:<div className="observer-unavailable" role="status"><p>{loading?'正在加载这张卡片…':'暂未加载此指标的数据，已保留收藏。'}</p><small>{loading?'等待完成后显示真实值。':'数据恢复后会在原位置显示；不会将缺值填为零。'}</small></div>}<div className="observer-order"><span>第 {index+1} 项</span><button type="button" disabled={index===0} onClick={()=>move(id,'up')} aria-label={`上移${item?.title??id}`}><ArrowUp size={14}/>上移</button><button type="button" disabled={index===ids.length-1} onClick={()=>move(id,'down')} aria-label={`下移${item?.title??id}`}><ArrowDown size={14}/>下移</button></div></article>})}</div>
 </section>;
}
export function ObserverSearch({items,loading,onOpen}:Props){
 const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),titleId=useId();const [query,setQuery]=useState(''),[kind,setKind]=useState('all'),[visible,setVisible]=useState(24);
 const matches=useMemo(()=>searchObserverItems(items,query,kind) as ObservationItem[],[items,query,kind]);
 function show(){dialog.current?.showModal();requestAnimationFrame(()=>input.current?.focus())}
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key.toLowerCase()==='k'&&(event.ctrlKey||event.metaKey)&&!event.isComposing){event.preventDefault();dialog.current?.showModal();input.current?.focus()}};addEventListener('keydown',key);return()=>removeEventListener('keydown',key)},[]);
 function open(item:ObservationItem){dialog.current?.close();onOpen(item)}
 const shortcuts=[['changes','结论变化'],['validation','效果检验'],['robustness','结论稳健性'],['valuation','公司估值']];
 function openShortcut(section:string,title:string){open({id:'navigation:'+section,title,subtitle:'研究工具',kind:'industry',href:`${appBase()}?page=impact&industry=conclusions&research=${section}#research-progress`,anchorId:'research-progress',panelKey:'research:progress',searchTerms:'',value:'',unit:'',period:'',status:'',warning:false})}
 return <>
  <button type="button" className="observer-search-trigger" onClick={show}><Search size={17}/><span>搜索指标、公司、央行</span><kbd>Ctrl K</kbd></button>
  <dialog className="observer-search-dialog" ref={dialog} aria-labelledby={titleId} onClick={event=>{if(event.target===event.currentTarget)dialog.current?.close()}}>
   <div className="observer-search-shell">
    <div className="observer-search-heading"><h2 id={titleId}>全站搜索</h2><button type="button" className="observer-icon-button" onClick={()=>dialog.current?.close()} aria-label="关闭全站搜索"><X size={20}/></button></div>
    <label className="observer-search-input"><Search size={19}/><input ref={input} autoFocus type="search" value={query} onChange={event=>{setQuery(event.target.value);setVisible(24)}} placeholder="输入中文名称、公司英文名或指标代码" aria-label="搜索全站指标"/></label>
    <div className="observer-search-kinds" aria-label="搜索范围">{Object.entries(kindNames).map(([id,name])=><button type="button" key={id} aria-pressed={kind===id} onClick={()=>{setKind(id);setVisible(24)}}>{kind===id&&<Check size={12}/>} {name}</button>)}</div>
    {!query&&<div className="observer-search-shortcuts"><span>研究快捷入口</span>{shortcuts.map(([section,title])=><button type="button" key={section} onClick={()=>openShortcut(section,title)}>{title} <ArrowUpRight size={11}/></button>)}</div>}
    <p className="observer-search-count" role="status">{loading?'正在加载更多目录；':''}{query?`找到 ${matches.length} 个匹配项`:`已加载 ${items.length} 个可查看指标`} · 点击结果跳转并展开对应面板</p>
    <div className="observer-search-content"><ResultList items={matches.slice(0,visible)} onOpen={open}/>{matches.length>visible&&<button type="button" className="observer-action" onClick={()=>setVisible(value=>value+24)}>再显示 24 项（剩余 {matches.length-visible}）</button>}{!matches.length&&<div className="observer-empty"><Search size={24}/><p>{loading?'数据目录正在加载，请稍候。':'没有找到匹配项。试试“黄金”“MSFT”或“日本”。'}</p></div>}</div>
    <p className="observer-search-foot">每条结果显示自身观测期与数据状态；未接入项不会显示虚构数值。<span>Esc 关闭</span></p>
   </div>
  </dialog>
 </>;
}
