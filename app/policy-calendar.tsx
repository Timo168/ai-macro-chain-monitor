"use client";
import {useEffect,useMemo,useState} from 'react';
import {Bell,CalendarDays,Check,Download,ExternalLink,Info,Clock3} from 'lucide-react';
import {ResponsiveContainer,LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip,ReferenceLine} from 'recharts';
import {Button} from '@/components/ui/button';
import {policyBanks,policyCalendar,policyCalendarSourceCheckedAt,type PolicyCalendarEvent} from '@/lib/policy-calendar';
import {policyRateColor,policyRateChange,type PolicyRatesDataset} from '@/lib/policy-rates';
import {manifestEndpoint,policyRatesEndpoint,versionedEndpoint} from '@/lib/runtime';
import './policy-calendar.css';

const storageKey='ai-macro-policy-calendar-following';
const dateFormatter=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'short',timeZone:'UTC'});
const toUtc=(date:string)=>Date.parse(date+'T00:00:00Z');
const formatDate=(date:string)=>dateFormatter.format(new Date(date+'T00:00:00Z'));
const daysTo=(date:string,now=new Date())=>Math.round((toUtc(date)-Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()))/86400000);
const escapeIcs=(value:string)=>value.replaceAll('\\','\\\\').replaceAll(',','\\,').replaceAll(';','\\;').replaceAll('\n','\\n');

function reminderLabel(days:number){if(days<0)return '已过';if(days===0)return '今天决议';if(days===1)return '明天决议';return `${days} 天后决议`;}
function makeIcs(events:PolicyCalendarEvent[]){
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//AI Macro Observatory//Policy Calendar//ZH','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
 for(const event of events){
  const date=event.decisionDate.replaceAll('-','');
  lines.push('BEGIN:VEVENT',`UID:${event.id}@ai-macro-observatory`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')}`,`DTSTART;VALUE=DATE:${date}`,`SUMMARY:${escapeIcs(`${event.bank}：${event.title}`)}`,`DESCRIPTION:${escapeIcs(`利率决议日。请以央行官网为准：${event.sourceUrl}`)}`,`URL:${event.sourceUrl}`,'BEGIN:VALARM','TRIGGER:-P1D','ACTION:DISPLAY',`DESCRIPTION:${escapeIcs(`${event.bank} 利率决议明日公布`)}`,'END:VALARM','END:VEVENT');
 }
 lines.push('END:VCALENDAR');return lines.join('\r\n');
}
function downloadCalendar(events:PolicyCalendarEvent[]){
 const blob=new Blob([makeIcs(events)],{type:'text/calendar;charset=utf-8'});const href=URL.createObjectURL(blob);const link=document.createElement('a');link.href=href;link.download='主要央行利率日历.ics';link.click();URL.revokeObjectURL(href);
}

function rateNumber(value:number|undefined){return value==null?'—':value.toFixed(Math.abs(value)%1===0?2:3)+'%';}
function RateComparison({following}:{following:string[]}){
 const [dataset,setDataset]=useState<PolicyRatesDataset|null>(null);
 const [loadError,setLoadError]=useState('');
 const [range,setRange]=useState<'1'|'3'|'5'|'10'>('5');
 useEffect(()=>{let cancelled=false;async function load(){try{let version='';try{const response=await fetch(manifestEndpoint(),{cache:'no-store'});if(response.ok){const manifest=await response.json() as {policyRates?:{version?:string}};version=manifest.policyRates?.version??'';}}catch{}const response=await fetch(versionedEndpoint(policyRatesEndpoint(),version),{cache:'no-store'});if(!response.ok)throw new Error('政策利率数据暂不可用');const payload=await response.json() as PolicyRatesDataset;if(!payload.series?.length)throw new Error('政策利率数据尚未准备完成');if(!cancelled){setDataset(payload);setLoadError('');}}catch{if(!cancelled)setLoadError('暂时无法读取政策利率缓存，请稍后重试。');}}void load();return()=>{cancelled=true;};},[]);
 const visible=useMemo(()=>dataset?.series.filter(series=>following.includes(series.id))??[],[dataset,following]);
 const rows=useMemo(()=>{if(!visible.length)return [];const all=visible.flatMap(series=>series.observations.map(point=>point.date));const latest=[...all].sort().at(-1);if(!latest)return [];const from=new Date(latest+'T00:00:00Z');from.setUTCFullYear(from.getUTCFullYear()-Number(range));const floor=from.toISOString().slice(0,10);const dates=[...new Set(all.filter(date=>date>=floor))].sort();const maps=new Map(visible.map(series=>[series.id,new Map(series.observations.map(point=>[point.date,point.value]))]));return dates.map(date=>({date,...Object.fromEntries(visible.map(series=>[series.id,maps.get(series.id)?.get(date)??null]))}));},[visible,range]);
 return <section className="policy-rates" aria-label="主要央行政策利率横向对比"><div className="policy-section-heading"><div><h3>政策利率横向对比</h3><p>统一为月度期末、年利率。上方的关注范围同时控制本图；各国决策日期不同，横向比较的是同一月末的政策水平。</p></div><div className="policy-rate-controls" aria-label="政策利率图表时间范围">{([['1','1年'],['3','3年'],['5','5年'],['10','10年']] as const).map(([value,label])=><button key={value} aria-pressed={range===value} onClick={()=>setRange(value)}>{label}</button>)}</div></div>
 {dataset?<><div className="policy-rate-summary">{visible.map((series,index)=>{const change=policyRateChange(series);return <article key={series.id}><span className="policy-rate-dot" style={{background:policyRateColor(series.id,index)}}/><div><small>{series.country} · {series.shortName}</small><strong>{series.name}</strong></div><b>{rateNumber(series.latestValue)}</b><p>{series.latestObservationDate.slice(0,7)} · {change==null?'无上月比较':`${change>0?'↑':'↓'} ${Math.abs(change).toFixed(3).replace(/0+$/,'').replace(/\.$/,'')} 个百分点`}</p></article>})}{!visible.length&&<div className="policy-empty">请在“我的关注范围”至少选择一家央行，以显示政策利率。</div>}</div>
 {rows.length&&visible.length?<><div className="policy-rate-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={rows} margin={{top:15,right:12,bottom:0,left:-22}} accessibilityLayer><CartesianGrid vertical={false} stroke="#e4ece9" strokeDasharray="3 4"/><XAxis dataKey="date" tickFormatter={(value:string)=>value.slice(2,7).replace('-','/')} minTickGap={46} tickLine={false} axisLine={false} tick={{fontSize:11,fill:'#819096'}}/><YAxis tickFormatter={(value:number)=>`${value}%`} domain={['auto','auto']} tickLine={false} axisLine={false} tick={{fontSize:11,fill:'#819096'}} width={58}/><Tooltip labelFormatter={(value)=>`${String(value).slice(0,7)} · 月末`} formatter={(value,name)=>[rateNumber(typeof value==='number'?value:undefined),name]}/><ReferenceLine y={0} stroke="#adbdb9" strokeDasharray="4 4"/>{visible.map((series,index)=><Line key={series.id} type="stepAfter" dataKey={series.id} name={series.name} stroke={policyRateColor(series.id,index)} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}/>)}</LineChart></ResponsiveContainer></div><div className="policy-rate-legend">{visible.map((series,index)=><span key={series.id}><i style={{background:policyRateColor(series.id,index)}}/>{series.name}</span>)}<em>鼠标悬停查看月末值</em></div></>:<div className="policy-empty">所选央行还没有足够的同频历史数据。</div>}
 <div className="policy-rate-note"><p><strong>口径：</strong>{dataset.source.name} 选择各经济体最能反映货币当局政策意图的主要利率；若为目标区间则采用中点。它不是跨国实际融资成本，也不能直接代替各地的企业贷款利率。</p><p><strong>各线覆盖：</strong>{visible.map(series=>`${series.shortName} 至 ${series.latestObservationDate.slice(0,7)}`).join('；')}。只显示每家央行实际已有的月末观测，不用旧值填补缺月。</p><p><strong>更新：</strong>{dataset.source.frequency} · 最近检查 {dataset.checkedAt.slice(0,10)} · <a href={dataset.source.url} target="_blank" rel="noreferrer">查看 BIS 方法与数据 <ExternalLink size={12}/></a></p></div></>:<div className="policy-empty">{loadError||'正在读取政策利率历史数据…'}</div>}</section>;
}

export default function PolicyCalendar(){
 const [following,setFollowing]=useState<string[]>(()=>{if(typeof window==='undefined')return policyBanks.map(bank=>bank.id);try{const saved=localStorage.getItem(storageKey);const parsed=saved?JSON.parse(saved):null;return Array.isArray(parsed)?parsed.filter((id):id is string=>typeof id==='string'):policyBanks.map(bank=>bank.id);}catch{return policyBanks.map(bank=>bank.id);}});
 useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(following));}catch{}},[following]);
 const now=new Date();
 const visible=policyCalendar.filter(event=>following.includes(event.bankId));
 const upcoming=visible.filter(event=>daysTo(event.decisionDate,now)>=0);
 const next=upcoming[0];
 const nextSeven=upcoming.filter(event=>daysTo(event.decisionDate,now)<=7);
 const grouped=(()=>{const map=new Map<string,PolicyCalendarEvent[]>();for(const event of upcoming){const month=event.decisionDate.slice(0,7);map.set(month,[...(map.get(month)??[]),event]);}return [...map.entries()];})();
 function toggle(id:string){setFollowing(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);}
 return <section className="policy-calendar" aria-label="主要央行利率日历">
  <div className="policy-hero"><div><div className="policy-eyebrow">POLICY WATCH</div><h2>主要央行利率日历</h2><p>先关注会议与决议日，再阅读声明、预测和实际利率变化。日程来自各央行官网，发布时间以原始来源为准。</p></div><Button onClick={()=>downloadCalendar(upcoming)} disabled={!upcoming.length}><Download size={15}/>下载关注央行的提醒</Button></div>
  <div className="policy-top-grid"><section className="policy-next"><div className="policy-card-label"><Bell size={16}/>下一次利率决议</div>{next?<><strong>{next.bank} · {next.country}</strong><div className="policy-next-date">{formatDate(next.decisionDate)}</div><p>{next.title}</p><div className="policy-meta"><span>{reminderLabel(daysTo(next.decisionDate,now))}</span><span>{next.timezone}</span></div><a href={next.sourceUrl} target="_blank" rel="noreferrer">查看央行原始日程 <ExternalLink size={13}/></a></>:<p>当前关注范围内暂无已确认的未来日程。</p>}</section>
   <section className="policy-alerts"><div className="policy-card-label"><Clock3 size={16}/>未来 7 天</div>{nextSeven.length?<ul>{nextSeven.map(event=><li key={event.id}><span>{formatDate(event.decisionDate)}</span><strong>{event.bank}</strong><small>{event.title}</small></li>)}</ul>:<div className="policy-empty">未来七天没有已确认的利率决议。日程临时调整时，以央行公告为准。</div>}</section></div>
  <section className="policy-follow"><div><h3>我的关注范围</h3><p>选择需要跟踪的央行。选择结果仅保存在当前浏览器，并同时控制下方利率对比图；下载的 iCalendar 文件会在决议日前一天提醒。</p></div><div className="policy-bank-list">{policyBanks.map(bank=>{const selected=following.includes(bank.id);return <button key={bank.id} className={selected?'selected':''} aria-pressed={selected} onClick={()=>toggle(bank.id)}><span>{selected?<Check size={14}/>:<span className="policy-unchecked"/>}</span><strong>{bank.name}</strong><small>{bank.country} · {bank.shortName}</small></button>})}</div></section>
  <RateComparison following={following}/>
  <section className="policy-timeline"><div className="policy-section-heading"><div><h3>未来决议日</h3><p>“决议日”是公告日或两日会议的最后一天；不把会议开始日误写成利率决定时间。</p></div><span>{upcoming.length} 项已确认日程</span></div>{grouped.length?grouped.map(([month,events])=><div className="policy-month" key={month}><h4>{new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',timeZone:'UTC'}).format(new Date(month+'-01T00:00:00Z'))}</h4>{events.map(event=><article key={event.id} className={daysTo(event.decisionDate,now)<=7?'soon':''}><div className="policy-date"><strong>{event.decisionDate.slice(8)}</strong><span>{new Intl.DateTimeFormat('zh-CN',{weekday:'short',timeZone:'UTC'}).format(new Date(event.decisionDate+'T00:00:00Z'))}</span></div><div className="policy-event"><div><span>{event.country}</span><h5>{event.bank}</h5></div><p>{event.title}</p><small>{event.startDate===event.decisionDate?'当日决议':`${formatDate(event.startDate)} 开会 · ${formatDate(event.decisionDate)} 决议`} · {event.timezone}</small></div><div className="policy-actions"><b>{reminderLabel(daysTo(event.decisionDate,now))}</b><button onClick={()=>downloadCalendar([event])}><CalendarDays size={14}/>添加提醒</button><a href={event.sourceUrl} target="_blank" rel="noreferrer" aria-label={`打开${event.bank}官方日程`}><ExternalLink size={15}/></a></div></article>)}</div>):<div className="policy-empty">没有已选央行的未来决议日。可在上方重新选择关注范围。</div>}</section>
  <section className="policy-notes"><Info size={18}/><div><strong>使用方式与范围</strong><p>下载 `.ics` 后导入手机、Google、Apple 或 Outlook 日历，提醒由你的日历应用在决议日前一天触发。这里追踪的是已公布日程，不能替代决议声明；实际升息、降息或维持不变，须在公告发布后结合原文确认。</p><p>2027 年已纳入美联储、日本银行、英格兰银行和加拿大银行已公布日程；欧洲央行与韩国银行将待其官网发布后加入。中国人民银行的 LPR 按惯例在每月 20 日发布，遇节假日顺延；它不是预先固定的议息会议日，因此本页暂不将其伪装成确定会议提醒。</p><small>日程最近核对：{policyCalendarSourceCheckedAt} · {policyBanks.length} 家央行 · 每项均链接原始官网。</small></div></section>
 </section>;
}
