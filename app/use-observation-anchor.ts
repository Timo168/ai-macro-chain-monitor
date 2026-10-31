"use client";
import {useEffect} from 'react';
import {revealPanel} from './panel-disclosure';

export function useObservationAnchor(){useEffect(()=>{
 let watcher:MutationObserver|null=null,timer:ReturnType<typeof setTimeout>|null=null;
 function locate(){
  watcher?.disconnect();if(timer)clearTimeout(timer);
  let id='';try{id=decodeURIComponent(location.hash.slice(1))}catch{return}if(!id)return;
  const minerals=['copper','gold','silver','aluminum','iron-ore','nickel'];
  const targetId=minerals.includes(id)?'mineral-resources':id;
  const page=new URLSearchParams(location.search).get('page');
  revealPanel(page==='impact'?(id==='research-progress'?'research:progress':'industry:metric:'+id):targetId==='mineral-resources'?'macro:mineral-resources':targetId==='policy-rates'?'policy:rates':'macro:chart:'+id);
  const scroll=()=>{const node=document.getElementById(targetId);if(!node)return false;watcher?.disconnect();if(timer)clearTimeout(timer);requestAnimationFrame(()=>{node.scrollIntoView({behavior:'smooth',block:'start'});node.classList.add('observer-target-highlight');setTimeout(()=>node.classList.remove('observer-target-highlight'),2400)});return true;};
  if(scroll())return;
  watcher=new MutationObserver(scroll);watcher.observe(document.body,{childList:true,subtree:true});timer=setTimeout(()=>watcher?.disconnect(),15000);
 }
 locate();addEventListener('hashchange',locate);addEventListener('popstate',locate);
 return()=>{watcher?.disconnect();if(timer)clearTimeout(timer);removeEventListener('hashchange',locate);removeEventListener('popstate',locate)};
},[]);}
