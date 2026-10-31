import test from 'node:test';
import assert from 'node:assert/strict';
import {runModelContractEvaluation,buildModelEvaluation,modelEvaluationCases,evaluateResearchAnswer} from '../lib/industry/model-evaluation.mjs';
test('fixed synthetic cases reject wrong citations, missing risks, unjustified confidence and lost scope',()=>{
 const result=runModelContractEvaluation();
 assert.equal(result.status,'passed',JSON.stringify(result.cases.filter(c=>!c.passed)));assert.equal(result.totalCount,15);
});
test('offline validator success is never labelled as actual model performance',()=>{
 const result=buildModelEvaluation({model:{status:'not_configured'},analysis:{origin:'deterministic'},packet:modelEvaluationCases()[0].packet,calls:[]});
 assert.equal(result.contract.status,'passed');assert.equal(result.live.status,'not_run');assert.equal(result.live.evaluation,null);assert.equal(result.activation.successfulCalls,0);
});
test('real output checks retain the human semantic review boundary',()=>{
 const fixture=modelEvaluationCases()[0];const result=evaluateResearchAnswer(fixture.answer,fixture.packet);
 assert.equal(result.accepted,true);assert.equal(result.contraryCaseCoverage,1);assert.equal(result.semanticReview,'pending_human_review');
});
test('local activation requires installed thinking model instead of paid API credentials',()=>{
 const packet=modelEvaluationCases()[0].packet;
 for(const provider of [{providerId:'ollama'},{provider:'ollama'},{provider:'Ollama 本地推理'}]){
  const result=buildModelEvaluation({model:{status:'not_configured',...provider},analysis:{origin:'deterministic'},packet});
  assert.match(result.activation.requiredSteps[0],/Ollama.*thinking/);assert.doesNotMatch(result.activation.requiredSteps.join(' '),/API 密钥|可用额度/);
  assert.equal(result.live.status,'not_run');assert.equal(result.live.evaluation,null);assert.match(result.contract.note,/不是在线推理模型准确率/);
 }
 const external=buildModelEvaluation({model:{providerId:'openai',provider:'OpenAI Responses API'},analysis:{origin:'deterministic'},packet});
 assert.match(external.activation.requiredSteps[0],/API 密钥及可用额度/);
});
test('only a ready or cached actual model answer is eligible for live evaluation',()=>{
 const {packet,answer}=modelEvaluationCases()[0];
 for(const status of ['ready','cached']){
  const result=buildModelEvaluation({model:{status,providerId:'ollama'},analysis:{...answer,origin:'model'},packet});
  assert.equal(result.live.status,'awaiting_semantic_review');assert.equal(result.live.evaluation.accepted,true);assert.equal(result.live.evaluation.semanticReview,'pending_human_review');
 }
 for(const [status,origin] of [['ready','deterministic'],['cached','deterministic'],['rejected','model'],['fetch_failed','model']]){
  const result=buildModelEvaluation({model:{status,providerId:'ollama'},analysis:{...answer,origin},packet});
  assert.equal(result.live.status,'not_run');assert.equal(result.live.evaluation,null);
 }
});
