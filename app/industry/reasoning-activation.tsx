import type {IndustryResearch} from '@/lib/industry/types';
import {beijing} from '@/lib/data';
import {reasoningStatus} from './reasoning-status';
import './reasoning-activation.css';

export function ReasoningActivation({research}:{research:IndustryResearch}){
 const state=reasoningStatus(research),model=research.model;
 return <section className={'reasoning-activation '+(state.active?'active':'pending')} aria-label="推理模型启用进度">
  <div className="reasoning-activation-heading"><div><span>推理模型启用进度</span><h3>{state.title}</h3></div><span className="industry-tag">{state.active?'真实模型结果':'规则引擎运行中'}</span></div>
  <p>{state.explanation}</p>
  <dl className="reasoning-activation-metrics">
   <div><dt>{state.active?'实际返回模型':'预设模型 · 尚未代表已启用'}</dt><dd>{state.actualModel||model.model||'待配置'}</dd></div>
   <div><dt>真实成功调用</dt><dd>{state.successfulCalls} <small>次</small></dd></div>
   <div><dt>最近成功推理</dt><dd>{model.lastSuccessfulAt?beijing(model.lastSuccessfulAt):'尚无成功记录'}</dd></div>
  </dl>
  <p className="reasoning-activation-mode">{state.local?'运行方式：Ollama 本机推理，不产生外部 API 调用费；仍占用本机算力与电力。':`运行方式：${model.provider||'等待配置'}。`}{model.automaticEnabled===false?' 自动推理未开启；已有成功结果可继续查看。':model.automaticEnabled===true?' 后台自动推理已开启。':' 自动调用模式等待后台确认。'}</p>
  {state.local&&<p className="reasoning-activation-mode">本机推理需要电脑保持运行；线上展示最近发布的结果，并以上方成功时间为准。</p>}
  {state.diagnostic&&<div className="reasoning-activation-diagnostic"><strong>{state.diagnostic.reason}</strong><p>{state.diagnostic.action}</p>{model.retryable===true&&<small>可重试；实际执行受后台间隔和每日调用上限控制。</small>}{model.retryable===false&&model.status!=='not_configured'&&<small>需要管理员处理后再尝试。</small>}</div>}
  {!state.active&&<details className="reasoning-activation-setup" open={model.status==='not_configured'}><summary>本地推理启用步骤</summary><ol><li>准备本机模型服务，并选择本机硬件可运行的模型。</li><li>使用网站的实际研究数据运行一次推理，检查引用、正反证据和情景。</li><li>校验通过并发布结果后，页面才会标记真实推理已生成。</li></ol><small>本地推理无需外部 API 密钥。网页不会直接调用你的电脑；后台运行和结果发布需单独完成。</small></details>}
 </section>;
}
