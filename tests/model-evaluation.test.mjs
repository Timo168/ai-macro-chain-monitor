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
