"use client";
import {useEffect} from 'react';
import {mineralAnchors} from '@/lib/mineral-display.mjs';
import {revealPanel} from './panel-disclosure';

function navigationBehavior():ScrollBehavior{
 return window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth';
}

export function scrollToPageTop(){
 window.scrollTo({top:0,behavior:navigationBehavior()});
}

const dataReadyEvent='observer:anchor-data-ready';
export function notifyObservationTargetsReady(){
 window.dispatchEvent(new Event(dataReadyEvent));
}

export function useObservationAnchor(){
 useEffect(()=>{
  let frame=0;
  let watcher:MutationObserver|undefined;
  let deadline:number|undefined;
  let retryAfterData:(()=>void)|undefined;
  let highlightTimer:number|undefined;
  let highlighted:HTMLElement|null=null;

  function stopWaiting(){
   if(retryAfterData)window.removeEventListener(dataReadyEvent,retryAfterData);
   retryAfterData=undefined;
   cancelAnimationFrame(frame);
   watcher?.disconnect();
   watcher=undefined;
   window.clearTimeout(deadline);
  }
  function clearHighlight(){
   window.clearTimeout(highlightTimer);
   highlighted?.classList.remove('observer-target-highlight');
   highlighted=null;
  }
  function locate(){
   stopWaiting();
   clearHighlight();
   const hash=location.hash;
   let id='';
   try{id=decodeURIComponent(hash.slice(1));}catch{return;}
   if(!id)return;
   const targetId=Object.hasOwn(mineralAnchors,id)?'mineral-resources':id;
   const page=new URLSearchParams(location.search).get('page');
   let panelKey='macro:chart:'+id;
   if(page==='impact')panelKey=id==='research-progress'?'research:progress':'industry:metric:'+id;
   else if(targetId==='mineral-resources'||id==='commodity-comparison')panelKey='macro:'+targetId;
   else if(id==='policy-rates')panelKey='policy:rates';
   revealPanel(panelKey);

   function findTarget(){
    if(location.hash!==hash||new URLSearchParams(location.search).get('page')!==page){
     stopWaiting();
     return;
    }
    const target=document.getElementById(targetId);
    if(!target||target.closest('main[data-page]')?.getAttribute('data-page')!==(page??'overview'))return;
    stopWaiting();
    target.scrollIntoView({block:'start',behavior:navigationBehavior()});
    highlighted=target;
    target.classList.add('observer-target-highlight');
    highlightTimer=window.setTimeout(clearHighlight,2400);
   }
   function watchTarget(){
    watcher=new MutationObserver(findTarget);
    watcher.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-page']});
    deadline=window.setTimeout(()=>{
     stopWaiting();
     // An initial snapshot may still be downloading on a slow connection.
     retryAfterData=watchTarget;
     window.addEventListener(dataReadyEvent,retryAfterData,{once:true});
    },15000);
    findTarget();
   }
   // Let React commit the selected page before looking up an ID shared by two pages.
   frame=requestAnimationFrame(watchTarget);
  }
  locate();
  window.addEventListener('hashchange',locate);
  window.addEventListener('popstate',locate);
  return ()=>{
   stopWaiting();
   clearHighlight();
   window.removeEventListener('hashchange',locate);
   window.removeEventListener('popstate',locate);
  };
 },[]);
}
