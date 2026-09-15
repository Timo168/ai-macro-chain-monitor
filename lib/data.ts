import registry from './indicators.json';
import { changeRate, monthlyDiff, movingAverage } from './calculations.mjs';
import type { Group } from './groups';
export type Point={date:string;value:number|null};
export type Series={id:string;observations:Point[];fetchedAt:string|null;checkedAt?:string;sourcePublishedAt:string|null;sourceUrl:string;revision?:string;revisionCount?:number;status:string;error?:string|null;publication?:{state:string;nextReleaseAt?:string;nextCheckAt?:string;calendarStatus?:string;calendarSource?:string}};
export type Dataset={generatedAt:string;series:Record<string,Series>;storage?:string;scheduler?:{mode:string;lastRunAt?:string;failed?:string[];nextCheckAt?:string;calendarStatus?:string}};
export const metadata=Object.fromEntries(registry.map(s=>[s.id,s]));
export const colors=['#178a75','#d8a958','#6282bb','#b27b9e'];
export const frequencyLabel:Record<string,string>={daily:'日度',weekly:'周度',monthly:'月度'};
export function sourceLink(id:string){return ['NATGAS_US','COAL_AUS','COPPER','ALUMINUM','IRON_ORE','NICKEL','GOLD','SILVER'].includes(id)?'https://www.worldbank.org/en/research/commodity-markets':'https://fred.stlouisfed.org/series/'+id}
export function format(value:number|null|undefined,digits=2){return value==null||!Number.isFinite(value)?'—':value.toLocaleString('zh-CN',{maximumFractionDigits:digits,minimumFractionDigits:digits})}
export function deltaFormat(value:number|null|undefined,digits=2){if(value==null)return '—';if(value!==0&&Math.abs(value)<Math.pow(10,-digits))return '<'+Math.pow(10,-digits).toFixed(digits);return format(Math.abs(value),digits)}
export function beijing(date?:string|null){if(!date)return '来源未提供';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(date))}
export function makeChart(group:Group,data:Dataset,mode='yoy'){
 const raw=(id:string):Point[]=>data.series[id]?.observations??[];
 let ids=group.series,arrays:Point[][]=[],names:string[]=[];
 if(group.id==='cpi'){ids=mode==='yoy'?group.series.slice(0,2):group.series.slice(2);arrays=ids.map(id=>changeRate(raw(id),mode==='yoy'?12:1));names=['CPI','核心 CPI'];}
 else if(group.id==='pce'){ids=['PCEPILFE','PCEPI'];arrays=ids.map(id=>changeRate(raw(id),mode==='yoy'?12:1));names=['核心 PCE','总体 PCE'];}
 else if(group.id==='claims'){const a=raw('ICSA').map(p=>({...p,value:p.value===null?null:p.value/1000}));arrays=[a,movingAverage(a,4,'weekly')];names=['初请人数','四周移动平均'];}
 else if(group.id==='payrolls'){const a=monthlyDiff(raw('PAYEMS'));arrays=[a,movingAverage(a,3,'monthly')];names=['月增量','三个月均值'];}
 else {arrays=ids.map(raw);names=ids.map(id=>metadata[id]?.name??id)}
 const dates=[...new Set(arrays.flatMap(a=>a.map(p=>p.date)))].sort();const maps=arrays.map(a=>new Map(a.map(p=>[p.date,p.value])));
 const rows=dates.map(date=>({date,...Object.fromEntries(maps.map((m,i)=>['s'+i,m.get(date)??null]))}));
 return {rows,names,ids};
}
export function firstValues(rows:Record<string,unknown>[]):Point[]{return rows.map(p=>({date:String(p.date),value:p.s0 as number|null}))}
