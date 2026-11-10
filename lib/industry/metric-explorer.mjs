import {metricStats} from './engine.mjs';

export const ALL_ENTITIES='__all__';
export const OTHER_ENTITY='__other__';
export const METRICS_PER_PAGE=6;
export const metricEntity=definition=>definition.entity||OTHER_ENTITY;
export const entityLabel=entity=>entity===ALL_ENTITIES?'全部公司 / 实体':entity===OTHER_ENTITY?'行业公开指标':entity;
export function metricAnchor(hash){
 try{return decodeURIComponent(String(hash??'').replace(/^#/,''));}catch{return '';}
}
export function metricExplorerPreference(value){
 return !!value&&typeof value==='object'&&typeof value.entity==='string'&&value.entity.length<=200&&typeof value.metricId==='string'&&value.metricId.length<=300;
}
/** Registry order stays stable. Numeric changes never move a row or a company. */
export function resolveMetricExplorer(definitions,{category,search='',entity=ALL_ENTITIES,metricId='',anchorId=''}={}){
 const categoryRows=definitions.filter(definition=>definition.category===category);
 const entities=[...new Set(categoryRows.map(metricEntity))];
 const query=search.trim().toLocaleLowerCase();
 const searched=categoryRows.filter(definition=>`${definition.id} ${definition.entity??''} ${definition.nameZh} ${definition.nameEn}`.toLocaleLowerCase().includes(query));
 const anchor=searched.find(definition=>definition.id===anchorId);
 let selectedEntity=entity===ALL_ENTITIES||entities.includes(entity)?entity:ALL_ENTITIES;
 if(anchor&&selectedEntity!==ALL_ENTITIES&&metricEntity(anchor)!==selectedEntity)selectedEntity=metricEntity(anchor);
 const rows=searched.filter(definition=>selectedEntity===ALL_ENTITIES||metricEntity(definition)===selectedEntity);
 const selected=rows.find(definition=>definition.id===anchor?.id)??rows.find(definition=>definition.id===metricId)??rows[0]??null;
 return {entities,categoryCount:categoryRows.length,entity:selectedEntity,rows,selected};
}
export function metricPage(rows,id,pageSize=METRICS_PER_PAGE){
 return Math.floor(Math.max(0,rows.findIndex(row=>row.id===id))/pageSize);
}
export function metricSelectionUrl(href,id){
 const url=new URL(href,'https://local.invalid');
 url.hash=id?encodeURIComponent(id):'';
 return url.pathname+url.search+url.hash;
}
/** Capture an implicit initial selection before adding the next history entry. */
export function metricSelectionHistory(href,currentId,nextId){
 const url=new URL(href,'https://local.invalid');
 let current=url.pathname+url.search+url.hash;
 const steps=[];
 if(!url.hash&&currentId){
  current=metricSelectionUrl(href,currentId);
  steps.push({method:'replaceState',url:current});
 }
 const next=metricSelectionUrl(href,nextId);
 if(next!==current)steps.push({method:'pushState',url:next});
 return steps;
}
const statuses={ready:'已获取',reviewed:'官方核验',cached:'展示缓存',fetch_failed:'获取失败',pending:'待接入',not_configured:'未配置来源',authorization_required:'待授权',no_observation:'暂无观测'};
export function metricExplorerSummary(definition,series,now){
 const stats=metricStats(definition,series?.observations??[],now);
 const value=Number.isFinite(stats.latest?.value)?stats.latest.value:null;
 const rate=['cloud_growth','capex_growth','semiconductor_growth'].includes(definition.family);
 const yoyUnit=definition.unit==='%'&&!rate?'个百分点':'%';
 let status=series?.status==='cached'&&series.error?'获取失败 · 展示缓存':statuses[series?.status??'pending']??'待核验';
 if(value===null&&['ready','reviewed','cached'].includes(series?.status))status+=' · 最新期缺值';
 if(value!==null&&stats.freshness==='stale')status+=' · 超过更新周期';
 return {value,unit:definition.unit,yoy:stats.yoy,yoyUnit,yoyLabel:rate?'披露同比':'同比',period:stats.latest?.periodEnd??null,fiscalPeriod:stats.latest?.fiscalPeriod??null,status,warning:value===null||stats.freshness==='stale'||!['ready','reviewed'].includes(series?.status),sourceName:definition.sourceName,sourceUrl:definition.sourceUrl,lastSuccessAt:series?.lastSuccessfulAt??series?.fetchedAt??null};
}
