"use client";
import {useEffect,useId,useState,type ReactNode} from 'react';
import {ChevronDown,ChevronUp,ChevronLeft,ChevronRight} from 'lucide-react';
import {panelAnchor,resolvePanelSelection,panelSelectionUrl} from '@/lib/panel-explorer.mjs';
import {rememberReadingView} from '@/lib/reading-view.mjs';
import {useSavedView,textPreference} from './use-saved-view';
import {revealPanel} from './panel-disclosure';
import './panel-explorer.css';

export type PanelExplorerItem={id:string;title:string;eyebrow?:string;summary?:ReactNode;meta?:ReactNode;panelKey?:string;anchor?:string;aliases?:string[]};
type Props={storageKey:string;title:string;description?:string;items:PanelExplorerItem[];renderPanel:(id:string)=>ReactNode;selectedId?:string;onSelect?:(id:string)=>void;defaultSelectedId?:string};
const pageSize=6;
const booleanPreference=(value:unknown):value is boolean=>typeof value==='boolean';
export default function PanelExplorer({storageKey,title,description,items,renderPanel,selectedId,onSelect,defaultSelectedId=''}:Props){
 const [saved,setSaved]=useSavedView('panel-explorer:'+storageKey,defaultSelectedId,textPreference);
 const [open,setOpen]=useSavedView('panel-explorer:'+storageKey+':open',true,booleanPreference);
 const [hash,setHash]=useState(()=>typeof location==='undefined'?'':location.hash);
 const [page,setPage]=useState(0);
 const [implicit,setImplicit]=useState({key:storageKey,id:''});
 const fallback=items.some(item=>item.id===saved)?saved:implicit.key===storageKey?implicit.id:defaultSelectedId;
 const active=selectedId===undefined?resolvePanelSelection(items,fallback,hash):items.find(item=>item.id===selectedId)??resolvePanelSelection(items,fallback,hash);
 const pages=Math.max(1,Math.ceil(items.length/pageSize)),safePage=Math.min(page,pages-1);
 const contentId='explorer-'+useId().replaceAll(':','');
 useEffect(()=>{const read=()=>setHash(location.hash);read();window.addEventListener('hashchange',read);window.addEventListener('popstate',read);return()=>{window.removeEventListener('hashchange',read);window.removeEventListener('popstate',read)};},[storageKey]);
 useEffect(()=>{if(active){setPage(Math.floor(items.findIndex(item=>item.id===active.id)/pageSize));if(active.panelKey)revealPanel(active.panelKey);}},[active?.id,storageKey]);
 // Keep the initially visible item selected when a directory is reordered,
 // without overwriting a preference that is still loading from storage.
 useEffect(()=>{if(active)setImplicit({key:storageKey,id:active.id});},[active?.id,storageKey]);
 useEffect(()=>{const anchor=panelAnchor(hash);if(anchor&&resolvePanelSelection(items,'',hash)?.id===active?.id&&items.some(item=>item.id===anchor||item.anchor===anchor||item.aliases?.includes(anchor)))setOpen(true);},[hash,active?.id,storageKey,setOpen]);
 function select(id:string){const item=items.find(item=>item.id===id);if(!item)return;setSaved(id);setOpen(true);setHash(item.anchor?'#'+item.anchor:'');if(item.panelKey)revealPanel(item.panelKey);history.replaceState(history.state,'',panelSelectionUrl(location.href,item.anchor));rememberReadingView();window.dispatchEvent(new Event('hashchange'));onSelect?.(id);}
 return <section className="panel-explorer" aria-label={title}>
  <header className="panel-explorer-heading"><div><span className="panel-explorer-kicker">{items.length} 个主题 · 每次聚焦一项</span><h2>{title}</h2>{description&&<p>{description}</p>}</div><button type="button" className="panel-toggle" aria-expanded={open} aria-controls={contentId} onClick={()=>setOpen(!open)}>{open?<ChevronUp size={15}/>:<ChevronDown size={15}/>}<span>{open?'收起详情':'展开详情'}</span></button></header>
  <div className="panel-explorer-layout">
   <div className="panel-explorer-directory"><label className="panel-explorer-select"><span>快速选择</span><select value={active?.id??''} onChange={event=>select(event.target.value)} aria-label={title+'快速选择'}>{items.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label><div className="panel-explorer-options" role="group" aria-label={title+'主题目录'}>{items.slice(safePage*pageSize,(safePage+1)*pageSize).map(item=><button type="button" key={item.id} className={'panel-explorer-option'+(active?.id===item.id?' selected':'')} aria-pressed={active?.id===item.id} aria-controls={contentId} onClick={()=>select(item.id)}>{item.eyebrow&&<small>{item.eyebrow}</small>}<strong>{item.title}</strong>{item.summary!=null&&<span className="panel-explorer-option-value">{item.summary}</span>}{item.meta!=null&&<span className="panel-explorer-option-meta">{item.meta}</span>}</button>)}</div>{pages>1&&<div className="panel-explorer-pagination"><button type="button" aria-label={title+'上一页'} disabled={safePage===0} onClick={()=>setPage(safePage-1)}><ChevronLeft size={16}/></button><span>{safePage+1} / {pages}</span><button type="button" aria-label={title+'下一页'} disabled={safePage===pages-1} onClick={()=>setPage(safePage+1)}><ChevronRight size={16}/></button></div>}</div>
   <div id={contentId} className="panel-explorer-detail" hidden={!open}>{active?renderPanel(active.id):<div className="panel-explorer-empty">暂无可展示内容。</div>}</div>
  </div>
  {!open&&<p className="panel-explorer-collapsed">已收起 {active?.title??'详情'}，点击主题即可展开。</p>}
 </section>;
}
