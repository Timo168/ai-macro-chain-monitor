"use client";

import {useEffect,useId,useMemo,useState} from 'react';
import {ArrowUpRight,Building2,ChevronRight,ExternalLink,Layers3,MapPin,Minus,Plus,RefreshCw,RotateCcw,Zap} from 'lucide-react';
import {CartesianGrid,Line,LineChart,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import type {DataCenterProject,IndustryDataset} from '@/lib/industry/types';
import {buildInfrastructureGeography,geographyHistory,heatBucket,projectSourceStatus,regionalMarketSnapshot,STATE_NAMES} from '@/lib/industry/geography.mjs';
import geometry from '@/lib/industry/us-state-geometry.json';
import {appBase} from '@/lib/runtime';
import {beijing,format} from '@/lib/data';
import {regionalDate,regionalStatus} from '@/lib/regional-energy.mjs';
import {useObserver} from '../observer-context';
import {PanelBody,PanelToggle,usePanelDisclosure} from '../panel-disclosure';
import './infrastructure-map.css';
import ProjectCapacity,{projectCapacityPreview} from './project-capacity';

type Layer='construction'|'price'|'sales'|'markets';
type ConstructionMeasure='projectCount'|'constructionMw'|'operationalMw'|'estimatedOperationalMw'|'estimatedPlannedMw'|'estimatedFacilityMw'|'officialComputeMw';
const measureNames:Record<ConstructionMeasure,string>={projectCount:'公开项目数',officialComputeMw:'在建计算容量 · 官方',constructionMw:'在建规划容量 · 官方',operationalMw:'已投运容量 · 官方',estimatedOperationalMw:'已投运 AI IT 容量 · 机构估算',estimatedPlannedMw:'规划 AI IT 容量 · 机构估算',estimatedFacilityMw:'已投运设施容量 · 机构估算'};
const measureNotes:Record<ConstructionMeasure,string>={projectCount:'颜色越深，当前公开样本中该阶段的项目越多。',officialComputeMw:'在建项目官方披露的最终计算容量。建设范围与一期 IT 容量估算分别展示。',constructionMw:'已明确开工项目的规划数据中心容量；按官方披露口径比较。',operationalMw:'官方明确披露的已投运数据中心容量。',estimatedOperationalMw:'机构估算的 AI 设施 IT 容量，反映服务器等 IT 设备的电力规模。覆盖楼栋、估算日期和来源见项目记录。',estimatedPlannedMw:'机构估算的未来规划 IT 容量；目标年份按项目分别标注。',estimatedFacilityMw:'机构估算的设施电力容量，包括 IT 设备与制冷等设施用电。仅有范围的项目在详情展示，不加入精确数值对比。'};
const layers:{id:Layer;title:string;subtitle:string}[]=[
 {id:'construction',title:'建设热度',subtitle:'项目与建设阶段'},
 {id:'price',title:'地区电价',subtitle:'同月用电成本'},
 {id:'sales',title:'用电规模',subtitle:'州级售电量'},
 {id:'markets',title:'区域电网',subtitle:'小时负荷与批发价'},
];
const stages:Record<string,string>={announced:'已公告',planning:'规划中',approval:'审批中',construction:'在建',partially_operational:'部分投运',operational:'已投运',delayed:'延期',cancelled:'已取消',unknown:'状态待核实'};
const statusNames:Record<string,string>={ready:'已获取',reviewed:'官方核验',available:'已获取',cached:'展示缓存',fetch_failed:'获取失败',not_published:'尚未发布',no_observation:'尚无观测',not_configured:'未配置',pending:'未配置',historical:'历史记录',delayed:'来源观测滞后'};
const tones=['#def1e8','#9ed2bb','#4d9e85','#11624e'];
const priceTones=['#f9e9ce','#e8bd7d','#c68341','#8c4b25'];
const salesTones=['#dceafa','#9fc0df','#5c8fbe','#285a89'];
const marketAnchor:Record<string,string>={ercot:'TX',pjm:'PA'};
const mapLink=(id:string)=>appBase()+`?page=impact&industry=metrics&category=power#${encodeURIComponent(id)}`;
const validNumber=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const shortNumber=(value:number|null|undefined)=>value==null?'—':format(value,Number.isInteger(value)?0:2);
const dateText=(value?:string|null)=>value?(value.length<=10?value:beijing(value)):'暂无记录';

export default function InfrastructureMap({data,initialLayer='construction',initialMeasure='projectCount'}:{data:IndustryDataset;initialLayer?:Layer;initialMeasure?:ConstructionMeasure}){
 const {inputs,errors,loading,refresh}=useObserver();
 const disclosure=usePanelDisclosure('industry:infrastructure-map',{anchorId:'infrastructure-map',scope:'industry'});
 const [layer,setLayer]=useState<Layer>(initialLayer),[sector,setSector]=useState<'industrial'|'commercial'>('industrial'),[month,setMonth]=useState(''),[stage,setStage]=useState('all'),[measure,setMeasure]=useState<ConstructionMeasure>(initialMeasure);
 const [selected,setSelected]=useState('TX'),[market,setMarket]=useState('ercot'),[marketKind,setMarketKind]=useState<'load'|'wholesale_price'>('load'),[marketDate,setMarketDate]=useState(''),[hover,setHover]=useState<string|null>(null),[showProjects,setShowProjects]=useState(true),[zoom,setZoom]=useState(1);
 const maskId='infra-empty-'+useId().replaceAll(':','');
 const model=useMemo(()=>buildInfrastructureGeography(data,{sector,month:month||undefined,statuses:stage==='all'?undefined:[stage]}),[data,sector,month,stage]);
 const markets=useMemo(()=>regionalMarketSnapshot(inputs.regionalEnergy,{kind:marketKind,date:marketDate||undefined}),[inputs.regionalEnergy,marketKind,marketDate]);
 const regionReadFailed=errors.some(error=>error.startsWith('区域电力'));
 const byCode=useMemo(()=>new Map(model.rows.map(row=>[row.code,row])),[model]);
 const active=byCode.get(selected)??model.rows[0];
 const selectedMarket=markets.rows.find(row=>row.id===market)??markets.rows[0];
 const stateValue=(row:typeof model.rows[number])=>layer==='price'?row.price.value:layer==='sales'?row.sales.value:row[measure];
 const values=layer==='markets'?markets.rows.map(row=>row.value).filter(validNumber):model.rows.map(stateValue).filter(validNumber);
 const palette=layer==='price'?priceTones:layer==='sales'||layer==='markets'?salesTones:tones;
 const colorFor=(value:number|null|undefined)=>{const bucket=heatBucket(value,values);return bucket==null?`url(#${maskId})`:palette[bucket];};
 const rank=useMemo(()=>layer==='markets'?[]:model.rows.filter(row=>validNumber(stateValue(row))).sort((a,b)=>(stateValue(b)??0)-(stateValue(a)??0)||a.code.localeCompare(b.code)),[model,layer,measure]);
 const unit=layer==='price'?'美分/kWh':layer==='sales'?'MWh':layer==='markets'?(marketKind==='load'?'MW':'美元/MWh'):measure==='projectCount'?'项':'MW';
 const metricTitle=layer==='construction'?measureNames[measure]:layer==='price'?`${sector==='industrial'?'工业':'商业'}平均零售电价`:layer==='sales'?`${sector==='industrial'?'工业':'商业'}售电量`:marketKind==='load'?'实际小时负荷':'交易日批发电价';
 const projectCountLayer=layer==='construction'&&measure==='projectCount';
 const capacityLayer=layer==='construction'&&!projectCountLayer;
 const showProjectCounts=projectCountLayer&&showProjects;
 const estimateLayer=layer==='construction'&&['estimatedOperationalMw','estimatedPlannedMw','estimatedFacilityMw'].includes(measure);
 const estimateKey=measure==='estimatedPlannedMw'?'estimatedPlanned':measure==='estimatedFacilityMw'?'estimatedFacility':'estimatedOperational';
 const estimateRows=model.rows.map(row=>row[estimateKey]);
 const estimateCount=estimateRows.reduce((sum,row)=>sum+row.count,0);
 const estimateEligible=estimateRows.reduce((sum,row)=>sum+row.eligibleProjectCount,0);
 const estimateCached=estimateRows.reduce((sum,row)=>sum+row.cachedCount,0);
 const estimateDates=estimateRows.flatMap(row=>[row.oldestAsOfDate,row.newestAsOfDate]).filter((date):date is string=>!!date).sort();
 const hovered=hover?byCode.get(hover):null;
 const focusShape=geometry.states.find(row=>row.code===selected);
 const width=geometry.width/zoom,height=geometry.height/zoom;
 const center=zoom===1?[geometry.width/2,geometry.height/2]:focusShape?.centroid??[geometry.width/2,geometry.height/2];
 const viewBox=`${Math.max(0,Math.min(geometry.width-width,center[0]-width/2))} ${Math.max(0,Math.min(geometry.height-height,center[1]-height/2))} ${width} ${height}`;
 const sampleCount=model.rows.reduce((sum,row)=>sum+row.projects.length,0);
 const sampleStates=model.rows.filter(row=>row.projects.length).length;
 const dataPeriod=layer==='markets'?(markets.date?regionalDate(markets.date,marketKind==='load'?'hourly':'daily','Asia/Shanghai'):'暂无共同观测'):layer==='construction'?'项目最近披露状态':`${model.month||'暂无观测'} · 同月比较`;
 useEffect(()=>{setLayer(initialLayer)},[initialLayer]);
 useEffect(()=>{setHover(null)},[layer,month,sector,stage,measure]);
 function selectState(code:string){setSelected(code);setHover(null)}
 function changeLayer(next:Layer){setLayer(next);setZoom(1);setHover(null)}
 const rangeMin=values.length?Math.min(...values):null,rangeMax=values.length?Math.max(...values):null;
 return <section className="infra-map" id="infrastructure-map" aria-label="数据中心与电力地图">
  <header className="infra-heading"><div><span className="infra-eyebrow"><MapPin size={14}/> INFRASTRUCTURE ATLAS</span><h2>数据中心与电力地图</h2><p>在同一张地图上，看项目建在哪里、当地用电成本和需求有多大。</p></div><div className="infra-heading-actions"><span className="infra-scope">美国 · 州级 / 区域市场</span><button type="button" className="industry-button" onClick={()=>{refresh();window.dispatchEvent(new Event('industry:refresh'))}} disabled={loading}><RefreshCw size={14} className={loading?'spinning':''}/>{loading?'检查中':'检查更新'}</button><PanelToggle open={disclosure.open} onToggle={disclosure.toggle} controls={disclosure.contentId} label="数据中心与电力地图"/></div></header>
  {!disclosure.open&&<p className="infra-collapsed">{sampleCount} 个公开项目 · {sampleStates} 个项目州 · {model.rows.filter(row=>row.price.value!=null).length} 个州有本月电价</p>}
  <PanelBody open={disclosure.open} id={disclosure.contentId}>
   <div className="infra-layers" role="group" aria-label="地图数据图层">{layers.map(item=><button key={item.id} type="button" aria-pressed={layer===item.id} onClick={()=>changeLayer(item.id)}><span>{item.title}</span><small>{item.subtitle}</small></button>)}</div>
   <div className="infra-filters">
    {layer==='construction'?<><label>热度口径<select value={measure} onChange={event=>setMeasure(event.target.value as ConstructionMeasure)}>{Object.entries(measureNames).map(([id,name])=><option value={id} key={id}>{name}</option>)}</select></label><label>建设阶段<select value={stage} onChange={event=>setStage(event.target.value)}><option value="all">全部阶段</option>{Object.entries(stages).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label></>:
    layer==='markets'?<><label>区域指标<select value={marketKind} onChange={event=>{setMarketKind(event.target.value as typeof marketKind);setMarketDate('')}}><option value="load">实际小时负荷</option><option value="wholesale_price">交易日批发电价</option></select></label><label>比较时点<select value={marketDate||markets.date||''} disabled={!markets.dates.length} onChange={event=>setMarketDate(event.target.value)}>{!markets.dates.length&&<option value="">暂无观测</option>}{markets.dates.map(date=><option key={date} value={date}>{regionalDate(date,marketKind==='load'?'hourly':'daily','Asia/Shanghai')}</option>)}</select></label></>:
    <><label>用电类别<select value={sector} onChange={event=>{setSector(event.target.value as typeof sector);setMonth('')}}><option value="industrial">工业</option><option value="commercial">商业</option></select></label><label>比较月份<select value={month||model.month||''} disabled={!model.months.length} onChange={event=>setMonth(event.target.value)}>{!model.months.length&&<option value="">暂无观测</option>}{model.months.map(period=><option key={period} value={period}>{period}</option>)}</select></label></>}
    <label className="infra-state-select">查看地区<select value={layer==='markets'?(selectedMarket?.id??''):selected} onChange={event=>layer==='markets'?setMarket(event.target.value):selectState(event.target.value)}>{layer==='markets'?markets.rows.map(row=><option key={row.id} value={row.id}>{row.name}</option>):geometry.states.map(row=><option key={row.code} value={row.code}>{STATE_NAMES[row.code]} · {row.code}</option>)}</select></label>
    {projectCountLayer&&<label className="infra-check"><input type="checkbox" checked={showProjects} onChange={event=>setShowProjects(event.target.checked)}/>显示项目数量</label>}
   </div>
   <div className="infra-context"><span><b>{metricTitle}</b> · {dataPeriod}{layer==='markets'&&marketKind==='load'?'（北京）':''}</span><span>{layer==='markets'?`${markets.rows.filter(row=>row.value!=null).length} / ${markets.rows.length} 个区域有该时点观测`:`${sampleCount} 个公开项目 · ${sampleStates} 个项目州`}</span></div>
   {estimateLayer&&<div className="infra-estimate-coverage"><span><strong>机构估算</strong> · 已覆盖 {estimateCount} / {estimateEligible} 个适用项目</span><span>数据截至 {estimateDates.length?`${estimateDates[0]} — ${estimateDates.at(-1)}`:'暂无可用记录'}</span>{estimateCached>0&&<span>其中 {estimateCached} 项展示最近成功缓存</span>}<span>来源：{[...new Set(estimateRows.flatMap(row=>row.sourceNames))].join('、')||'待接入'}</span></div>}
   <div className="infra-map-layout">
    <div className="infra-map-main">
     <div className="infra-canvas">
      <div className="infra-map-tools" role="group" aria-label="地图缩放"><button type="button" onClick={()=>setZoom(value=>Math.min(3,value+.5))} disabled={zoom>=3} aria-label="放大所选地区"><Plus size={16}/></button><button type="button" onClick={()=>setZoom(value=>Math.max(1,value-.5))} disabled={zoom<=1} aria-label="缩小地图"><Minus size={16}/></button><button type="button" onClick={()=>setZoom(1)} aria-label="重置地图"><RotateCcw size={15}/></button></div>
      <svg viewBox={viewBox} className="infra-svg" role="group" aria-label="美国州级数据热力地图">
       <defs><pattern id={maskId} width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="#eef1ef"/><path d="M-1 1L1-1M0 7L7 0M6 8L8 6" stroke="#dfe6e2" strokeWidth="1"/></pattern></defs>
       {geometry.states.map(shape=>{const row=byCode.get(shape.code),value=row&&layer!=='markets'?stateValue(row):null;const description=`${STATE_NAMES[shape.code]}，${value==null?'暂无可比数据':shortNumber(value)+' '+unit}`;return <path key={shape.code} d={shape.path} fill={layer==='markets'?'#e8efec':colorFor(value)} className={`infra-state ${selected===shape.code&&layer!=='markets'?'is-selected':''}`} role={layer==='markets'?'presentation':'button'} tabIndex={layer==='markets'?undefined:0} aria-label={layer==='markets'?undefined:description} aria-pressed={layer==='markets'?undefined:selected===shape.code} onPointerEnter={()=>layer!=='markets'&&setHover(shape.code)} onPointerLeave={()=>setHover(null)} onFocus={()=>layer!=='markets'&&setHover(shape.code)} onBlur={()=>setHover(null)} onClick={()=>{if(layer!=='markets')selectState(shape.code)}} onKeyDown={event=>{if(layer!=='markets'&&(event.key==='Enter'||event.key===' ')){event.preventDefault();selectState(shape.code)}}}><title>{description}</title></path>})}
       {geometry.states.map(shape=>{
        const row=byCode.get(shape.code);if(layer==='markets'||!row)return null;
        const value=stateValue(row);
        if(capacityLayer&&!validNumber(value))return null;
        if(!row.projects.length&&value==null)return null;
        const showCount=showProjectCounts&&row.projectCount!=null;
        // Separate the neighboring Indiana/Ohio labels while keeping each on its state.
        const offset=capacityLayer?(shape.code==='IN'?[-14,14]:shape.code==='OH'?[14,-14]:[0,0]):[0,0];
        return <g key={shape.code} pointerEvents="none" className={`infra-map-label${capacityLayer?' infra-capacity-label':''}`} transform={`translate(${shape.centroid[0]+offset[0]},${shape.centroid[1]+offset[1]})`}>
         <text y={capacityLayer?-17:showCount?19:4}>{shape.code}</text>
         {capacityLayer&&<text className="infra-capacity-value" y={8}>{shortNumber(value)}<tspan className="infra-capacity-unit"> MW</tspan></text>}
         {showCount&&<><circle r={12} cy={-4}/><text className="infra-bubble-number" y={0}>{row.projectCount}</text></>}
        </g>;
       })}
       {layer==='markets'&&markets.rows.map(row=>{const shape=geometry.states.find(item=>item.code===marketAnchor[row.id]);return shape?<g key={row.id} className={`infra-market-point ${selectedMarket?.id===row.id?'is-selected':''}`} role="button" tabIndex={0} aria-label={`${row.name}，${shortNumber(row.value)} ${unit}`} aria-pressed={selectedMarket?.id===row.id} transform={`translate(${shape.centroid[0]},${shape.centroid[1]})`} onClick={()=>setMarket(row.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setMarket(row.id)}}}><circle r={36} className="infra-market-halo"/><circle r={23} fill={colorFor(row.value)}/><text y={46}>{row.id.toUpperCase()}</text><title>{`${row.name} · ${shortNumber(row.value)} ${unit}`}</title></g>:null})}
      </svg>
      {hovered&&<div className="infra-tooltip" role="status"><strong>{hovered.name} · {hovered.code}</strong><b>{shortNumber(stateValue(hovered))} <small>{unit}</small></b><span>{metricTitle} · {layer==='construction'?'当前样本':model.month}</span>{estimateLayer&&<span>覆盖 {hovered[estimateKey].count} / {hovered[estimateKey].eligibleProjectCount} 个适用项目{hovered[estimateKey].cachedCount?' · 含缓存':''}</span>}<span>公开项目 {hovered.projects.length?hovered.projects.length+' 项':'尚无样本'} · 点击查看</span></div>}
      <div className="infra-map-caption">{layer==='markets'?'圆点为区域市场入口，点击查看负荷与批发价。':'点击州或选择右侧地区，查看项目和电力数据。'}</div>
     </div>
     <div className="infra-legend"><div><span className="infra-swatch infra-no-data"/> {layer==='construction'?'暂无样本 / 暂无可比容量':'暂无该期数据'}</div><div className="infra-color-key"><span>{shortNumber(rangeMin)}</span><span className="infra-scale">{palette.map(tone=><i key={tone} style={{background:tone}}/>)}</span><span>{shortNumber(rangeMax)} {unit}</span></div>{showProjectCounts&&<div><span className="infra-bubble-key">2</span>州内项目数</div>}</div>
     <p className="infra-map-note">{layer==='construction'?measureNotes[measure]:layer==='price'?'颜色越深，当月平均零售电价越高；可切换工业、商业口径。':layer==='sales'?'颜色越深，当月售电量越大。它反映地区整体用电规模。':'同一时间比较区域市场。圆点用于定位入口；市场覆盖多个地区，负荷反映整个电网规模。'}</p>
    </div>
    <aside className="infra-ranking" aria-label="地区对比"><header><span>{layer==='markets'?'区域市场':'同口径地区对比'}</span><small>{layer==='markets'?markets.rows.length:rank.length} 个地区</small></header><div className="infra-rank-list">
     {layer==='markets'?markets.rows.map(row=><button type="button" key={row.id} aria-pressed={selectedMarket?.id===row.id} onClick={()=>setMarket(row.id)}><span><b>{row.name}</b><small>{regionalStatus(row.series??undefined,regionReadFailed).label}</small></span><strong>{shortNumber(row.value)}<small>{unit}</small></strong></button>):rank.length?rank.map((row,index)=><button type="button" key={row.code} aria-pressed={selected===row.code} onClick={()=>selectState(row.code)}><span className="infra-rank-number">{index+1}</span><span className="infra-rank-content"><span><b>{row.name}</b><strong>{shortNumber(stateValue(row))}</strong></span><span className="infra-rank-bar"><i style={{width:`${rangeMax&&rangeMax>0?Math.max(3,((stateValue(row)??0)/rangeMax)*100):3}%`,background:colorFor(stateValue(row))}}/></span></span></button>):<div className="infra-empty">当前口径暂无可比较数据，可切换建设阶段、容量口径或月份。</div>}
    </div><footer>{layer==='construction'?(projectCountLayer?'按所选建设阶段的项目数排序。':'按所选容量（MW）排序。'):layer==='markets'?'未取得共同观测的市场保留为空。':'按同月数值排序，缺值不参与排列。'}</footer></aside>
   </div>
   {layer==='markets'?<div className="infra-market-detail">{selectedMarket?<><header><div><span className="infra-eyebrow">REGIONAL GRID</span><h3>{selectedMarket.name}</h3></div><a className="industry-button" href={appBase()+`?page=materials&region=${encodeURIComponent(selectedMarket.id)}#${selectedMarket.series?.id??'regional-energy'}`}>查看完整电力图表<ArrowUpRight size={14}/></a></header><div className="infra-market-stats"><div><small>{metricTitle} · 当前比较时点</small><strong>{shortNumber(selectedMarket.value)} <small>{unit}</small></strong><span>{dataPeriod}</span></div><div><small>最近有效观测</small><strong>{shortNumber(selectedMarket.latest?.value)} <small>{unit}</small></strong><span>{selectedMarket.latest?regionalDate(selectedMarket.latest.date,marketKind==='load'?'hourly':'daily','Asia/Shanghai'):'尚无观测'}</span></div><div><small>数据状态</small><strong className="infra-status-text">{regionalStatus(selectedMarket.series??undefined,regionReadFailed).label}</strong><span>{regionalStatus(selectedMarket.series??undefined,regionReadFailed).detail}</span></div></div>{selectedMarket.series&&<><MiniHistory rows={selectedMarket.series.observations.map(point=>({date:point.date,value:point.value}))} unit={unit} color={salesTones[3]} frequency={marketKind==='load'?'hourly':'daily'} cutoff={markets.date??undefined}/><div className="infra-source-line"><a href={selectedMarket.series.sourceUrl??undefined} target="_blank" rel="noreferrer">{selectedMarket.series.sourceName}<ExternalLink size={12}/></a><span>最近成功获取 {dateText(selectedMarket.series.lastSuccessAt??selectedMarket.series.fetchedAt)}</span></div></>}</>:<p className="infra-empty">{loading?'正在读取区域电力数据…':'区域电力数据尚未取得。可检查更新后重试。'}</p>}</div>:
   active&&<div className="infra-region-detail" aria-live="polite"><header><div><span className="infra-eyebrow">{active.code} · REGION DETAIL</span><h3>{active.name}</h3></div><span className="infra-scope">{active.projects.length} 个公开项目 · {model.month||'电力数据待接入'}</span></header><div className="infra-detail-grid"><div className="infra-projects"><h4><Building2 size={16}/>建设进度</h4>{active.projects.length?<><div className="infra-stage-strip">{Object.entries(active.statusCounts).filter(([,count])=>Number(count)>0).map(([id,count])=><span key={id}><i className={`infra-stage-dot ${id}`}/>{stages[id]??id} <b>{String(count)}</b></span>)}</div>{estimateLayer&&<p className="infra-estimate-region">{active[estimateKey].value==null?<>暂无精确容量，范围见项目详情</>:<>本州同口径样本约 <b>{shortNumber(active[estimateKey].value)} MW</b></>} · 覆盖 {active[estimateKey].count} / {active[estimateKey].eligibleProjectCount} 个适用项目{active[estimateKey].cachedCount>0?` · ${active[estimateKey].cachedCount} 项缓存`:""}</p>}<div className="infra-project-list">{active.projects.map(project=><ProjectRecord key={project.id} project={project} data={data}/>)}</div></>:<p className="infra-empty">这个州尚未收录项目样本。可以先查看电价和售电量。</p>}</div><div className="infra-electricity"><h4><Zap size={16}/>{sector==='industrial'?'工业':'商业'}用电背景</h4><div className="infra-price-cards"><div><span>平均零售电价</span><b>{shortNumber(active.price.value)} <small>美分/kWh</small></b><small>{statusNames[active.price.status]??active.price.status} · {model.month||'暂无观测'}</small></div><div><span>当月售电量</span><b>{shortNumber(active.sales.value)} <small>MWh</small></b><small>{statusNames[active.sales.status]??active.sales.status} · {model.month||'暂无观测'}</small></div></div>
    {(active.price.value!=null||active.sales.value!=null)&&<MiniHistory rows={(data.series[layer==='sales'?active.sales.metricId:active.price.metricId]?.observations??[]).map(point=>({date:point.periodEnd,value:point.value}))} unit={layer==='sales'?'MWh':'美分/kWh'} color={layer==='sales'?salesTones[3]:priceTones[3]} cutoff={model.month??undefined}/>}
    <div className="infra-source-line">{active.price.sourceUrl&&<a href={active.price.sourceUrl} target="_blank" rel="noreferrer">EIA 电力统计<ExternalLink size={12}/></a>}<span>成功获取 {dateText(active.price.lastSuccessfulAt)}</span></div>{(active.price.error||active.sales.error)&&<p className="infra-data-warning">来源检查未成功，本图保留已有观测。{active.price.error||active.sales.error}</p>}{data.definitions.some(def=>def.id===active.price.metricId)&&<a className="infra-detail-link" href={mapLink(active.price.metricId)}>查看历史、计算口径与版本<ChevronRight size={14}/></a>}
   </div></div></div>}
   <details className="infra-method"><summary><Layers3 size={14}/>地图口径与数据覆盖</summary><p>建设热度统计当前已收录的公开项目，按来源披露的州定位。“公开项目数”模式的圆点数字和州颜色均对应所选建设阶段；容量模式直接标注对应数值与 MW 单位，无容量数据的州不显示数值。电价和用电规模模式显示对应热度与州缩写。没有可比数据的地区显示斜纹。</p><p>电价和售电量使用 EIA 州级月度统计，默认最近共同月份。区域市场保留小时负荷、交易日批发价各自的时间和单位。全国及公司整体指标可在“指标详情”中继续查看。</p><p>地图底图来自美国人口普查局边界，经 us-atlas 简化；阿拉斯加、夏威夷为插图。市场点按所在区域示意定位。<a href="https://github.com/topojson/us-atlas" target="_blank" rel="noreferrer">底图来源 ↗</a></p><p>产业数据获取 {dateText(data.generatedAt)} · 区域电力获取 {dateText(inputs.regionalEnergy?.generatedAt)}</p>{model.unlocatedProjects.length>0&&<p>尚未定位 {model.unlocatedProjects.length} 个项目：{model.unlocatedProjects.map(project=>project.name).join('、')}。</p>}</details>
  </PanelBody>
 </section>;
}

function MiniHistory({rows,unit,color,frequency='monthly',cutoff}:{rows:{date:string;value:number|null}[];unit:string;color:string;frequency?:'monthly'|'hourly'|'daily';cutoff?:string}){
 const hourly=frequency==='hourly';
 const visible=geographyHistory(rows,{frequency,cutoff});
 return <div className="infra-history"><span>{hourly?'截至所选时点的 7 天':frequency==='daily'?'截至所选日期的 90 天':'截至所选月份的 24 个月'} · {unit}</span>{visible.length?<ResponsiveContainer width="100%" height={150}><LineChart data={visible} margin={{top:8,right:14,bottom:0,left:2}} accessibilityLayer><CartesianGrid vertical={false} stroke="#e3ebe6" strokeDasharray="3 4"/><XAxis dataKey="date" tickFormatter={value=>hourly?regionalDate(String(value),'hourly','Asia/Shanghai',true):String(value).slice(2,7)} minTickGap={45} tick={{fontSize:10,fill:'#72877e'}} axisLine={false} tickLine={false}/><YAxis width={48} domain={['auto','auto']} tickFormatter={value=>Number(value)>=10000?format(Number(value)/1000,0)+'k':format(Number(value),1)} tick={{fontSize:10,fill:'#72877e'}} axisLine={false} tickLine={false}/><Tooltip labelFormatter={value=>hourly?beijing(String(value)):String(value)} formatter={value=>[shortNumber(Number(value))+' '+unit,'观测']} contentStyle={{fontSize:12,borderRadius:8,border:'1px solid #dae6df'}}/><Line type="linear" dataKey="value" stroke={color} strokeWidth={2} dot={visible.length===1} connectNulls={false} isAnimationActive={false}/></LineChart></ResponsiveContainer>:<p>尚无历史观测。</p>}</div>;
}

function ProjectRecord({project,data}:{project:DataCenterProject;data:IndustryDataset}){
 const state=projectSourceStatus(project,data);
 return <details className="infra-project"><summary><span><b>{project.name}</b><small>{project.owner}{project.city?' · '+project.city:''}</small><small className="infra-capacity-preview">{projectCapacityPreview(project)}</small></span><span className={`infra-stage ${project.status}`}>{stages[project.status]??project.status}</span></summary><div>
  <ProjectCapacity project={project}/>
  <p>预计投运 {project.expectedOperationalAt??'未披露'} · 官方状态核验 {dateText(project.lastVerifiedAt)}</p><p>{state.label}{state.checkedAt?' · 检查 '+dateText(state.checkedAt):''}</p>{state.error&&<p className="infra-data-warning">最近官方来源检查未成功，保留历史项目记录。</p>}
  {project.statusHistory?.length?<ol className="infra-timeline">{project.statusHistory.map((event,index)=><li key={index}><b>{event.date}</b><span>{stages[event.status]??event.status}</span></li>)}</ol>:null}
  {project.notes&&<details><summary>官方项目记录</summary><p>{project.notes}</p></details>}<div className="infra-project-sources">{project.sourceUrls.map((url,index)=><a key={url} href={url} target="_blank" rel="noreferrer">官方来源 {project.sourceUrls.length>1?index+1:''}<ExternalLink size={12}/></a>)}</div>
 </div></details>;
}
