import type {DataCenterProject} from '@/lib/industry/types';
import {CAPACITY_KIND_LABELS,selectProjectCapacityEstimate,selectProjectCapacityRange} from '@/lib/industry/geography.mjs';
import {beijing,format} from '@/lib/data';
import './project-capacity.css';

const states:Record<string,string>={ready:'已核验',cached:'展示缓存',fetch_failed:'获取失败',not_published:'尚未披露',not_configured:'未配置'};
const dateText=(value?:string|null)=>value?(value.length<=10?value:beijing(value)):'未注明';
const amount=(value:number)=>format(value,Number.isInteger(value)?0:1);

export function projectCapacityPreview(project:DataCenterProject){
 const estimate=selectProjectCapacityEstimate(project,{scope:'current'});
 if(estimate&&['operational','partially_operational'].includes(project.status))return `约 ${amount(estimate.valueMw!)} MW · 机构估算 AI IT 容量`;
 if(typeof project.powerCapacityMw==='number')return `${amount(project.powerCapacityMw)} MW · 官方披露`;
 const facility=selectProjectCapacityEstimate(project,{scope:'current',capacityKind:'facility_power'});
 if(facility)return `约 ${amount(facility.valueMw)} MW · 机构估算设施容量`;
 const range=selectProjectCapacityRange(project);
 if(range)return `低于 ${amount(range.upperBoundMw!)} MW · 机构估算范围`;
 const planned=selectProjectCapacityEstimate(project,{scope:'planned'});
 return planned?`约 ${amount(planned.valueMw!)} MW · 机构规划估算`:'容量待补充';
}

export default function ProjectCapacity({project}:{project:DataCenterProject}){
 const official=(project.capacityEvidence??[]).filter(item=>item.sourceType==='official');
 const current=selectProjectCapacityEstimate(project,{scope:'current'});
 const planned=selectProjectCapacityEstimate(project,{scope:'planned'});
 const facility=selectProjectCapacityEstimate(project,{scope:'current',capacityKind:'facility_power'});
 const futureFacility=selectProjectCapacityEstimate(project,{scope:'planned',capacityKind:'facility_power'});
 const estimates=[current,planned,facility,futureFacility].filter((item):item is NonNullable<typeof item>=>item!=null);
 const range=selectProjectCapacityRange(project);
 const ranges=range?[range]:[];
 const unavailable=(project.capacityEvidence??[]).filter(item=>item.sourceType==='institutional_estimate'&&!estimates.some(selected=>selected.id===item.id)&&!['ready','cached'].includes(item.status));
 const records=[...official,...estimates,...ranges];
 const officialEvent=[...(project.statusHistory??[])].reverse().find(event=>event.capacityMw===project.powerCapacityMw&&event.capacityKind===project.capacityKind);
 return <div className="project-capacity" aria-label={`${project.name}容量与来源`}>
  {!official.length&&<div className="capacity-fact official"><header><span>官方披露</span><b>{typeof project.powerCapacityMw==='number'?`${amount(project.powerCapacityMw)} MW`:'容量尚未披露'}</b></header>{typeof project.powerCapacityMw==='number'&&<p>{CAPACITY_KIND_LABELS[project.capacityKind??'unspecified_project_capacity']??project.capacityKind} · 披露日期 {officialEvent?.date??'未注明'}</p>}</div>}
  {records.map((item,index)=><div className={`capacity-fact ${item.sourceType==='official'?'official':'estimate'}`} key={item.id+'-'+index}>
   <header><span>{item.sourceType==='official'?'官方披露':'机构估算'}{item.scope==='planned'?' · 规划规模':''}</span><b>{typeof item.valueMw==='number'?`${item.sourceType==='institutional_estimate'?'约 ':''}${amount(item.valueMw)} MW`:item.valueQualifier==='less_than'&&typeof item.upperBoundMw==='number'?`低于 ${amount(item.upperBoundMw)} MW`:'—'}</b></header>
   <p>{CAPACITY_KIND_LABELS[item.capacityKind]??item.capacityKind} · 数据截至 {dateText(item.asOfDate)}{item.scope==='planned'&&item.targetDate?' · 目标 '+item.targetDate:''}</p>
   {item.coverageScope&&<p>{item.coverageScope}</p>}
   <div className="capacity-citation"><a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceName} ↗</a><span>{states[item.status]??item.status}</span></div>
   <p className="capacity-date">来源更新 {dateText(item.publishedAt)} · 最近成功获取 {dateText(item.lastSuccessfulAt??item.fetchedAt)}</p>
   {(item.method||item.note||item.error||item.methodologyUrl)&&<details><summary>{item.sourceType==='official'?'查看披露口径与记录':'查看估算方法与记录'}</summary>{item.method&&<p>{item.method}</p>}{item.note&&<p>{item.note}</p>}{item.error&&<p>{item.status==='cached'?'本次获取未成功，保留最近成功记录。':'本次获取失败，暂无成功记录。'}</p>}{item.methodologyUrl&&<a href={item.methodologyUrl} target="_blank" rel="noreferrer">方法说明 ↗</a>}{item.license&&<p>{item.license}</p>}<p>本次检查 {dateText(item.checkedAt)}{item.version?' · 版本 '+item.version.slice(0,10):''}</p></details>}
  </div>)}
  {unavailable.length>0&&<details className="capacity-unavailable"><summary>其他容量口径与获取状态 · {unavailable.length} 项</summary>{unavailable.map(item=><p key={item.id}>{CAPACITY_KIND_LABELS[item.capacityKind]??item.capacityKind} · {item.scope==='planned'?'未来规划':'当前容量'} · {states[item.status]??item.status}<br/><a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceName} ↗</a> · 检查 {dateText(item.checkedAt)}{item.note&&<small>{item.note}</small>}</p>)}</details>}
  {!estimates.length&&!ranges.length&&project.capacityAudit?.note&&<p className="capacity-audit">{project.capacityAudit.note}<small>核查 {dateText(project.capacityAudit.checkedAt)}</small></p>}
 </div>;
}
