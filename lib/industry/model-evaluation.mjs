import {validateModelAnalysis} from './research.mjs';
import {citationAudit} from './model-runtime.mjs';

export const MODEL_EVALUATION_VERSION='research-evaluation-1.0.0';
export function evaluateResearchAnswer(answer,packet){
 let accepted=false,error=null;
 const citations=citationAudit(answer,packet);
 try{validateModelAnalysis(answer,packet,{requireScenarios:true});accepted=citations.invalid===0;}catch(e){error=String(e.message);}
 const expected=packet.quantitative.sectorSignals.length;
 const views=answer?.sectorViews??[];
 return {accepted,error,citations,sectorCoverage:expected?new Set(views.map(v=>v.targetId)).size/expected:null,contraryCaseCoverage:expected?views.filter(v=>typeof v.contraryCase==='string'&&v.contraryCase.trim()).length/expected:null,scenarioCoverage:expected?views.filter(v=>v.scenarios?.length===3&&new Set(v.scenarios.map(s=>s.name)).size===3).length/expected:null,semanticReview:'pending_human_review',meaning:'自动评测检查引用版本、必要字段及证据边界；解释是否充分、是否遗漏重要反证仍需人工复核。'};
}

// Synthetic cases test our validator, never the quality of an uncalled model.
export function modelEvaluationCases(){
 const ref={metricId:'SAMPLE.revenue',observationVersion:'synthetic-v1',periodEnd:'2026-06-30'};
 const signal={targetId:'overall',stance:'gradual_attention',confidence:'medium',evidenceRefs:[ref],missingMetrics:[]};
 const packet={quantitative:{overall:signal,sectorSignals:[signal]},contextRefs:[],marketRegime:'mixed_evidence',fullSiteContext:{industryMetrics:[],industryEvents:[]},institutionalReports:[]};
 const answer={overallStance:signal.stance,marketRegime:packet.marketRegime,confidence:'medium',summary:'投入和需求出现正面证据，仍需核对盈利兑现。',limitations:['合成验收题，不代表真实市场结论。'],sectorViews:[{targetId:'overall',stance:signal.stance,thesis:'需求增长提供观察线索，成本压力仍需交叉验证。',evidenceRefs:[ref],contextRefs:[],missingMetricIds:[],risks:['需求和盈利可能不同步。'],nextEvidence:['核对下一期订单与毛利率。'],positiveCase:'已提供的需求观测方向为正面。',contraryCase:'尚缺独立成本验证，不能排除盈利压力。',scenarios:['base','upside','downside'].map((name,i)=>({name,assumption:['若投入与需求维持当前关系。','若后续盈利与订单共同改善。','若后续订单及毛利率共同走弱。'][i],implication:'则重新核对研究方向和关键证据。',invalidation:'下一期正式披露不支持该条件时重新评估。',evidenceRefs:[ref]}))}]};
 const cases=[];
 const add=(id,name,expected,mutate)=>{const p=structuredClone(packet),a=structuredClone(answer);mutate?.(a,p);cases.push({id,name,expected,packet:p,answer:a});};
 add('valid','完整的条件性解释',true);
 add('wrong_version','错误观测版本',false,a=>a.sectorViews[0].evidenceRefs[0].observationVersion='invented');
 add('wrong_period','错误报告期',false,a=>a.sectorViews[0].evidenceRefs[0].periodEnd='2027-06-30');
 add('unknown_source','编造背景来源',false,a=>a.sectorViews[0].contextRefs=[{...ref,metricId:'UNKNOWN'}]);
 add('raise_confidence','擅自提高置信度',false,a=>a.confidence='high');
 add('change_stance','覆盖规则结论',false,a=>a.overallStance='positive_allocation');
 add('missing_contrary','遗漏反向证据说明',false,a=>a.sectorViews[0].contraryCase='');
 add('missing_risk','遗漏风险',false,a=>a.sectorViews[0].risks=[]);
 add('missing_scenario','遗漏恶化情景',false,a=>a.sectorViews[0].scenarios.pop());
 add('missing_invalidation','遗漏判断失效条件',false,a=>a.sectorViews[0].scenarios[0].invalidation='');
 add('missing_target','遗漏研究目标',false,a=>a.sectorViews=[]);
 add('unsupported_promise','无依据的确定性断言',false,a=>a.summary='该指标保证推动上涨。');
 add('hidden_gap','数据缺口未披露',false,(a,p)=>{p.quantitative.overall.stance='insufficient_data';p.quantitative.sectorSignals[0].missingMetrics=['SAMPLE.orders'];a.overallStance='insufficient_data';a.summary='当前证据不足。';a.sectorViews[0].stance='insufficient_data';});
 add('missing_sample_scope','经营样本范围未说明',false,(a,p)=>{p.quantitative.sectorSignals[0].researchScope='company_operating_sample';});
 add('sample_scope','明确单一公司样本范围',true,(a,p)=>{p.quantitative.sectorSignals[0].researchScope='company_operating_sample';a.sectorViews[0].thesis='仅观察单一公司经营样本的周期，不能外推为全球行业供需。';});
 return cases;
}
export function runModelContractEvaluation(){
 const cases=modelEvaluationCases().map(c=>{const result=evaluateResearchAnswer(c.answer,c.packet);return {id:c.id,name:c.name,expected:c.expected?'accept':'reject',actual:result.accepted?'accept':'reject',passed:result.accepted===c.expected,reason:result.error};});
 return {version:MODEL_EVALUATION_VERSION,dataset:'synthetic_contract_cases',status:cases.every(c=>c.passed)?'passed':'failed',passedCount:cases.filter(c=>c.passed).length,totalCount:cases.length,cases,note:'合成题只验证程序能否识别错误，不是在线推理模型准确率，也不是投资效果。'};
}
export function buildModelEvaluation({model,analysis,packet,calls=[]}){
 const contract=runModelContractEvaluation();
 const live=analysis?.origin==='model'&&['ready','cached'].includes(model?.status)?evaluateResearchAnswer(analysis,packet):null;
 return {version:MODEL_EVALUATION_VERSION,contract,activation:{status:model?.status??'not_configured',configuredModel:model?.model??null,resolvedModel:model?.resolvedModel??null,successfulCalls:calls.filter(c=>c.status==='ready').length,requiredSteps:['后台配置 API 密钥及可用额度','首份真实响应通过引用、情景和边界检查','人工检查解释增量与反向证据']},live:{status:live?'awaiting_semantic_review':'not_run',evaluation:live,note:live?'已取得实际模型输出；自动检查结果如下，语义质量仍待复核。':'尚无可评测的真实模型输出；接口与合成题通过不能代替模型实测。'},reviewChecklist:['正面与反向解释是否都有具体证据支持','引用是否真正支持所写的语义，而非仅版本匹配','三个情景是否有不同的条件和可观察的失效信号','相对原有规则摘要，是否增加了有用的解释'],sourceUrl:'https://developers.openai.com/api/docs/guides/evaluation-best-practices'};
}
