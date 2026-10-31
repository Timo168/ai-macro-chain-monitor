import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluatePlanDelivery,planSourceState,pendingPlanEntities} from '../lib/industry/plan-delivery.mjs';
const reviewed=JSON.parse(readFileSync(new URL('../lib/industry/plan-delivery-reviewed.json',import.meta.url)));
const plan=reviewed.plans.find(item=>item.id==='META-capex-2024');
test('official historical sample compares both original and revised plans without relabelling spending as returns',()=>{
 const result=evaluatePlanDelivery(plan,'2026-10-31');assert.equal(result.status,'comparable');assert.equal(result.label,'落在指引区间');assert.equal(result.actual.value,392.3);assert.equal(result.latest.low,380);assert.ok(Math.abs(result.initialDeviationPct-17.10447761194)<1e-8);
 const result2025=evaluatePlanDelivery(reviewed.plans[1],'2026-10-31');assert.equal(result2025.label,'高于指引区间');assert.equal(result2025.actual.value,722.2);
});
test('period not yet complete is pending, not a missed target',()=>{
 const result=evaluatePlanDelivery(reviewed.plans[0],'2026-10-31');assert.equal(result.status,'period_open');assert.equal(result.actual,null);assert.equal(result.latest.low,1350);assert.equal(result.initialDeviationPct,null);
});
test('cash-only, different currency, entity or period never silently matches a guidance',()=>{
 for(const [key,value] of [['scope','cash_ppe'],['currency','EUR'],['entity','OTHER'],['periodStart','2024-04-01'],['periodEnd','2024-09-30']]){
  assert.equal(evaluatePlanDelivery({...plan,actual:{...plan.actual,[key]:value}},'2026-10-31').status,'basis_mismatch');
 }
 assert.equal(evaluatePlanDelivery({...plan,actual:{...plan.actual,isEstimated:true}},'2026-10-31').status,'basis_mismatch');
});
test('later published plans and future actual values are not used retrospectively',()=>{
 const beforeActual=evaluatePlanDelivery(plan,'2024-11-01');assert.equal(beforeActual.status,'period_open');assert.equal(beforeActual.actual,null);
 const late={...plan,versions:plan.versions.map(version=>({...version,publishedAt:'2025-02-01'}))};assert.equal(evaluatePlanDelivery(late,'2026-10-31').status,'not_configured');
 const sameDay={...plan,actual:{...plan.actual,publishedAt:'2024-02-01'},versions:[plan.versions[0]]};assert.equal(evaluatePlanDelivery(sameDay,'2026-10-31').status,'not_prior');
});
test('source failure preserves a labelled reviewed snapshot and newer release triggers recheck',()=>{
 assert.equal(planSourceState(plan,{financialUpdates:[{entity:'META',sourceStatus:'fetch_failed'}]},reviewed.reviewedAt).status,'fetch_failed');
 assert.equal(planSourceState(reviewed.plans[0],{financialUpdates:[{entity:'META',release:{publishedAt:'2027-01-30'}}]},reviewed.reviewedAt).status,'needs_review');
});
test('existing actual series without a matching guidance stays explicitly pending',()=>{
 const pending=pendingPlanEntities({definitions:[{id:'X.capex',entity:'X',family:'capex',sourceUrl:'https://company.example'}],series:{'X.capex':{status:'cached',observations:[{periodEnd:'2026-03-31',value:10}]}}},reviewed.plans);
 assert.equal(pending.length,1);assert.equal(pending[0].status,'cached');assert.equal(pending[0].periodEnd,'2026-03-31');
});
