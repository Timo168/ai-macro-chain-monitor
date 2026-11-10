"use client";

import {useCallback,useEffect,useMemo,useState} from 'react';
import {ArrowDownToLine,ExternalLink,RefreshCw,Zap} from 'lucide-react';
import {Brush,CartesianGrid,Line,LineChart,ReferenceLine,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {appBase} from '../lib/runtime';
import {format} from '../lib/data';
import {regionalChartRows,regionalCsv,regionalDate,regionalNavigation,regionalRanges,regionalStats,regionalStatus,regionalWindow,type RegionalSeries} from '../lib/regional-energy.mjs';
import {PanelBody,PanelToggle,revealPanel,usePanelDisclosure} from './panel-disclosure';
import {useSavedView} from './use-saved-view';
import {useObserver} from './observer-context';
import {ObserverPin} from './observer-workspace';
import {ObservationNoteButton} from './research-notebook';
import './regional-energy.css';

const validRange=(value:unknown):value is string=>typeof value==='string'&&['1','7','30','90','365','all'].includes(value);
const validRegion=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9_-]{1,40}$/.test(value);
const clock=(value?:string|null)=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(value)):'暂无记录';
const signed=(value:number|null,digits:number)=>value==null?'—':`${value>0?'+':''}${format(value,digits)}`;

function EnergySeries({series,readFailed}:{series:RegionalSeries;readFailed:boolean}){
 const {catalog}=useObserver();const observationItem=catalog.find(item=>item.id===`regional:${series.id}`);
 const disclosure=usePanelDisclosure(`macro:regional:${series.id}`,{anchorId:series.id,scope:'macro'});
 const [range,setRange]=useSavedView(`regional:${series.id}:range`,series.frequency==='hourly'?'7':'90',validRange);
 const [zone,setZone]=useState<'beijing'|'local'>('beijing');
 const [zoom,setZoom]=useState<{startIndex?:number;endIndex?:number}|null>(null);
 const changeZoom=useCallback((next:{startIndex?:number;endIndex?:number})=>setZoom(previous=>previous?.startIndex===next.startIndex&&previous?.endIndex===next.endIndex?previous:next),[]);
 const availability=useMemo(()=>regionalRanges(series),[series]);
 const effective=availability.find(choice=>choice.value===range)?.available?range:'all';
 const selected=useMemo(()=>regionalWindow(series,effective),[series,effective]);
 const chartRows=useMemo(()=>regionalChartRows(selected,series.frequency),[selected,series.frequency]);
 const visibleRows=useMemo(()=>zoom?chartRows.slice(zoom.startIndex??0,(zoom.endIndex??chartRows.length-1)+1):chartRows,[chartRows,zoom]);
 const visible=useMemo(()=>visibleRows.filter(point=>!point.gap),[visibleRows]);
 const stats=useMemo(()=>regionalStats(series.observations,series.frequency),[series]);
 const selectedStats=useMemo(()=>regionalStats(visible,series.frequency),[visible,series.frequency]);
 const status=regionalStatus(series,readFailed),hourly=series.frequency==='hourly',digits=hourly?0:2,color=hourly?'#527db5':'#178a75';
 const timeZone=zone==='local'?series.timeZone:'Asia/Shanghai';
 useEffect(()=>setZoom(null),[series.id,effective,series.observations]);
 function exportCsv(){const url=URL.createObjectURL(new Blob([regionalCsv(series,visible)],{type:'text/csv;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=`${series.id}-${effective}.csv`;anchor.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return <article className="re-series" id={series.id} aria-label={series.name}>
  <header className="re-series-heading"><div><h4>{series.name}</h4><p>{hourly?'实际平均负荷 · 按小时结束时刻记录':'交易日批发成交价 · 官方每两周汇总'}</p></div><div className="panel-heading-actions"><ObserverPin itemId={`regional:${series.id}`} title={series.name}/><PanelToggle open={disclosure.open} onToggle={disclosure.toggle} controls={disclosure.contentId} label={series.name}/></div></header>
  <div className="re-series-value"><strong>{format(stats.last?.value,digits)} <small>{series.unit}</small></strong><span className={`state-pill ${status.warning?'warning':''}`}>{status.label}</span></div>
  <div className="re-series-meta"><span>观测 {regionalDate(stats.last?.date,series.frequency,timeZone)}{hourly?zone==='local'?'（当地）':'（北京）':''}</span><span>较前次观测 {signed(stats.previousChange,digits)} {series.unit}</span></div>
  {stats.latestMissing&&<p className="re-notice">最新观测期缺值，显示最近一次有效数值。</p>}
  {status.detail&&<p className="re-notice" role="status">{status.detail}</p>}
  <PanelBody open={disclosure.open} id={disclosure.contentId}>
   <div className="re-chart-controls"><div role="group" aria-label={`${series.name}时间范围`}>{availability.map(choice=><button type="button" key={choice.value} aria-pressed={effective===choice.value} disabled={!choice.available} onClick={()=>{setRange(choice.value);setZoom(null);}}>{choice.label}</button>)}</div><div>{hourly&&<label>图表时区<select value={zone} onChange={event=>setZone(event.target.value as typeof zone)}><option value="beijing">北京</option><option value="local">来源当地</option></select></label>}{zoom&&<button type="button" onClick={()=>setZoom(null)}>重置缩放</button>}<button type="button" className="re-export" onClick={exportCsv} disabled={!series.exportAllowed||!visible.length} title={series.exportAllowed?'导出当前区间 CSV':'来源导出许可待核实'} aria-label={`导出${series.name} CSV`}><ArrowDownToLine size={16}/><span>CSV</span></button></div></div>
   {chartRows.length?<><div className="re-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartRows} margin={{top:12,right:8,bottom:4,left:0}} accessibilityLayer><CartesianGrid vertical={false} stroke="#e4ece9" strokeDasharray="3 4"/><XAxis dataKey="date" tickFormatter={(value:string)=>hourly?regionalDate(value,'hourly',timeZone,true):value.slice(5)} tickLine={false} axisLine={false} minTickGap={38} tick={{fontSize:11,fill:'#667d74'}}/><YAxis domain={['auto','auto']} width={58} tickLine={false} axisLine={false} tick={{fontSize:11,fill:'#667d74'}} tickFormatter={(value:number)=>Math.abs(value)>=10000?`${format(value/1000,1)}k`:format(value,Math.abs(value)<10?1:0)}/><Tooltip filterNull labelFormatter={label=>`${regionalDate(String(label),series.frequency,timeZone)}${hourly?' · 小时结束':''}`} formatter={value=>[`${format(Number(value),digits)} ${series.unit}`,series.name]} contentStyle={{fontSize:12,maxWidth:280,border:'1px solid #d9e6df',borderRadius:8,whiteSpace:'normal'}}/>{!hourly&&<ReferenceLine y={0} stroke="#bdcbc5" strokeDasharray="4 4"/>}<Line dataKey="value" name={series.name} stroke={color} strokeWidth={2} dot={chartRows.length===1?{r:4}:false} connectNulls={false} isAnimationActive={false}/><Brush dataKey="date" height={24} stroke="#83a99a" fill="#f0f6f3" travellerWidth={12} ariaLabel={series.name+'时间范围'} tickFormatter={(value:string)=>hourly?regionalDate(value,'hourly',timeZone,true):value.slice(5)} onChange={changeZoom} startIndex={zoom?.startIndex??0} endIndex={zoom?.endIndex??Math.max(0,chartRows.length-1)}/></LineChart></ResponsiveContainer></div><div className="re-range-detail"><span>所选区间 {regionalDate(selectedStats.first?.date,series.frequency,timeZone,true)} — {regionalDate(selectedStats.last?.date,series.frequency,timeZone,true)}</span><span>变化 {signed(selectedStats.rangeChange,digits)} {series.unit}</span></div></>:<div className="re-empty">{status.status==='fetch_failed'?'来源暂时无法取得，尚无历史缓存。':status.status==='not_configured'?'来源尚未接入。':'暂无已发布的有效观测。'}</div>}
   {observationItem&&<ObservationNoteButton item={observationItem}/>}
   <div className="re-explanation"><strong>如何理解</strong><p>{hourly?'负荷是这一小时电网实际需要供给的电力。数值越高，用电需求越大；比较相近季节和时段，更容易看出需求变化。':'批发电价反映区域电力市场的购电价格。数值越高，市场购电成本越高；尖峰常与天气、燃料和供电状况有关。'}</p><strong>对 AI 产业链的影响</strong><p>{hourly?'负荷高峰帮助观察数据中心所在电网的供电压力，可结合项目并网和扩容进度判断建设条件。':'电价变化影响未锁价的用电采购成本。结合当地零售电价和项目购电合同，判断数据中心的实际成本。'}</p></div>
   <footer className="re-source"><div>{series.sourceUrl?<a href={series.sourceUrl} target="_blank" rel="noopener noreferrer">{series.sourceName}<ExternalLink size={12}/></a>:<span>{series.sourceName||'来源未配置'}</span>}<span>{hourly?'小时观测':'交易日观测'} · {series.timeZone}</span></div><p>最近成功获取 {clock(series.lastSuccessAt??series.fetchedAt)}（北京）</p><details><summary>口径与来源记录</summary><p>{series.methodology||'等待来源提供统计口径。'}</p>{series.publicationFrequency&&<p>发布节奏：{series.publicationFrequency}</p>}<p>最近检查 {clock(series.checkedAt)}（北京）{series.version?` · 版本 ${series.version}`:''}</p>{(series.licenseNote||series.license)&&<p>{series.licenseNote||series.license}</p>}{series.directSourceCheck?.note&&<p>直接来源核验 {series.directSourceCheck.checkedDate}：{series.directSourceCheck.note}</p>}{series.dataUrl&&<a href={series.dataUrl} target="_blank" rel="noopener noreferrer">原始数据 ↗</a>}</details></footer>
  </PanelBody>
 </article>;
}

export default function RegionalEnergy(){
 const disclosure=usePanelDisclosure('macro:regional-energy',{anchorId:'regional-energy',scope:'macro'});
 const {inputs,errors,loading,refresh}=useObserver();const data=inputs.regionalEnergy??null,error=errors.find(message=>message.startsWith('区域电力'))??'';
 const [region,setRegion]=useSavedView('regional:region','ercot',validRegion);
 useEffect(()=>{
  const read=()=>{const target=regionalNavigation(data,location.search,location.hash);if(!target)return;setRegion(target.regionId);revealPanel('macro:regional-energy');if(target.seriesId)revealPanel(`macro:regional:${target.seriesId}`);};
  read();window.addEventListener('popstate',read);window.addEventListener('hashchange',read);return()=>{window.removeEventListener('popstate',read);window.removeEventListener('hashchange',read);};
 },[data,setRegion]);
 function changeRegion(value:string){setRegion(value);const url=new URL(location.href);url.searchParams.set('region',value);url.hash='regional-energy';history.replaceState({},'',url.pathname+url.search+url.hash);}
 const selected=data?.regions.find(item=>item.id===region)??data?.regions[0];
 return <section id="regional-energy" className="chart-card regional-energy" aria-label="区域电力市场">
  <div className="chart-title"><div><h3><Zap size={19} aria-hidden="true"/>区域电力市场</h3><div className="chart-subtitle">把区域批发电价与实际用电负荷放在一起观察。</div></div><div className="panel-heading-actions"><button type="button" className="re-refresh" disabled={loading} onClick={refresh}><RefreshCw size={14} className={loading?'spinning':''}/>{loading?'检查中':'检查更新'}</button><PanelToggle open={disclosure.open} onToggle={disclosure.toggle} controls={disclosure.contentId} label="区域电力市场"/></div></div>
  {!disclosure.open&&selected&&<div className="panel-collapsed-summary"><strong>{selected.name}</strong>{selected.series.map(series=>{const stats=regionalStats(series.observations,series.frequency);return <span key={series.id}>{series.name} {format(stats.last?.value,series.frequency==='hourly'?0:2)} {series.unit} · {regionalStatus(series,!!error).label}</span>;})}</div>}
  <PanelBody open={disclosure.open} id={disclosure.contentId}>
   {error&&<p className="re-notice" role="status">{error}</p>}
   {data?<><div className="re-region-select" role="group" aria-label="选择电力地区">{data.regions.map(item=><button type="button" key={item.id} aria-pressed={selected?.id===item.id} onClick={()=>changeRegion(item.id)}>{item.name}</button>)}</div>{selected?.description&&<p className="re-description">{selected.description}</p>}<div className="re-series-grid">{selected?.series.map(series=><EnergySeries key={series.id} series={series} readFailed={!!error}/>)}</div>{!selected?.series.length&&<div className="re-empty">此地区的电价与负荷数据尚未接入。</div>}</>:<div className="re-empty">{loading?'正在读取区域电力数据…':'区域电力数据尚未取得。'}</div>}
   <div className="re-related"><span>一起观察</span><a href={appBase()+'?page=impact&industry=metrics&category=power'}>州级电价与电力基础设施 →</a><a href={appBase()+'?page=impact&industry=metrics&category=projects'}>数据中心建设进度 →</a></div>
  </PanelBody>
 </section>;
}
