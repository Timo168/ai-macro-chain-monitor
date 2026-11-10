"use client";
import {useEffect,useId,useMemo,useRef,useState,type ReactNode} from 'react';
import {ChevronDown,ChevronLeft,ChevronRight,ChevronUp,ChartNoAxesCombined} from 'lucide-react';
import type {IndustryDataset,MetricDefinition} from '@/lib/industry/types';
import {ALL_ENTITIES,METRICS_PER_PAGE,entityLabel,metricAnchor,metricEntity,metricExplorerPreference,metricExplorerSummary,metricPage,metricSelectionHistory,resolveMetricExplorer} from '@/lib/industry/metric-explorer.mjs';
import {format} from '@/lib/data';
import {rememberReadingView} from '@/lib/reading-view.mjs';
import {revealPanel} from '../panel-disclosure';
import {useSavedView} from '../use-saved-view';
import './metric-explorer.css';

export type MetricExplorerProps={data:IndustryDataset;category:string;search:string;now:string;renderMetric:(definition:MetricDefinition)=>ReactNode;onClearSearch?:()=>void;onSelect?:(definition:MetricDefinition)=>void};
const booleanPreference=(value:unknown):value is boolean=>typeof value==='boolean';
const initialSelection={entity:ALL_ENTITIES,metricId:''};

export default function MetricExplorer({data,category,search,now,renderMetric,onClearSearch,onSelect}:MetricExplorerProps){
 const [saved,setSaved]=useSavedView('industry:explorer:'+category,initialSelection,metricExplorerPreference);
 const [detailOpen,setDetailOpen]=useSavedView('industry:explorer:'+category+':detail',true,booleanPreference);
 const [anchor,setAnchor]=useState(()=>typeof window==='undefined'?'':metricAnchor(location.hash));
 const [routeSequence,setRouteSequence]=useState(0);
 const pendingAnchor=useRef(anchor);
 const [page,setPage]=useState(0);
 const detailId='metric-explorer-detail-'+useId().replaceAll(':','');
 const view=useMemo(()=>resolveMetricExplorer(data.definitions,{category,search,...saved,anchorId:anchor}),[data.definitions,category,search,saved,anchor]);
 const pages=Math.max(1,Math.ceil(view.rows.length/METRICS_PER_PAGE));
 const safePage=Math.min(page,pages-1);
 const summaries=useMemo(()=>new Map(view.rows.map(definition=>[definition.id,metricExplorerSummary(definition,data.series[definition.id],now)])),[view.rows,data.series,now]);
 const selectedId=view.selected?.id??'';

 useEffect(()=>{
  const read=()=>{const id=metricAnchor(location.hash);pendingAnchor.current=id;setAnchor(id);setRouteSequence(sequence=>sequence+1);if(id)setDetailOpen(true);};
  read();window.addEventListener('hashchange',read);window.addEventListener('popstate',read);
  return()=>{window.removeEventListener('hashchange',read);window.removeEventListener('popstate',read);};
 },[category,setDetailOpen]);
 useEffect(()=>{
  setPage(metricPage(view.rows,selectedId));
  if(selectedId)revealPanel('industry:metric:'+selectedId);
  // Page changes alone must not jump back to the selected row.
 },[category,search,view.entity,selectedId]);
 useEffect(()=>{if(view.selected)onSelect?.(view.selected);},[selectedId,onSelect]);
 useEffect(()=>{
  if(!selectedId||pendingAnchor.current!==selectedId)return;
  const frame=requestAnimationFrame(()=>{document.getElementById(selectedId)?.scrollIntoView({block:'start'});pendingAnchor.current='';});
  return()=>cancelAnimationFrame(frame);
 },[selectedId,anchor,routeSequence]);
 // Store a resolved deep link only after its definition has arrived.
 useEffect(()=>{
  if(anchor&&view.selected?.id===anchor&&(saved.metricId!==anchor||saved.entity!==view.entity))setSaved({entity:view.entity,metricId:anchor});
 },[anchor,view.selected?.id,view.entity,saved.metricId,saved.entity,setSaved]);

 function writeSelection(definition:MetricDefinition|null,entity:string){
  const id=definition?.id??'';
  pendingAnchor.current='';
  if(id)revealPanel('industry:metric:'+id);
  setSaved({entity,metricId:id});setAnchor(id);setDetailOpen(true);
  for(const step of metricSelectionHistory(location.href,selectedId,id))history[step.method](history.state,'',step.url);
  rememberReadingView();
 }
 function selectEntity(entity:string){
  const next=resolveMetricExplorer(data.definitions,{category,search,entity,metricId:saved.metricId});
  writeSelection(next.selected,entity);setPage(0);
 }
 function clearFilters(){
  onClearSearch?.();
  const next=resolveMetricExplorer(data.definitions,{category,entity:ALL_ENTITIES});
  writeSelection(next.selected,ALL_ENTITIES);setPage(0);
 }

 return <section className="metric-explorer" aria-label="公司与指标浏览器">
  <div className="metric-explorer-heading"><div><h2>选指标，看趋势</h2><p>先选公司或实体，再点指标；每次只展开一张图。</p></div><label className="metric-explorer-entity">公司 / 实体<select value={view.entity} onChange={event=>selectEntity(event.target.value)}><option value={ALL_ENTITIES}>全部公司 / 实体</option>{view.entities.map(entity=><option key={entity} value={entity}>{entityLabel(entity)}</option>)}</select></label></div>
  <div className="metric-explorer-layout">
   <div className="metric-explorer-directory">
    <div className="metric-explorer-directory-title"><strong>指标速览</strong><span>{view.rows.length} 项{search.trim()?' · 搜索结果':''}</span></div>
    {view.rows.length===0?<div className="metric-explorer-empty"><p>{view.categoryCount?'没有符合当前筛选的指标。':'该环节尚未接入指标。'}</p>{view.categoryCount>0&&<button type="button" className="industry-button" onClick={clearFilters}>清除筛选</button>}</div>:<>
     <div className="metric-explorer-list" aria-label="选择要查看的指标">{view.rows.slice(safePage*METRICS_PER_PAGE,(safePage+1)*METRICS_PER_PAGE).map(definition=>{
      const summary=summaries.get(definition.id)!;const active=definition.id===selectedId;
      return <button type="button" className={'metric-explorer-row'+(active?' is-selected':'')} key={definition.id} aria-pressed={active} onClick={()=>writeSelection(definition,view.entity)}>
       <span className="metric-explorer-row-title"><span><small>{entityLabel(metricEntity(definition))}</small><strong>{definition.nameZh}</strong></span>{active&&<ChartNoAxesCombined size={16} aria-hidden="true"/>}</span>
       <span className="metric-explorer-row-number"><b>{format(summary.value)}</b><span>{summary.unit}</span></span>
       <span className="metric-explorer-row-meta"><span>{summary.yoyLabel} {summary.yoy==null?'—':`${summary.yoy>0?'↑ ':summary.yoy<0?'↓ ':'→ '}${format(Math.abs(summary.yoy))} ${summary.yoyUnit}`}</span><span>{summary.period??'暂无观测期'}</span></span>
       <span className={'metric-explorer-row-state'+(summary.warning?' is-warning':'')}>{summary.status}</span>
      </button>;
     })}</div>
     <div className="metric-explorer-pagination" aria-label="指标列表分页"><span>{safePage*METRICS_PER_PAGE+1}–{Math.min((safePage+1)*METRICS_PER_PAGE,view.rows.length)} / {view.rows.length}</span><div><button type="button" aria-label="上一页指标" disabled={safePage===0} onClick={()=>setPage(safePage-1)}><ChevronLeft size={15}/></button><span>{safePage+1} / {pages}</span><button type="button" aria-label="下一页指标" disabled={safePage+1>=pages} onClick={()=>setPage(safePage+1)}><ChevronRight size={15}/></button></div></div>
    </>}
   </div>
   <div className="metric-explorer-detail">
    {view.selected?<><div className="metric-explorer-detail-heading"><div><span>当前查看</span><strong>{entityLabel(metricEntity(view.selected))} · {view.selected.nameZh}</strong></div><button type="button" className="industry-button" aria-expanded={detailOpen} aria-controls={detailId} onClick={()=>setDetailOpen(!detailOpen)}>{detailOpen?<ChevronUp size={15}/>:<ChevronDown size={15}/>}<span>{detailOpen?'收起图表':'展开图表'}</span></button></div>
     {!detailOpen&&<p className="metric-explorer-collapsed">图表已收起，仍可在指标速览中查看最新数据。</p>}
     <div id={detailId} hidden={!detailOpen}>{renderMetric(view.selected)}</div>
    </>:<div className="metric-explorer-no-selection"><ChartNoAxesCombined size={26}/><p>选择一个指标，查看历史趋势与来源。</p></div>}
   </div>
  </div>
 </section>;
}
