"use client";
import type {IndustryDataset,IndustryResearch,ResearchSectorSignal} from '@/lib/industry/types';
import './research-sources.css';

const natureLabel={actual:'实际观测',estimate:'机构估算',forecast:'机构预测'};
const stateLabel:Record<string,string>={ready:'已接入',cached:'获取失败 · 展示缓存',fetch_failed:'获取失败',authorization_required:'需取得授权',not_configured:'未配置',no_observation:'尚未发布',pending:'待接入'};
const stages:Record<string,string>={formal_research:'正式因子研究',leading_research:'先行研究',scenario_only:'情景观察',needs_evidence:'等待关键证据'};
const factors:Record<string,string>={investment:'投资投入',demand:'实际需求',construction:'建设进度',profitability:'盈利兑现',costs:'成本与约束'};

export function ReadinessDetail({signal}:{signal:ResearchSectorSignal|undefined}){
 const readiness=signal?.readiness;if(!readiness)return null;
 return <details className="research-readiness"><summary>结论落地检查 · {stages[readiness.stage]??readiness.stage} · {readiness.blockers.length} 项待解决</summary>
  <p>独立需求主体 {readiness.directDemandEntityCount}/{readiness.requiredDemandEntityCount}；{readiness.nextReviewAt?`最早重新核验日 ${readiness.nextReviewAt}`:'重新核验时间等待来源发布'}</p>
  {readiness.blockers.length?<ul>{readiness.blockers.map((blocker,index)=><li key={`${blocker.code}-${blocker.factorId}-${index}`}><b>{factors[blocker.factorId??'']??'综合条件'}</b><span>{blocker.remedy}</span>{blocker.metricIds.length>0&&<small>涉及 {blocker.metricIds.join('、')}</small>}</li>)}</ul>:<p>当前已通过直接证据和可比历史门槛。投资表现仍需要单独的回测验证。</p>}
 </details>;
}

export function ResearchDeliveryStatus({research}:{research:IndustryResearch}){
 const signals=research.quantitative.sectorSignals;
 const formal=signals.filter(signal=>signal.score!=null&&signal.researchScope!=='company_operating_sample').length;
 const samples=signals.filter(signal=>signal.score!=null&&signal.researchScope==='company_operating_sample').length;
 const leading=signals.filter(signal=>signal.score==null&&signal.leadingSignal?.status==='available').length;
 const modelActive=['ready','cached'].includes(research.model.status)&&research.analysis.origin==='model';
 return <div className="research-delivery-status" aria-label="研究可用性与投资验证状态">
  <article><span>研究可用性</span><b>{formal} 个产业目标 · {samples} 个公司经营样本可评分 · {leading} 个可先行跟踪</b><small>点开每个环节的“结论落地检查”，查看原因与补齐路径。</small></article>
  <article><span>外部推理模型</span><b>{modelActive?'已启用':'尚未启用'}</b><small>{modelActive?`${research.model.model} · 输入版本已绑定`:research.model.status==='not_configured'?'服务端尚未配置 API 密钥；当前使用确定性因子引擎。':'本次调用未成功；状态与错误保留在审计信息中。'}</small></article>
  <article><span>投资效果验证</span><b>尚未完成回测</b><small>评分尚未经过样本外收益、回撤、估值和交易成本检验。</small></article>
 </div>;
}

export function InstitutionalSources({data,showMetric,compact=false}:{data:IndustryDataset;showMetric?:(id:string)=>void;compact?:boolean}){
 const reports=data.researchReports??[],catalog=data.sourceCatalog??[];
 if(!reports.length&&!catalog.length)return null;
 const cso=data.definitions.find(def=>def.id==='CSO.datacenter_electricity');
 return <section className="industry-panel institutional-sources" aria-label="权威研究与数据来源">
  <div className="industry-section-title"><div><h3>权威研究与数据来源</h3><p>按数字性质和适用范围使用报告：实际、估算、预测分别保留；机构名称本身不提高评分。</p></div><span className="industry-tag">来源可追溯</span></div>
  {cso&&<button className="industry-text-button" onClick={()=>showMetric?.(cso.id)}>查看爱尔兰数据中心实际用电图表 ↗</button>}
  <div className="institutional-report-grid">{reports.map(report=><article key={report.id}>
   <div><span>{report.publisher}</span><b>{stateLabel[report.status]??report.status}</b></div>
   <h4><a href={report.sourceUrl} target="_blank" rel="noreferrer">{report.title} ↗</a></h4>
   <p>{report.scope}</p><small>来源发布 {report.publishedAt?.slice(0,10)??'未提供'} · {report.modelRole==='scenario_only'?'仅作为情景背景，不进入正式评分':'区域背景，不代表全球 AI 需求'}</small>
   <dl>{report.facts.map((fact,index)=><div key={`${fact.period}-${index}`}><dt>{fact.period} · {natureLabel[fact.nature]}</dt><dd>{fact.value==null?'未发布':fact.value.toLocaleString()} {report.unit}</dd></div>)}</dl>
   <details><summary>方法、版本与许可</summary><p>{report.methodology}</p><p>{report.licenseNote}</p><small>来源版本 {report.version?.slice(0,16)||'暂无'} · 最近成功获取 {report.fetchedAt?.slice(0,10)||'尚无成功记录'}</small><p><a href={report.licenseUrl} target="_blank" rel="noreferrer">使用许可 ↗</a></p>{report.error&&<p>{report.error}</p>}</details>
  </article>)}</div>
  {catalog.length>0&&<details className="institutional-catalog" open={!compact}><summary>来源接入清单 · {catalog.filter(source=>source.status==='authorization_required').length} 个来源需授权</summary><p>以下清单保留接入方向与当前原因。未获相应用途授权的报告不自动抓取、不送入推理模型、不提供 CSV。</p><div className="industry-table-wrap"><table><thead><tr><th>机构 / 数据</th><th>可补充什么</th><th>当前状态与原因</th></tr></thead><tbody>{catalog.map(source=><tr key={source.id}><td><a href={source.sourceUrl} target="_blank" rel="noreferrer">{source.publisher} ↗</a><small>{source.title}</small></td><td>{source.purpose}</td><td>{stateLabel[source.status]??source.status}<small>{source.reason}</small><a href={source.licenseUrl} target="_blank" rel="noreferrer">许可说明 ↗</a></td></tr>)}</tbody></table></div></details>}
 </section>;
}
