"use client";

import {useCallback,useEffect,useId,useState,type ReactNode} from 'react';
import {ChevronDown,ChevronUp} from 'lucide-react';
import './panel-disclosure.css';

const PREFIX='macro-observatory:panels:v1:';
const CHANGE='macro-observatory:panel-change';
type Preference={open:boolean;at:number};
type Change={panelKey?:string;scope?:string;open:boolean;at:number};
let lastActionAt=0;
function read(key:string):Preference|null{
 try{const value=JSON.parse(localStorage.getItem(PREFIX+key)??'null');return value&&typeof value.open==='boolean'&&Number.isFinite(value.at)?value:null;}catch{return null;}
}
function publish(change:Omit<Change,'at'>){
 const at=lastActionAt=Math.max(Date.now(),lastActionAt+1);
 const key=change.panelKey??'scope:'+change.scope;
 try{localStorage.setItem(PREFIX+key,JSON.stringify({open:change.open,at}));}catch{/* Browsing without storage still supports folding. */}
 window.dispatchEvent(new CustomEvent<Change>(CHANGE,{detail:{...change,at}}));
}

/** Reveal before navigation, including a panel that has not mounted yet. */
export function revealPanel(panelKey:string){if(typeof window!=='undefined')publish({panelKey,open:true});}

export function usePanelDisclosure(panelKey:string,{defaultOpen=true,anchorId,scope=panelKey.split(':')[0]}:{defaultOpen?:boolean;anchorId?:string;scope?:string}={}){
 const [open,setVisible]=useState(defaultOpen);
 const contentId='panel-body-'+useId().replaceAll(':','');
 const setOpen=useCallback((value:boolean)=>{setVisible(value);publish({panelKey,open:value});},[panelKey]);
 useEffect(()=>{
  const own=read(panelKey),group=read('scope:'+scope);
  const preference=own&&(!group||own.at>group.at)?own:group;
  setVisible(preference?.open??defaultOpen);
  const revealAnchor=()=>{
   if(!anchorId)return;
   let anchor='';try{anchor=decodeURIComponent(window.location.hash.slice(1));}catch{return;}
   if(anchor===anchorId)setOpen(true);
  };
  const change=(event:Event)=>{const detail=(event as CustomEvent<Change>).detail;if(detail&&(detail.panelKey===panelKey||detail.scope===scope))setVisible(detail.open);};
  const stored=(event:StorageEvent)=>{
   if(event.key!==PREFIX+panelKey&&event.key!==PREFIX+'scope:'+scope&&event.key!==null)return;
   const next=read(panelKey),all=read('scope:'+scope);
   setVisible((next&&(!all||next.at>all.at)?next:all)?.open??defaultOpen);
  };
  window.addEventListener(CHANGE,change);
  window.addEventListener('storage',stored);
  window.addEventListener('hashchange',revealAnchor);
  window.addEventListener('popstate',revealAnchor);
  revealAnchor();
  return()=>{window.removeEventListener(CHANGE,change);window.removeEventListener('storage',stored);window.removeEventListener('hashchange',revealAnchor);window.removeEventListener('popstate',revealAnchor);};
 },[panelKey,scope,anchorId,defaultOpen,setOpen]);
 return {open,setOpen,toggle:()=>setOpen(!open),contentId};
}

export function PanelToggle({open,onToggle,controls,label}:{open:boolean;onToggle:()=>void;controls:string;label:string}){
 return <button type="button" className="panel-toggle" aria-expanded={open} aria-controls={controls} aria-label={`${open?'收起':'展开'}${label}`} onClick={onToggle}>
  {open?<ChevronUp size={15} aria-hidden="true"/>:<ChevronDown size={15} aria-hidden="true"/>}<span>{open?'收起':'展开'}</span>
 </button>;
}

/** Keep visited content mounted so filters, chart windows and inputs survive folding. */
export function PanelBody({open,id,children,className=''}:{open:boolean;id:string;children:ReactNode;className?:string}){
 const [visited,setVisited]=useState(open);
 useEffect(()=>{if(open)setVisited(true);},[open]);
 return <div id={id} hidden={!open} className={'panel-body '+className}>{open||visited?children:null}</div>;
}

export function PanelBatchActions({scope}:{scope:string}){
 return <div className="panel-batch-actions" role="group" aria-label="面板阅读视图">
  <span>阅读视图</span><button type="button" onClick={()=>publish({scope,open:false})}><ChevronUp size={14} aria-hidden="true"/>全部收起</button><button type="button" onClick={()=>publish({scope,open:true})}><ChevronDown size={14} aria-hidden="true"/>全部展开</button>
 </div>;
}
