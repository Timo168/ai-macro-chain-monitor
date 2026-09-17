"use client";

import {useEffect,useMemo,useState} from 'react';
import {Bell,CalendarDays,Check,Download,ExternalLink,Info,Clock3} from 'lucide-react';
import {ResponsiveContainer,LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip,ReferenceDot,ReferenceLine} from 'recharts';
import {Button} from '@/components/ui/button';
import {policyBanks,policyCalendar,policyCalendarSourceCheckedAt,type PolicyCalendarEvent} from '@/lib/policy-calendar';
import {policyRateColor,policyRateChange,type PolicyRatesDataset} from '@/lib/policy-rates';
import {isDecisionAheadOfMonthlyHistory,policyDecisionChange,type PolicyDecision,type PolicyDecisionsDataset} from '@/lib/policy-decisions';
import {manifestEndpoint,policyDecisionsEndpoint,policyRatesEndpoint,versionedEndpoint} from '@/lib/runtime';
import './policy-calendar.css';
import './policy-realtime.css';
import './policy-chart-overlay.css';

const storageKey='ai-macro-policy-calendar-following';
const legacyDefaultPolicyBanks=['fed','boj','bok','ecb','boe','boc'];
const dateFormatter=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'short',timeZone:'UTC'});
const beijingFormatter=new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'});
const toUtc=(date:string)=>Date.parse(date+'T00:00:00Z');
const formatDate=(date:string)=>dateFormatter.format(new Date(date+'T00:00:00Z'));
const formatBeijing=(value:string|undefined|null)=>value?`北京时间 ${beijingFormatter.format(new Date(value))}`:'北京时间待源数据提供';
const formatChartDate=(value:number|string)=>new Date(Number(value)).toISOString().slice(0,10);
const formatChartMonth=(value:number|string)=>formatChartDate(value).slice(2,7).replace('-','/');
const daysTo=(date:string,now=new Date())=>Math.round((toUtc(date)-Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()))/86400000);
const escapeIcs=(value:string)=>value.replaceAll('\\','\\\\').replaceAll(',','\\,').replaceAll(';','\\;').replaceAll('\n','\\n');
const policyFlagById:Record<string,string>={fed:'🇺🇸',boj:'🇯🇵',bok:'🇰🇷',ecb:'🇪🇺',boe:'🇬🇧',boc:'🇨🇦',rba:'🇦🇺',rbnz:'🇳🇿',snb:'🇨🇭',pboc:'🇨🇳',cbr:'🇷🇺',rbi:'🇮🇳',bcb:'🇧🇷',sarb:'🇿🇦'};
const policyBankById:Map<string,(typeof policyBanks)[number]>=new Map(policyBanks.map(bank=>[bank.id,bank]));

function PolicyRateTooltip({active,payload,label}:{active?:boolean;payload?:Array<{dataKey?:string|number;value?:number|string|null;color?:string}>;label?:number|string}){
 if(!active||!payload?.length||label==null)return null;
 const rates=payload.flatMap(point=>{
  const id=String(point.dataKey??'');
  const value=typeof point.value==='number'?point.value:Number(point.value);
  const bank=policyBankById.get(id);
  return bank&&Number.isFinite(value)?[{id,value,bank,color:point.color??policyRateColor(id)}]:[];
 }).sort((first,second)=>second.value-first.value||first.bank.name.localeCompare(second.bank.name,'zh-CN'));
 if(!rates.length)return null;
 return <div className="policy-rate-tooltip" role="status">
  <strong>{formatChartDate(label).slice(0,7)} · 月末</strong>
  <ul>{rates.map(rate=><li key={rate.id}>
   <i style={{background:rate.color}} aria-hidden="true"/>
   <span>{rate.bank.name} {policyFlagById[rate.id]??'🌐'}</span>
   <b>{rateNumber(rate.value)}</b>
  </li>)}</ul>
 </div>;
}

function reminderLabel(days:number){if(days<0)return '已过';if(days===0)return '今天决议';if(days===1)return '明天决议';return `${days} 天后决议`;}
function makeIcs(events:PolicyCalendarEvent[]){
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//AI Macro Observatory//Policy Calendar//ZH','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
 for(const event of events){
  const date=event.decisionDate.replaceAll('-','');
  lines.push('BEGIN:VEVENT',`UID:${event.id}@ai-macro-observatory`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')}`,`DTSTART;VALUE=DATE:${date}`,`SUMMARY:${escapeIcs(`${event.bank}：${event.title}`)}`,`DESCRIPTION:${escapeIcs(`利率决议日。请以央行官网为准：${event.sourceUrl}`)}`,`URL:${event.sourceUrl}`,'BEGIN:VALARM','TRIGGER:-P1D','ACTION:DISPLAY',`DESCRIPTION:${escapeIcs(`${event.bank} 利率决议明日公布`)}`,'END:VALARM','END:VEVENT');
 }
 lines.push('END:VCALENDAR');
 return lines.join('\r\n');
}
function downloadCalendar(events:PolicyCalendarEvent[]){
 const blob=new Blob([makeIcs(events)],{type:'text/calendar;charset=utf-8'});
 const href=URL.createObjectURL(blob);
 const link=document.createElement('a');
 link.href=href;
 link.download='主要央行利率日历.ics';
 link.click();
 URL.revokeObjectURL(href);
}
function rateNumber(value:number|undefined){return value==null?'—':`${value.toFixed(2).replace(/\.00$/,'')}%`;}
function rateRange(decision:PolicyDecision){return `${decision.lower.toFixed(2)}%–${decision.upper.toFixed(2)}%`;}

function RateComparison({following}:{following:string[]}){
 const [dataset,setDataset]=useState<PolicyRatesDataset|null>(null);
 const [decisionDataset,setDecisionDataset]=useState<PolicyDecisionsDataset|null>(null);
 const [loadError,setLoadError]=useState('');
 const [range,setRange]=useState<'1'|'3'|'5'|'10'>('5');

 useEffect(()=>{
  let cancelled=false;
  async function load(){
   try{
    let rateVersion='';
    let decisionVersion='';
    try{
     const manifestResponse=await fetch(manifestEndpoint(),{cache:'no-store'});
     if(manifestResponse.ok){
      const manifest=await manifestResponse.json() as {policyRates?:{version?:string};policyDecisions?:{version?:string}};
      rateVersion=manifest.policyRates?.version??'';
      decisionVersion=manifest.policyDecisions?.version??'';
     }
    }catch{}
    const rateResponse=await fetch(versionedEndpoint(policyRatesEndpoint(),rateVersion),{cache:'no-store'});
    if(!rateResponse.ok)throw new Error('政策利率数据暂不可用');
    const ratePayload=await rateResponse.json() as PolicyRatesDataset;
    if(!ratePayload.series?.length)throw new Error('政策利率数据尚未准备完成');
    let decisionPayload:PolicyDecisionsDataset|null=null;
    try{
     const decisionResponse=await fetch(versionedEndpoint(policyDecisionsEndpoint(),decisionVersion),{cache:'no-store'});
     if(decisionResponse.ok)decisionPayload=await decisionResponse.json() as PolicyDecisionsDataset;
    }catch{}
    if(!cancelled){
     setDataset(ratePayload);
     setDecisionDataset(decisionPayload);
     setLoadError('');
    }
   }catch{
    if(!cancelled)setLoadError('暂时无法读取政策利率缓存，请稍后重试。');
   }
  }
  void load();
  const timer=window.setInterval(()=>void load(),60_000);
  return()=>{cancelled=true;window.clearInterval(timer);};
 },[]);

 const visible=useMemo(()=>dataset?.series.filter(series=>following.includes(series.id))??[],[dataset,following]);
 const latestDecisions=useMemo(()=>{
  const next=new Map<string,PolicyDecision>();
  for(const decision of decisionDataset?.decisions??[]){
   if(!following.includes(decision.bankId))continue;
   const current=next.get(decision.bankId);
   if(!current||decision.announcementDate>current.announcementDate)next.set(decision.bankId,decision);
  }
  return [...next.values()].sort((first,second)=>second.announcementDate.localeCompare(first.announcementDate));
 },[decisionDataset,following]);
 const decisionsByBank=useMemo(()=>new Map(latestDecisions.map(decision=>[decision.bankId,decision])),[latestDecisions]);
 const latestFedDecision=useMemo(()=>latestDecisions.find(decision=>decision.bankId==='fed')??null,[latestDecisions]);
 const rows=useMemo(()=>{
  if(!visible.length)return [];
  const all=visible.flatMap(series=>series.observations.map(point=>point.date));
  const latest=[...all].sort().at(-1);
  if(!latest)return [];
  const from=new Date(latest+'T00:00:00Z');
  from.setUTCFullYear(from.getUTCFullYear()-Number(range));
  const floor=from.toISOString().slice(0,10);
  const dates=[...new Set(all.filter(date=>date>=floor))].sort();
  const maps=new Map(visible.map(series=>[series.id,new Map(series.observations.map(point=>[point.date,point.value]))]));
  return dates.map(date=>({date,timestamp:toUtc(date),...Object.fromEntries(visible.map(series=>[series.id,maps.get(series.id)?.get(date)??null]))}));
 },[visible,range]);
 const chartFedDecision=useMemo(()=>{
  const fedHistory=visible.find(series=>series.id==='fed');
  if(!latestFedDecision||!fedHistory||!rows[0])return null;
  return latestFedDecision.announcementDate>=rows[0].date&&isDecisionAheadOfMonthlyHistory(latestFedDecision,fedHistory.latestObservationDate)?latestFedDecision:null;
 },[latestFedDecision,rows,visible]);

 return <section className="policy-rates" aria-label="主要央行政策利率横向对比">
  <div className="policy-section-heading">
   <div><h3>政策利率横向对比</h3><p>折线统一为月度期末、年利率。各国决策日期不同，因此横向比较的是同一月末的政策水平；最新官方决议单独列出，不混入月末历史。</p></div>
   <div className="policy-rate-controls" aria-label="政策利率图表时间范围">{([['1','1年'],['3','3年'],['5','5年'],['10','10年']] as const).map(([value,label])=><button key={value} aria-pressed={range===value} onClick={()=>setRange(value)}>{label}</button>)}</div>
  </div>
  {dataset?<>
   {latestDecisions.length?<section className="policy-decision-strip" aria-label="最新官方利率决议">
    <div className="policy-decision-heading"><span><Clock3 size={15}/>最新官方决议</span><small>{decisionDataset?.status==='cached'?'暂用上次成功缓存':'后台每 15 分钟检查'}</small></div>
    <div className="policy-decision-list">{latestDecisions.map(decision=><article key={`${decision.bankId}-${decision.announcementDate}`}>
     <div><span>{decision.country} · {decision.bank}</span><strong>{rateRange(decision)}</strong></div>
     <p>官方公告 {decision.announcementDate} · {decision.effectiveDate?`${decision.effectiveDate} 生效`:'生效日待官方说明'} · {policyDecisionChange(decision)}</p>
     <small>{formatBeijing(decision.announcedAt)} · <a href={decision.statementUrl} target="_blank" rel="noreferrer">查看声明 <ExternalLink size={11}/></a>{decision.implementationUrl&&<a href={decision.implementationUrl} target="_blank" rel="noreferrer">实施说明 <ExternalLink size={11}/></a>}</small>
    </article>)}</div>
   </section>:<div className="policy-decision-unavailable"><strong>官方决议：</strong>{decisionDataset?.status==='fetch_failed'?'本轮获取失败，尚无可用缓存。':'等待后台同步官方决议；月末横向比较仍可正常使用。'}</div>}
   <div className="policy-rate-summary">{visible.map((series,index)=>{
    const decision=decisionsByBank.get(series.id);
    const change=policyRateChange(series);
    return <article key={series.id}>
     <span className="policy-rate-dot" style={{background:policyRateColor(series.id,index)}}/>
     <div><small>{series.country} · {series.shortName}</small><strong>{series.name}</strong></div>
     <b>{decision?rateRange(decision):rateNumber(series.latestValue)}</b>
     <p>{decision?`最新决议 · ${policyDecisionChange(decision)}`:`${series.latestObservationDate.slice(0,7)} 月末 · ${change==null?'无上月比较':`${change>0?'↑':'↓'} ${Math.abs(change).toFixed(3).replace(/0+$/,'').replace(/\.$/,'')} 个百分点`}`}</p>
    </article>;
   })}{!visible.length&&<div className="policy-empty">请在“我的关注范围”至少选择一家央行，以显示政策利率。</div>}</div>
   {rows.length&&visible.length?<>
    {chartFedDecision&&<div className="policy-chart-decision-disclosure"><i aria-hidden="true"/><span><strong>图中绿色虚线与圆点：</strong>美联储 {chartFedDecision.announcementDate} 官方决议，圆点按目标区间中点定位，完整区间为 {rateRange(chartFedDecision)}；这是决议日标记，不是月末观测。</span></div>}
    <div className="policy-rate-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={rows} margin={{top:15,right:12,bottom:0,left:-22}} accessibilityLayer>
     <CartesianGrid vertical={false} stroke="#e4ece9" strokeDasharray="3 4"/>
     <XAxis type="number" dataKey="timestamp" scale="time" domain={['dataMin','dataMax']} tickFormatter={formatChartMonth} minTickGap={46} tickLine={false} axisLine={false} tick={{fontSize:11,fill:'#819096'}}/>
     <YAxis tickFormatter={(value:number)=>`${value}%`} domain={['auto','auto']} tickLine={false} axisLine={false} tick={{fontSize:11,fill:'#819096'}} width={58}/>
     <Tooltip content={<PolicyRateTooltip/>}/>
     <ReferenceLine y={0} stroke="#adbdb9" strokeDasharray="4 4"/>
     {chartFedDecision&&<><ReferenceLine x={toUtc(chartFedDecision.announcementDate)} stroke={policyRateColor('fed')} strokeDasharray="4 3" strokeWidth={1.5} ifOverflow="extendDomain" zIndex={10}/><ReferenceDot x={toUtc(chartFedDecision.announcementDate)} y={chartFedDecision.midpoint} r={5} fill="#fff" stroke={policyRateColor('fed')} strokeWidth={2.5} ifOverflow="extendDomain"/></>}
     {visible.map((series,index)=><Line key={series.id} type="stepAfter" dataKey={series.id} name={series.name} stroke={policyRateColor(series.id,index)} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}/>)}
    </LineChart></ResponsiveContainer></div>
    <div className="policy-rate-legend">{visible.map((series,index)=><span key={series.id}><i style={{background:policyRateColor(series.id,index)}}/>{series.name}</span>)}<em>鼠标悬停查看月末值；上方显示已发布的即时官方决议</em></div>
   </>:<div className="policy-empty">所选央行还没有足够的同频历史数据。</div>}
   <div className="policy-rate-note">
    <p><strong>月末口径：</strong>{dataset.source.name} 选择各经济体最能反映货币当局政策意图的主要利率；若为目标区间则采用中点。它不是跨国实际融资成本，也不能直接代替各地的企业贷款利率。</p>
    <p><strong>各线覆盖：</strong>{visible.map(series=>`${series.shortName} 至 ${series.latestObservationDate.slice(0,7)}`).join('；')}。只显示每家央行实际已有的月末观测，不用旧值填补缺月。</p>
    <p><strong>更新：</strong>{dataset.source.frequency} · 最近检查 {dataset.checkedAt.slice(0,10)} · <a href={dataset.source.url} target="_blank" rel="noreferrer">查看 BIS 方法与数据 <ExternalLink size={12}/></a></p>
   </div>
  </>:<div className="policy-empty">{loadError||'正在读取政策利率历史数据…'}</div>}
 </section>;
}

export default function PolicyCalendar(){
 const [following,setFollowing]=useState<string[]>(()=>{
  if(typeof window==='undefined')return policyBanks.map(bank=>bank.id);
  try{
   const saved=localStorage.getItem(storageKey);
   const parsed=saved?JSON.parse(saved):null;
   if(!Array.isArray(parsed))return policyBanks.map(bank=>bank.id);
   const valid=parsed.filter((id):id is string=>typeof id==='string'&&policyBanks.some(bank=>bank.id===id));
   return legacyDefaultPolicyBanks.every(id=>valid.includes(id))?policyBanks.map(bank=>bank.id):valid;
  }catch{return policyBanks.map(bank=>bank.id);}
 });
 useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(following));}catch{}},[following]);
 const now=new Date();
 const visible=policyCalendar.filter(event=>following.includes(event.bankId));
 const upcoming=visible.filter(event=>daysTo(event.decisionDate,now)>=0);
 const next=upcoming[0];
 const nextSeven=upcoming.filter(event=>daysTo(event.decisionDate,now)<=7);
 const grouped=(()=>{
  const map=new Map<string,PolicyCalendarEvent[]>();
  for(const event of upcoming){
   const month=event.decisionDate.slice(0,7);
   map.set(month,[...(map.get(month)??[]),event]);
  }
  return [...map.entries()];
 })();
 function toggle(id:string){setFollowing(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);}
 return <section className="policy-calendar" aria-label="主要央行利率日历">
  <div className="policy-hero"><div><div className="policy-eyebrow">POLICY WATCH</div><h2>主要央行利率日历</h2><p>先关注会议与决议日，再阅读声明、预测和实际利率变化。日程来自各央行官网，发布时间以原始来源为准。</p></div><Button onClick={()=>downloadCalendar(upcoming)} disabled={!upcoming.length}><Download size={15}/>下载关注央行的提醒</Button></div>
  <div className="policy-top-grid">
   <section className="policy-next"><div className="policy-card-label"><Bell size={16}/>下一次利率决议</div>{next?<><strong>{next.bank} · {next.country}</strong><div className="policy-next-date">{formatDate(next.decisionDate)}</div><p>{next.title}</p><div className="policy-meta"><span>{reminderLabel(daysTo(next.decisionDate,now))}</span><span>{next.timezone}</span></div><a href={next.sourceUrl} target="_blank" rel="noreferrer">查看央行原始日程 <ExternalLink size={13}/></a></>:<p>当前关注范围内暂无已确认的未来日程。</p>}</section>
   <section className="policy-alerts"><div className="policy-card-label"><Clock3 size={16}/>未来 7 天</div>{nextSeven.length?<ul>{nextSeven.map(event=><li key={event.id}><span>{formatDate(event.decisionDate)}</span><strong>{event.bank}</strong><small>{event.title}</small></li>)}</ul>:<div className="policy-empty">未来七天没有已确认的利率决议。日程临时调整时，以央行公告为准。</div>}</section>
  </div>
  <section className="policy-follow"><div><h3>我的关注范围</h3><p>选择需要跟踪的央行。选择结果仅保存在当前浏览器，并同时控制下方利率对比图；下载的 iCalendar 文件会在决议日前一天提醒。</p></div><div className="policy-bank-list">{policyBanks.map(bank=>{const selected=following.includes(bank.id);return <button key={bank.id} className={selected?'selected':''} aria-pressed={selected} onClick={()=>toggle(bank.id)}><span>{selected?<Check size={14}/>:<span className="policy-unchecked"/>}</span><strong>{bank.name}</strong><small>{bank.country} · {bank.shortName}</small></button>;})}</div></section>
  <RateComparison following={following}/>
  <section className="policy-timeline"><div className="policy-section-heading"><div><h3>未来决议日</h3><p>“决议日”是公告日或两日会议的最后一天；不把会议开始日误写成利率决定时间。</p></div><span>{upcoming.length} 项已确认日程</span></div>{grouped.length?grouped.map(([month,events])=><div className="policy-month" key={month}><h4>{new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',timeZone:'UTC'}).format(new Date(month+'-01T00:00:00Z'))}</h4>{events.map(event=><article key={event.id} className={daysTo(event.decisionDate,now)<=7?'soon':''}><div className="policy-date"><strong>{event.decisionDate.slice(8)}</strong><span>{new Intl.DateTimeFormat('zh-CN',{weekday:'short',timeZone:'UTC'}).format(new Date(event.decisionDate+'T00:00:00Z'))}</span></div><div className="policy-event"><div><span>{event.country}</span><h5>{event.bank}</h5></div><p>{event.title}</p><small>{event.startDate===event.decisionDate?'当日决议':`${formatDate(event.startDate)} 开会 · ${formatDate(event.decisionDate)} 决议`} · {event.timezone}</small></div><div className="policy-actions"><b>{reminderLabel(daysTo(event.decisionDate,now))}</b><button onClick={()=>downloadCalendar([event])}><CalendarDays size={14}/>添加提醒</button><a href={event.sourceUrl} target="_blank" rel="noreferrer" aria-label={`打开${event.bank}官方日程`}><ExternalLink size={15}/></a></div></article>)}</div>):<div className="policy-empty">没有已选央行的未来决议日。可在上方重新选择关注范围。</div>}</section>
  <section className="policy-notes"><Info size={18}/><div><strong>使用方式与范围</strong><p>下载 `.ics` 后导入手机、Google、Apple 或 Outlook 日历，提醒由你的日历应用在决议日前一天触发。这里追踪的是已公布日程，不能替代决议声明；实际升息、降息或维持不变，须在公告发布后结合原文确认。</p><p>2027 年已纳入美联储、日本银行、英格兰银行和加拿大银行已公布日程；欧洲央行与韩国银行将待其官网发布后加入。中国人民银行的 LPR 按惯例在每月 20 日发布、遇节假日顺延，并非预先固定的议息会议；印度储备银行的下一期 MPC 日程尚未在当前官方核对范围内。因此两者可在利率图中比较，但不会被伪装成确定的会议提醒。</p><small>日程最近核对：{policyCalendarSourceCheckedAt} · {policyBanks.length} 家央行 · 每项均链接原始官网。</small></div></section>
 </section>;
}
