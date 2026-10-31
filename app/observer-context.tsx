"use client";
import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {Dataset} from '@/lib/data';
import type {ObserverInputs,ObservationItem} from '@/lib/observer-types';
import {buildObserverCatalog} from '@/lib/observer-catalog';
import {industryEndpoint,industryResearchEndpoint,manifestEndpoint,policyDecisionsEndpoint,policyRatesEndpoint,versionedEndpoint} from '@/lib/runtime';

type ObserverContextValue={inputs:ObserverInputs;catalog:ObservationItem[];loading:boolean;errors:string[];refresh:()=>void};
const emptyInputs:ObserverInputs={macro:{generatedAt:'',series:{}},industry:null,research:null,policyRates:null,policyDecisions:null};
const Context=createContext<ObserverContextValue>({inputs:emptyInputs,catalog:[],loading:true,errors:[],refresh:()=>{}});
export const useObserver=()=>useContext(Context);
export function ObserverProvider({macro,children}:{macro:Dataset;children:ReactNode}){
 const [extra,setExtra]=useState<Omit<ObserverInputs,'macro'>>({industry:null,research:null,policyRates:null,policyDecisions:null});
 const [loading,setLoading]=useState(true),[errors,setErrors]=useState<string[]>([]);
 const versions=useRef<Record<string,string>>({}),busy=useRef(false),alive=useRef(true);
 const refresh=useCallback(async()=>{
  if(busy.current)return;busy.current=true;
  let manifest:Record<string,{version?:string;generatedAt?:string}>={};
  try{const response=await fetch(manifestEndpoint(),{cache:'no-store',signal:AbortSignal.timeout(20000)});if(response.ok)manifest=await response.json();}catch{/* Each dataset remains independently readable. */}
  const sources=[['industry','industry',industryEndpoint(),'产业数据'],['research','industryResearch',industryResearchEndpoint(),'研究与估值'],['policyRates','policyRates',policyRatesEndpoint(),'央行月末利率'],['policyDecisions','policyDecisions',policyDecisionsEndpoint(),'央行最新决议']] as const;
  const failed:string[]=[];
  const updates:Partial<Omit<ObserverInputs,'macro'>>={};
  await Promise.all(sources.map(async([key,manifestKey,endpoint,label])=>{
   const version=manifest[manifestKey]?.version??manifest[manifestKey]?.generatedAt??'';
   if(version&&versions.current[key]===version)return;
   try{
    const response=await fetch(versionedEndpoint(endpoint,version),{cache:version?'force-cache':'no-store',signal:AbortSignal.timeout(25000)});
    if(!response.ok)throw Error('http');
    const data=await response.json() as {generatedAt?:string;definitions?:unknown[];series?:unknown;decisions?:unknown[];inputs?:unknown};
    if(!data?.generatedAt||(key==='industry'&&(!Array.isArray(data.definitions)||!data.series))||(key==='policyRates'&&!Array.isArray(data.series))||(key==='policyDecisions'&&!Array.isArray(data.decisions))||(key==='research'&&!data.inputs))throw Error('schema');
    Object.assign(updates,{[key]:data});versions.current[key]=version;
   }catch{failed.push(label+'暂时无法读取，保留已加载数据');}
  }));
  if(alive.current){if(Object.keys(updates).length)setExtra(previous=>({...previous,...updates}));setErrors(failed);setLoading(false);}
  busy.current=false;
 },[]);
 useEffect(()=>{alive.current=true;void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh()},300000);const visible=()=>{if(!document.hidden)void refresh()};document.addEventListener('visibilitychange',visible);addEventListener('observer:refresh',refresh);return()=>{alive.current=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);removeEventListener('observer:refresh',refresh)}},[refresh]);
 const inputs=useMemo(()=>({macro,...extra}),[macro,extra]);
 const catalog=useMemo(()=>buildObserverCatalog(inputs),[inputs]);
 return <Context.Provider value={{inputs,catalog,loading,errors,refresh:()=>{void refresh()}}}>{children}</Context.Provider>;
}
