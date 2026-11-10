"use client";

export function ResearchPending({topic,issue,onRules,onPlans}:{topic:'sectors'|'progress';issue?:string;onRules:()=>void;onPlans:()=>void}){
 return <section id={topic==='progress'?'research-progress':'research-conclusions'} className="industry-panel industry-research-pending" aria-label="研究数据等待状态">
  <div role="status" aria-live="polite"><span className="industry-tag">等待研究缓存更新</span><h3>{topic==='progress'?'跟踪、验证与估值正在准备':'各环节研究结论正在准备'}</h3><p>{issue||'正在读取与当前产业、宏观和政策数据版本一致的研究结果。'}</p><p className="industry-small">本区会在匹配的研究结果加载后显示。现有指标、企业计划与方向规则仍可查看。</p></div>
  <div className="industry-topic-picker"><button type="button" className="industry-button" onClick={onRules}>先看方向规则与历史</button><button type="button" className="industry-button" onClick={onPlans}>查看企业计划兑现</button></div>
 </section>;
}
