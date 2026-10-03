"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import {useMemo,useState} from 'react';
import type {IndustryResearch} from '@/lib/industry/types';
import {beijing,format} from '@/lib/data';
import './research-progress.css';

const score=(value:number|null|undefined)=>value==null?'—':`${value>0?'+':''}${format(value)}`;
const percent=(value:number|null|undefined)=>value==null?'—':`${score(value)}%`;
const tier=(value:string)=>({formal:'正式研究分',leading:'先行观察分',unavailable:'暂无有效分数'}[value]??'尚无记录');
const changeLabels:Record<string,string>={new_evidence:'新增证据',new_report:'新报告期',revision:'历史修订',expired:'数据过期',freshness_recovered:'恢复有效',source_state:'来源状态变化',removed:'配置移除'};
const level:Record<string,string>={positive_allocation:'积极配置',gradual_attention:'分批关注',neutral_hold:'中性持有',cautious_watch:'谨慎观望',reduce_exposure:'降低暴露',insufficient_data:'证据待验证'};
const windowLabels:Record<string,string>={matured:'已期满',pending:'等待期满',awaiting_entry:'等待完整交易日',missing_prices:'缺少行情',price_gap:'行情有空档'};
const fieldNames:Record<string,string>={revenue:'TTM收入',netIncome:'TTM净利润',operatingCashFlow:'TTM营业现金流',capex:'TTM现金资本开支',cash:'现金及短期投资',debt:'总债务',longTermDebt:'长期借款（非总债务）',shares:'普通股股数'};

export function ResearchProgress({research,showMetric}:{research:IndustryResearch|null;showMetric:(id:string)=>void}){
 const current=research as any;const [section,setSection]=useState('changes'),[horizon,setHorizon]=useState(1),[entity,setEntity]=useState('MSFT'),[priceInput,setPriceInput]=useState(''),[capInput,setCapInput]=useState('');
 const changes=current?.changes,tracking=current?.followup,valuation=current?.valuation;
 const company=valuation?.companies?.find((row:any)=>row.entity===entity);
 const manual=useMemo(()=>{
  if(!company)return null;const p=priceInput?Number(priceInput):null,c=capInput?Number(capInput)*1e8:null;
  const inputValid=(p==null||Number.isFinite(p)&&p>0)&&(c==null||Number.isFinite(c)&&c>0);
  if(!inputValid)return {error:'请输入大于零的有效数值。'};
  const cap=c??(p&&company.marketCap&&company.price?company.marketCap*p/company.price:null);
  if(!p&&!c)return null;
  return {marketCap:cap,pe:cap&&company.netIncome>0?cap/company.netIncome:null,ps:cap&&company.revenue>0?cap/company.revenue:null,fcfYield:cap&&company.freeCashFlow!=null?company.freeCashFlow/cap*100:null};
 },[company,priceInput,capInput]);
 if(!research)return null;
 return <section className="industry-panel research-progress" aria-label="研究变化、模拟跟踪与公司估值">
  <div className="research-progress-title"><div><span className="industry-kicker">RESEARCH FOLLOW-UP</span><h2>把研究结论接到实际观察</h2><p>看变化的依据，再跟踪后续表现，最后核对增长与价格。</p></div><span className="industry-tag">真实存档 · 日频参考</span></div>
  <nav className="research-progress-tabs" aria-label="研究验证导航">{[['changes','结论为什么变了'],['tracking','模拟跟踪'],['valuation','公司估值']].map(([id,name])=><button key={id} onClick={()=>setSection(id)} aria-pressed={section===id}>{name}</button>)}</nav>
  {section==='changes'&&<div>
   <h3>上一版 → 本版</h3><p className="research-progress-note">{changes?.summary??'等待新版本生成对比。'}</p>
   {changes?.previousAt&&<p className="industry-small">上一版保存 {beijing(changes.previousAt)} · 本版保存 {beijing(changes.currentAt)}（北京时间）</p>}
   <div className="research-progress-grid">{(changes?.sectors??[]).map((row:any)=><article key={row.targetId} className="research-change-card">
    <h4>{row.targetName}<span>{row.delta!=null&&row.delta!==0||row.previousTier!==row.currentTier||row.previousStance!==row.currentStance||row.ruleChanged?'结论变化':row.changed||row.evidence.length?'证据更新，结论不变':'保持不变'}</span></h4>
    <div className="research-change-score"><div><small>{tier(row.previousTier)}</small><strong>{score(row.previousScore)}</strong></div><span>→</span><div><small>{tier(row.currentTier)}</small><strong>{score(row.currentScore)}</strong></div><b>{row.delta==null?(row.ruleChanged?'规则变化，不直接相减':row.previousTier!==row.currentTier?'层级变化，不直接相减':'—'):`变化 ${score(row.delta)} 分`}</b></div>
    <p>{row.previousTier==='leading'&&row.previousStance==='insufficient_data'?'先行研究':level[row.previousStance]??'首份记录'} → {row.currentTier==='leading'&&row.currentStance==='insufficient_data'?'先行研究':level[row.currentStance]??row.currentStance}</p><p className="research-progress-note">{row.reasons.join('；')}。</p>
    {(row.changed||row.evidence.length>0)&&<details><summary>查看分数变化与对应证据</summary><ul>{row.factors.filter((f:any)=>f.delta!=null&&f.delta!==0).map((factor:any)=><li key={factor.id}>{factor.name}：{score(factor.previous)} → {score(factor.current)}（{score(factor.delta)} 分）</li>)}{row.macroDelta!=null&&<li>宏观调整：{score(row.macroDelta)} 分</li>}{row.residualDelta!=null&&row.residualDelta!==0&&<li>覆盖缩减、冲突调整、边界与取整的剩余影响：{score(row.residualDelta)} 分</li>}</ul>{row.evidence.length===0?<p className="industry-small">没有新增财报数值，变化来自规则、宏观或历史标准化。</p>:row.evidence.map((e:any)=><div key={e.metricId} className="research-change-evidence"><button onClick={()=>showMetric(e.metricId)}>{e.name} ↗</button><span>{changeLabels[e.kind]} · {e.previousPeriod??'—'} {format(e.previousValue)} → {e.currentPeriod??'—'} {format(e.currentValue)} {e.unit}</span>{e.sourceUrl&&<a href={e.sourceUrl} target="_blank" rel="noreferrer">原始来源 ↗</a>}{e.reason&&<small>{e.reason}</small>}</div>)}</details>}
   </article>)}</div><p className="industry-small">{changes?.note}</p>
  </div>}
  {section==='tracking'&&<div>
   <h3>结论发布后的 1、3、6 个月</h3><p className="research-progress-note">{tracking?.method??'等待实际结论快照及行情。'}</p>
   <div className="research-horizon-cards">{(tracking?.byHorizon??[]).map((row:any)=><button key={row.months} onClick={()=>setHorizon(row.months)} aria-pressed={horizon===row.months}><span>{row.months} 个月</span><strong>{row.maturedCount} 个已期满样本</strong><small>{row.maturedCount?`平均扣费收益 ${percent(row.meanNetReturn)} · 超额 ${percent(row.meanExcessReturn)}`:'尚无期满数据，不计算胜率或收益'}</small></button>)}</div>
   <p className="research-table-hint">表格可左右滑动查看全部指标。</p><div className="research-progress-table"><table><thead><tr><th>存档结论 / 样本篮子</th><th>信号</th><th>进度</th><th>扣费收益</th><th>基准扣费收益</th><th>超额收益</th><th>最大回撤</th></tr></thead><tbody>{(tracking?.cohorts??[]).slice().reverse().map((row:any)=>{const window=row.windows.find((w:any)=>w.months===horizon);return <tr key={row.id}><td><b>{row.targetName}</b><small>{beijing(row.recordedAt)}</small><details><summary>固定样本与存档</summary><small>{row.symbols.join(' · ')}<br/>基准 {row.benchmark}<br/>输入版本 {row.inputHash.slice(0,16)}</small></details></td><td>{tier(row.tier)}<br/>{score(row.score)} /100</td><td>{windowLabels[window?.status]??'等待数据'}<small>{window?.entryAt&&`入场 ${window.entryAt}`}{window?.maturityAt&&` · 到期 ${window.maturityAt}`}</small>{window?.reason&&<small>{window.reason}</small>}</td><td>{percent(window?.netReturn)}</td><td>{percent(window?.benchmarkNetReturn)}</td><td>{percent(window?.excessReturn)}</td><td>{percent(window?.maxDrawdown)}</td></tr>})}</tbody></table></div>
   {!tracking?.cohorts?.length&&<p>当前尚无可跟踪的有效研究分数，后续有效快照会自动进入。</p>}
   <details className="research-progress-disclosure"><summary>跟踪方法、样本限制与历史版本</summary><ul>{tracking?.limitations?.map((note:string)=><li key={note}>{note}</li>)}</ul><p>ALFRED 历史版本：{({ready:'已保存官方历史版本',cached:'保留上次版本',not_configured:'未配置',fetch_failed:'获取失败'} as Record<string,string>)[tracking?.vintageArchive?.status]??'等待检查'}。{tracking?.vintageArchive?.note}</p><a href="https://fred.stlouisfed.org/docs/api/fred/realtime_period.html" target="_blank" rel="noreferrer">ALFRED 官方历史版本说明 ↗</a></details>
  </div>}
  {section==='valuation'&&<div>
   <h3>增长有多好，价格反映了多少</h3><p className="research-progress-note">{valuation?.method??'等待估值数据。'}</p>
   <p className="research-table-hint">表格可左右滑动查看全部指标。</p><div className="research-progress-table"><table><thead><tr><th>公司 / 日期</th><th>股价 USD</th><th>估算市值 亿USD</th><th>TTM P/E</th><th>TTM P/S</th><th>FCF收益率</th><th>季度收入同比</th><th>可比情况</th></tr></thead><tbody>{valuation?.companies?.map((row:any)=><tr key={row.entity} className={row.entity===entity?'selected':''}><td><button onClick={()=>{setEntity(row.entity);setPriceInput('');setCapInput('')}}>{row.entity}</button><small>行情 {row.priceAt??'缺失'}<br/>TTM {row.ttmEnd??'待核验'}</small></td><td>{format(row.price)}</td><td>{row.marketCap==null?'—':format(row.marketCap/1e8)}</td><td>{row.pe==null?'不适用 / 缺项':format(row.pe)+' 倍'}</td><td>{row.ps==null?'—':format(row.ps)+' 倍'}</td><td>{percent(row.fcfYield)}</td><td>{percent(row.revenueGrowth)}</td><td><small>{row.peerGroup} · {row.peerComparison}<br/>{row.status==='available'?'可用估值字段已计算':'有缺项或口径需核验'}</small></td></tr>)}</tbody></table></div>
   {company&&<article className="research-company-detail"><div className="research-company-header"><h4>{company.entity} · 估值与现金流核对</h4>{company.sourceUrl&&<a href={company.sourceUrl} target="_blank" rel="noreferrer">行情来源 ↗</a>}</div><p>{company.summary??company.reasons?.join('；')}</p><p className="industry-small">行情状态：{company.priceStatus==='cached'?'使用缓存':company.priceStatus==='ready'?'已获取':'需核验'} · 成功获取 {beijing(company.priceFetchedAt)} · 市值口径：{company.marketCapBasis??'ADR口径待核验'}</p><div className="research-company-facts"><span>{company.cashScope==='cash_only'?'现金（未含短期投资）':'现金及短期投资'} <b>{company.cash==null?'—':format(company.cash/1e8)+' 亿USD'}</b></span><span>总债务 <b>{company.debt==null?'—':format(company.debt/1e8)+' 亿USD'}</b></span><span>净债务 <b>{company.netDebt==null?'—':format(company.netDebt/1e8)+' 亿USD'}</b></span><span>企业价值估算 <b>{company.ev==null?'—':format(company.ev/1e8)+' 亿USD'}</b></span></div>
    <details><summary>逐项来源、口径与缺项原因</summary><ul>{company.reasons?.map((reason:string)=><li key={reason}>{reason}</li>)}</ul>{company.sourceError&&<p className="industry-small">来源检查：{company.sourceError}。当前补充字段的实际来源逐项列出。</p>}<div className="research-progress-table"><table><thead><tr><th>字段</th><th>值 / 单位</th><th>报告期</th><th>来源</th></tr></thead><tbody>{Object.entries(company.fields??{}).map(([key,value])=>{const field=value as any;return <tr key={key}><td>{key==='cash'&&field.scope==='cash_only'?'现金（未含短期投资）':fieldNames[key]??key}</td><td>{field.unit==='shares'?format(field.value/1e8)+' 亿股':format(field.value/1e8)+' 亿'+(field.currency??'未知币种')}</td><td>{field.periodEnd}</td><td><a href={field.sourceUrl} target="_blank" rel="noreferrer">{field.basis==='third_party_transcription'?'第三方财务转录':'官方披露 / 计算'} ↗</a><small>发布 {field.publishedAt??'来源未提供'} · 获取 {beijing(field.fetchedAt)}{field.sourceStatus==='cached'?' · 使用缓存':''}</small></td></tr>})}</tbody></table></div></details>
    <details className="research-progress-disclosure"><summary>用你看到的最新价格做本机试算</summary><p>输入不写入后台，也不修改研究评分。估值仍受财务字段是否齐全限制。</p><div className="research-manual-controls"><label>价格（USD）<input type="number" min="0" value={priceInput} onChange={e=>setPriceInput(e.target.value)} placeholder="沿用后台收盘价"/></label><label>市值（亿USD，可选）<input type="number" min="0" value={capInput} onChange={e=>setCapInput(e.target.value)} placeholder="缺股数时可输入"/></label><button onClick={()=>{setPriceInput('');setCapInput('')}}>清除试算</button></div>{manual&&('error' in manual?<p>{manual.error}</p>:<p>本机输入试算：P/E {manual.pe==null?'不适用 / 缺项':format(manual.pe)+' 倍'} · P/S {manual.ps==null?'—':format(manual.ps)+' 倍'} · FCF收益率 {percent(manual.fcfYield)}。输入时间口径为当前用户试算，不属于已核验行情。</p>)}</details>
   </article>}
   <p className="industry-small">{valuation?.note} 日频价格可能延迟；股数与总债务的披露时点可能早于价格日。TSM 为 ADR，未核验币种和兑换比例时不混算估值。</p>
  </div>}
 </section>;
}
