"use client";
import {useMemo,useState} from 'react';
import {ReferenceLine} from 'recharts';
import {CalendarDays} from 'lucide-react';
import {useObserver} from './observer-context';
import {metadata} from '@/lib/data';
import {alignEventsToRows,buildObservationEvents,eventsForChart} from '@/lib/observation-events.mjs';
import type {IndustryDataset} from '@/lib/industry/types';
import './chart-events.css';

export type ChartEvent={id:string;kind:string;title:string;date:string;dateBasis:string;sourceUrl:string;status:string;version:string|null;fetchedAt:string|null;scheduled:boolean;observationDate?:string|null;positionDate:string|null;aligned:boolean};
export function useChartEventLayer({seriesIds=[],entity,rows,dateKey='date',includePolicy=false,industry}:{seriesIds?:string[];entity?:string;rows:Record<string,unknown>[];dateKey?:string;includePolicy?:boolean;industry?:IndustryDataset}){
 const {inputs}=useObserver();
 const [enabled,setEnabled]=useState(false);
 const all=useMemo(()=>buildObservationEvents({...inputs,...(industry?{industry}:{})}).map(event=>event.kind==='macro'?{...event,title:`${metadata[event.seriesIds[0]]?.name??event.seriesIds[0]} · 来源发布更新`}:event),[inputs,industry]);
 const events=useMemo(()=>{
  return alignEventsToRows(eventsForChart(all,{seriesIds,entity,includePolicy}),rows,dateKey) as ChartEvent[];
 },[all,seriesIds.join('|'),entity,includePolicy,rows,dateKey]);
 return {enabled,setEnabled,events};
}

export function chartEventReferenceLines(events:ChartEvent[],enabled:boolean){
 if(!enabled)return [];
 const positions=[...new Set(events.filter(event=>event.positionDate).map(event=>event.positionDate!))].slice(0,8);
 return positions.map((date,index)=><ReferenceLine key={'event-'+date} x={date} stroke="#a17b3f" strokeDasharray="3 5" label={(props:{viewBox?:{x?:number;y?:number}})=><text x={props.viewBox?.x??0} y={(props.viewBox?.y??0)+12+(index%2?14:0)} fill="#8b692e" fontSize={11} textAnchor="middle" style={{pointerEvents:'all'}}><title>{events.filter(event=>event.positionDate===date).map(event=>`${event.date} ${event.title}${event.aligned?'（图上定位日 '+date+'）':''}`).join('\n')}</title>◆</text>}/>);
}

const states:Record<string,string>={ready:'已获取',reviewed:'人工核验',cached:'缓存',fetch_failed:'获取失败，保留已有记录',not_configured:'未配置',pending:'待发布',unavailable:'来源暂不可用'};
export function ChartEvents({events,enabled,onChange}:{events:ChartEvent[];enabled:boolean;onChange:(next:boolean)=>void}){
 const [all,setAll]=useState(false);
 const visible=all?events:events.slice(0,5);
 const marked=[...new Set(events.filter(event=>event.positionDate).map(event=>event.positionDate))].slice(0,8);
 return <div className="chart-events"><button type="button" className="chart-events-toggle" onClick={()=>onChange(!enabled)} aria-expanded={enabled}><CalendarDays size={14}/>{enabled?'隐藏事件':'显示事件'}<span>{events.length} 条有出处的记录</span></button>{enabled&&<div className="chart-events-body"><p>◆ 标出区间内最近 {marked.length} 个事件落点，方便对照公告与走势；事件日期沿用来源日历。</p>{events.length?<ol>{visible.map(event=><li key={event.id}><div><time>{event.date}</time><a href={event.sourceUrl} target="_blank" rel="noreferrer">{event.title} ↗</a></div><small>{event.dateBasis} · {states[event.status]??event.status}{event.scheduled?' · 已公告日程，尚未发生':event.positionDate?event.aligned?` · 图上对照下一观测日 ${event.positionDate}`:' · 与图上日期一致':' · 超出当前图表观测范围'}</small>{event.observationDate&&<small>所披露观测期：{event.observationDate}</small>}<details><summary>来源与版本</summary><span>版本 {event.version??'来源未提供'} · 最近成功获取 {event.fetchedAt??'未提供'}</span></details></li>)}</ol>:<p>当前序列尚无可核验的发布日期，暂未显示事件。</p>}{events.length>5&&<button type="button" className="chart-events-more" onClick={()=>setAll(!all)}>{all?'仅看最近 5 条':`查看全部 ${events.length} 条`}</button>}</div>}</div>;
}
