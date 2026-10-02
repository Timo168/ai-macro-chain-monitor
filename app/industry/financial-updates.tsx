"use client";
import type {IndustryDataset} from '@/lib/industry/types';
import './financial-updates.css';
const labels:Record<string,string>={collected:'已接入',published_pending:'已发布 · 待采集',not_published:'尚未发布',cached:'检查失败 · 展示缓存',fetch_failed:'检查失败',not_configured:'未配置',unknown:'发布时间待确认'};
const sourceLabels:Record<string,string>={ready:'检查成功',partial_failure:'部分页面检查失败',cached:'检查失败 · 保留上次结果',fetch_failed:'检查失败',not_configured:'未配置'};
function time(value:string|null){if(!value)return '暂无记录';if(value.length===10)return value;const d=new Date(value);return Number.isNaN(d.valueOf())?'暂无记录':d.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});}
export function FinancialUpdates({data,compact=false}:{data:IndustryDataset;compact?:boolean}){
 const rows=data.financialUpdates??[];
 if(!rows.length)return null;
 const pending=rows.filter(row=>row.status==='published_pending').length;
 const collected=rows.filter(row=>row.status==='collected').length;
 const failed=rows.filter(row=>['cached','fetch_failed','partial_failure'].includes(row.sourceStatus)).length;
 const table=<div className="industry-table-wrap"><table className="financial-update-table"><thead><tr><th>公司 / 最新官方财报</th><th>接入进度</th><th>图表实际观测期</th><th>官方列表检查</th></tr></thead><tbody>{rows.map(row=><tr key={row.entity}>
  <td><strong>{row.entity}</strong>{row.release?<><a href={row.release.url} target="_blank" rel="noreferrer">FY{row.release.fiscalYear} Q{row.release.quarter} ↗</a><small>官方发布 {row.release.publishedAt?.slice(0,10)??'未提供'}</small></>:<small>尚无已核验最新财报</small>}{row.upcoming&&<small><a href={row.upcoming.url} target="_blank" rel="noreferrer">下次发布 {time(row.upcoming.releaseAt??row.upcoming.publishedAt??null)} ↗</a></small>}</td>
  <td><span className={`financial-update-badge ${row.status}`}>{labels[row.status]??row.status}</span>{row.ingestedPeriodEnd&&<small>本报告已解析至 {row.ingestedPeriodEnd}</small>}{row.note&&<small>{row.note}</small>}</td>
  <td>{row.latestObservationAt??'尚无观测'}<small>{row.dataStatus==='cached'?'保留已核验缓存':row.dataStatus==='ready'?'已核验历史':'尚待接入'}</small>{row.release&&<small>本季覆盖 {row.currentMetricIds?.length??0}/{(row.currentMetricIds?.length??0)+(row.pendingMetricIds?.length??0)} 项已跟踪指标</small>}{!!row.pendingMetricIds?.length&&<details><summary>哪些图表仍待本季数据</summary><p>{row.pendingMetricIds.map(id=>data.definitions.find(def=>def.id===id)?.nameZh??id).join('、')}</p></details>}</td>
  <td><span>{sourceLabels[row.sourceStatus]??row.sourceStatus}</span><small>检查 {time(row.checkedAt)}</small><small>最近成功 {time(row.lastSuccessfulAt)}</small>{row.sourceUrl&&<a href={row.sourceUrl} target="_blank" rel="noreferrer">官方发布列表 ↗</a>}{row.error&&<details><summary>查看原因</summary><p>{row.error}</p></details>}</td>
 </tr>)}</tbody></table></div>;
 return <section className="industry-panel financial-updates" aria-label="公司财报更新进度"><div className="industry-section-title"><div><h3>公司财报更新进度</h3><p>先确认官方发布，再核验财季和数值；通过后同步更新图表与研究结论。后台每小时检查，已发布待采集的报告会重试。</p></div><span className="industry-tag">北京时间</span></div><div className="financial-update-summary"><span><b>{collected}</b> 家最新财报已接入</span><span><b>{pending}</b> 家已发布待采集</span><span><b>{failed}</b> 家官方列表检查失败</span></div>{compact?<details><summary>查看各公司的更新进度与来源</summary>{table}</details>:table}<p className="industry-small">部分公司不同指标的覆盖范围不同，最新财报已接入不代表所有指标均已披露。来源检查失败时，无法确认有无新报告；页面保留已有数据。</p></section>;
}
