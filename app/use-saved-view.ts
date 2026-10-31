"use client";
import {useCallback,useEffect,useRef,useState,type SetStateAction} from 'react';

const PREFIX='macro-observatory:view:v1:';
export function useSavedView<T>(key:string,initial:T,valid:(value:unknown)=>value is T){
 const [value,setValue]=useState(initial);
 const current=useRef(initial),initialRef=useRef(initial),validator=useRef(valid);
 validator.current=valid;
 useEffect(()=>{
  let next=initialRef.current;
  try{const saved=JSON.parse(localStorage.getItem(PREFIX+key)??'null');if(validator.current(saved))next=saved;}catch{/* Optional preference storage. */}
  current.current=next;setValue(next);
 },[key]);
 const update=useCallback((action:SetStateAction<T>)=>{
  const next=typeof action==='function'?(action as (previous:T)=>T)(current.current):action;
  current.current=next;setValue(next);
  try{localStorage.setItem(PREFIX+key,JSON.stringify(next));}catch{/* Current session remains usable. */}
 },[key]);
 return [value,update] as const;
}
export const textPreference=(v:unknown):v is string=>typeof v==='string'&&v.length<=500;
export const rangePreference=(v:unknown):v is string=>typeof v==='string'&&['1','3','5','all'].includes(v);
export const indexPreference=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=20;
