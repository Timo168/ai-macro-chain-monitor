import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFallbackAnalysis,buildResearchPacket,modelPrompt,validateModelAnalysis} from '../lib/industry/research.mjs';
import {buildQuantitativeSignal} from '../lib/industry/quant-model.mjs';

const evidence={metricId:'MSFT.capex',observationVersion:'capex-v1',direction:'positive',explanation:'资本开支同比上升。',periodEnd:'2026-06-30',dimension:'investment'};
const cloud={targetId:'cloud',targetName:'AI云计算平台',level:'gradual_attention',confidence:'medium',coverage:1,requiredDimensionCount:4,availableDimensionCount:4,reason:'多个维度为正面，但仍需验证。',dataCutoffAt:'2026-06-30',positiveEvidence:[evidence],negativeEvidence:[],neutralEvidence:[],missingMetrics:[],invalidationConditions:['需求或盈利连续放缓时重新评估。']};
const overall={targetId:'overall',targetName:'AI产业链整体',level:'insufficient_data',confidence:'low',coverage:.8,requiredDimensionCount:5,availableDimensionCount:4,reason:'建设进度证据仍不足。',dataCutoffAt:'2026-06-30',positiveEvidence:[],negativeEvidence:[],neutralEvidence:[],missingMetrics:['PROJECT.construction_capacity'],invalidationConditions:['补齐连续建设进度数据后重新评估。']};
const industry={definitions:[{id:'MSFT.capex',entity:'MSFT',nameZh:'现金资本开支',sourceUrl:'https://example.com/filing',recommendationEligible:true,category:'capex',family:'capex',aiChainStage:['capex'],frequency:'quarterly',unit:'亿美元',valueType:'reported',sourceName:'Example IR'}],series:{'MSFT.capex':{status:'ready',observations:[{periodEnd:'2026-06-30',sourceUrl:'https://example.com/filing',version:'capex-v1',value:100,publishedAt:'2026-07-30'}]}},recommendations:[cloud,overall],projects:[{id:'project-1',name:'公开项目样本',owner:'Example',country:'美国',status:'construction',powerCapacityMw:100,announcedAt:'2026-06-01',sourceUrls:['https://example.com/project']}]};
const macro={series:{DFII10:{status:'ready',sourceUrl:'https://example.com/yield',observations:[{date:'2026-08-01',value:1.5},{date:'2026-08-31',value:1.7},{date:'2026-09-24',value:1.8}]},UNRATE:{status:'ready',sourceUrl:'https://example.com/jobs',observations:[{date:'2026-07-01',value:4.1},{date:'2026-08-01',value:4.2},{date:'2026-09-01',value:4.2}]}}};
const macroDefinitions=[{id:'UNRATE',name:'美国失业率',unit:'%',frequency:'monthly'}];
const policyRates={series:[{id:'fed',name:'美联储',country:'美国',latestObservationDate:'2026-08-01',latestValue:3.625,status:'ready',sourceUrl:'https://example.com/fed'}]};
const policyDecisions={checks:[{bankId:'fed',decisionStatus:'verified'}],decisions:[{bankId:'fed',announcementDate:'2026-09-16',effectiveDate:'2026-09-17',midpoint:3.875,changeBps:25,action:'raise',statementUrl:'https://example.com/fed-decision',archive:{statementSha256:'fed-decision-v1'}}]};
const packet=()=>buildResearchPacket(industry,macro,macroDefinitions,policyRates,policyDecisions);

function modelOutput(input=packet()){
 const cloudSignal=input.quantitative.sectorSignals.find(signal=>signal.targetId==='cloud');
 const context=input.contextRefs.find(reference=>reference.metricId==='DFII10');
 return {overallStance:input.quantitative.overall.stance,summary:'整体证据不足，暂不形成方向性结论。',marketRegime:input.marketRegime,confidence:'low',limitations:['不做个股结论。'],sectorViews:[{targetId:'cloud',stance:cloudSignal.stance,thesis:'规则直接证据显示投入维度为正面，仍要验证盈利兑现。',evidenceRefs:cloudSignal.evidenceRefs.map(({metricId,observationVersion,periodEnd})=>({metricId,observationVersion,periodEnd})),contextRefs:context?[{metricId:context.metricId,observationVersion:context.observationVersion,periodEnd:context.periodEnd}]:[],missingMetricIds:cloudSignal.missingMetrics,risks:['样本和口径仍有限。'],nextEvidence:['核对下一份正式财报。']},{targetId:'overall',stance:'insufficient_data',thesis:'建设进度的连续、可比证据尚未齐备。',evidenceRefs:[],contextRefs:[],missingMetricIds:['PROJECT.construction_capacity'],risks:['关键建设进度尚未连续披露。'],nextEvidence:['补齐项目级连续建设进度。']}]};
}

test('research packet covers all current site domains without volatile generation time',()=>{
 const first=packet(),second=packet();
 assert.equal(JSON.stringify(first),JSON.stringify(second));
 assert.equal(Object.hasOwn(first,'generatedAt'),false);
 assert.equal(first.fullSiteContext.industryMetrics.length,1);
 assert.ok(first.macroSignals.some(signal=>signal.id==='UNRATE'));
 assert.equal(first.policyRateSignals[0].latestValue,3.875);
 assert.equal(first.policyRateSignals[0].decisionStatus,'verified');
 assert.equal(first.inputCoverage.projectRecordCount,1);
 assert.equal(first.sourceRefs.find(source=>source.metricId==='MSFT.capex').observationVersion,'capex-v1');
 assert.equal(buildFallbackAnalysis(first).origin,'deterministic');
 const prompt=modelPrompt(first);
 assert.match(prompt,/MSFT\.capex/);
 assert.match(prompt,/DFII10/);
 assert.match(prompt,/PROJECT\.project-1/);
 assert.ok(Buffer.byteLength(prompt)<Buffer.byteLength(JSON.stringify(first)));
});

test('fallback preserves every direct citation and distinguishes optional gaps from blocked factors',()=>{
 const input=packet();const sector=input.quantitative.sectorSignals[0];
 sector.score=30;sector.readiness={blockers:[]};sector.missingMetrics=['optional.backlog'];
 sector.evidenceRefs=Array.from({length:12},(_,index)=>({metricId:`source.${index}`,observationVersion:`v${index}`,periodEnd:'2026-06-30'}));
 sector.factorContributions=[{id:'demand',formalMetricIds:['source.11']},{id:'profitability',formalMetricIds:['source.10']}];
 const view=buildFallbackAnalysis(input).sectorViews[0];
 assert.equal(view.evidenceRefs.length,12);
 assert.equal(view.evidenceRefs[0].metricId,'source.11');
 assert.match(view.risks[0],/门槛已通过/);
 assert.match(view.risks[0],/补充指标/);
 sector.readiness.blockers=[{remedy:'补齐建设完成的实际容量历史。'}];
 assert.deepEqual(buildFallbackAnalysis(input).sectorViews[0].risks,['补齐建设完成的实际容量历史。']);
});

test('project samples and proxies are separated from direct evidence references',()=>{
 const proxy={id:'CENSUS.order_proxy',entity:'美国',nameZh:'电子订单代理',sourceUrl:'https://example.com/proxy',recommendationEligible:true,category:'projects',family:'computer_electronics_orders',aiChainStage:['data_center'],frequency:'monthly',unit:'百万美元',valueType:'proxy',sourceName:'Official proxy'};
 const projectSample={id:'PROJECT.capacity_sample',entity:'DOE/项目级公开样本',nameZh:'项目容量样本',sourceUrl:'https://example.com/project-capacity',recommendationEligible:true,category:'projects',family:'construction_capacity',aiChainStage:['data_center'],frequency:'quarterly',unit:'MW',valueType:'project_announcement',directness:'project_sample',scoringTier:'leading_only',sourceName:'Official project'};
 const recommendation={...overall,targetId:'data_centers',targetName:'数据中心建设',positiveEvidence:[evidence,{metricId:proxy.id,observationVersion:'proxy-v1',direction:'positive',explanation:'代理订单增长。',periodEnd:'2026-06-30',dimension:'demand'},{metricId:projectSample.id,observationVersion:'sample-v1',direction:'positive',explanation:'项目样本状态更新。',periodEnd:'2026-06-30',dimension:'construction'}],missingMetrics:['PROJECT.operational_capacity']};
 const input=buildResearchPacket({definitions:[...industry.definitions,proxy,projectSample],series:{...industry.series,[proxy.id]:{status:'ready',observations:[{periodEnd:'2026-06-30',sourceUrl:proxy.sourceUrl,version:'proxy-v1',value:100}]},[projectSample.id]:{status:'ready',observations:[{periodEnd:'2026-06-30',sourceUrl:projectSample.sourceUrl,version:'sample-v1',value:100}]}},recommendations:[recommendation]},macro,macroDefinitions,policyRates,policyDecisions);
 const signal=input.quantitative.sectorSignals[0];
 assert.deepEqual(signal.evidenceRefs.map(reference=>reference.metricId),['MSFT.capex']);
 assert.deepEqual(signal.leadingEvidenceRefs.map(reference=>reference.metricId).sort(),['CENSUS.order_proxy','PROJECT.capacity_sample']);
});

test('model output must retain every deterministic target, stance and overall gate',()=>{
 const input=packet(),base=modelOutput(input);
 const cloudSignal=input.quantitative.sectorSignals.find(signal=>signal.targetId==='cloud');
 assert.equal(cloudSignal.score,null);
 assert.equal(cloudSignal.stance,'insufficient_data');
 assert.equal(cloudSignal.researchAction,'仅监测，补齐证据');
 assert.ok(cloudSignal.missingMetrics.length);
 assert.equal(validateModelAnalysis(base,input).origin,'model');
 assert.throws(()=>validateModelAnalysis({...base,overallStance:'positive_allocation'},input),/整体量化证据门槛/);
 assert.throws(()=>validateModelAnalysis({...base,summary:'产业链整体积极配置。'},input),/整体证据不足/);
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[base.sectorViews[0]]},input),/遗漏/);
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[{...base.sectorViews[0],stance:'positive_allocation'},base.sectorViews[1]]},input),/覆盖量化证据层/);
});

test('model citations must match exact observation versions and known data gaps',()=>{
 const input=packet(),base=modelOutput(input);
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[{...base.sectorViews[0],evidenceRefs:[{metricId:'MSFT.capex',observationVersion:'wrong',periodEnd:'2026-06-30'}]},base.sectorViews[1]]},input),/观测版本/);
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[base.sectorViews[0],{...base.sectorViews[1],missingMetricIds:['UNKNOWN.metric']}]},input),/未知的数据缺口/);
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[base.sectorViews[0],{...base.sectorViews[1],missingMetricIds:[]}]},input),/必须列出缺少的指标/);
});

test('model text rejects Chinese and English direct stock trade language',()=>{
 const input=packet(),base=modelOutput(input);
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[{...base.sectorViews[0],thesis:'建议买入相关个股。'},base.sectorViews[1]]},input),/个股交易指令/);
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[{...base.sectorViews[0],thesis:'Buy NVDA and overweight the company.'},base.sectorViews[1]]},input),/个股交易指令/);
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[{...base.sectorViews[0],thesis:'看多英伟达。'},base.sectorViews[1]]},input),/个股交易指令/);
});

test('unconfigured dimensions and disabled targets remain explicit data gaps',()=>{
 const gap=(targetId,targetName,reason)=>({targetId,targetName,level:'insufficient_data',confidence:'low',coverage:0,requiredDimensionCount:3,availableDimensionCount:0,reason,dataCutoffAt:'',positiveEvidence:[],negativeEvidence:[],neutralEvidence:[],missingMetrics:[],invalidationConditions:['补齐正式来源后重新评估。']});
 const costDefinition={id:'WB.copper',entity:'全球',nameZh:'铜',sourceUrl:'https://example.com/copper',recommendationEligible:true,category:'costs',family:'copper',aiChainStage:['materials'],frequency:'monthly',unit:'美元／公吨',valueType:'official',sourceName:'Example'};
 const input=buildResearchPacket({definitions:[costDefinition],series:{},recommendations:[gap('foundry','晶圆代工','尚未配置可用于正式建议的实际需求、盈利兑现指标。'),gap('materials','铜、铝等上游材料','尚未接入可核验的 AI 材料订单、产能、利润与成本转嫁数据。')]},macro,macroDefinitions,policyRates,policyDecisions);
 const foundry=input.quantitative.sectorSignals.find(signal=>signal.targetId==='foundry');
 const materials=input.quantitative.sectorSignals.find(signal=>signal.targetId==='materials');
 assert.ok(foundry?.missingMetrics.includes('尚未配置：实际需求指标'));
 assert.ok(foundry?.missingMetrics.includes('尚未配置：盈利兑现指标'));
 assert.deepEqual(materials?.missingMetrics,['研究边界：尚未接入可核验的 AI 材料订单、产能、利润与成本转嫁数据。']);
 const fallback=buildFallbackAnalysis(input);
 assert.deepEqual(fallback.sectorViews.find(view=>view.targetId==='foundry')?.missingMetricIds,foundry?.missingMetrics);
});

test('model text rejects packet company entities and unsupported causal or return claims',()=>{
 const extraDefinition={id:'ACME.backlog',entity:'ACME',nameZh:'订单余额',sourceUrl:'https://example.com/acme',recommendationEligible:false,category:'servers',family:'backlog',aiChainStage:['server'],frequency:'quarterly',unit:'亿美元',valueType:'reported',sourceName:'Example IR'};
 const input=buildResearchPacket({...industry,definitions:[...industry.definitions,extraDefinition],series:{...industry.series,'ACME.backlog':{status:'ready',observations:[{periodEnd:'2026-06-30',sourceUrl:'https://example.com/acme',version:'acme-v1',value:10}]}}},macro,macroDefinitions,policyRates,policyDecisions);
 const base=modelOutput(input);
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[{...base.sectorViews[0],thesis:'ACME 具有更高配置价值。'},base.sectorViews[1]]},input),/公司层面推荐/);
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[{...base.sectorViews[0],thesis:'规则直接证据必然带动收益率上升。'},base.sectorViews[1]]},input),/因果或收益断言/);
});

test('stale industry values remain visible but are removed from model context citations',()=>{
 const stale={...industry,series:{'MSFT.capex':{status:'cached',observations:[{periodEnd:'2025-12-31',sourceUrl:'https://example.com/filing',version:'stale-v1',value:654321,publishedAt:'2026-01-30'}]}}};
 const input=buildResearchPacket(stale,macro,macroDefinitions,policyRates,policyDecisions,{asOfDate:'2026-10-01'});
 const metric=input.fullSiteContext.industryMetrics[0];
 assert.equal(metric.observations[0].value,654321);
 assert.equal(metric.reasoningRole,'excluded');
 assert.equal(metric.freshness,'stale');
 assert.match(metric.exclusionReason,/发布窗口/);
 assert.equal(input.contextRefs.some(reference=>reference.metricId==='MSFT.capex'),false);
 assert.equal(modelPrompt(input).includes('654321'),false,'excluded values must not be sent to the model');
});

test('the calculation archive retains complete historical inputs while the model sees a compact context',()=>{
 const historical=Array.from({length:12},(_,index)=>({periodEnd:new Date(Date.UTC(2023,3*index+3,0)).toISOString().slice(0,10),sourceUrl:'https://example.com/filing',version:`history-${index}`,value:987654+index,publishedAt:'2026-01-30',fetchedAt:'2026-02-01'}));
 const input=buildResearchPacket({...industry,series:{'MSFT.capex':{status:'ready',observations:historical}}},macro,macroDefinitions,policyRates,policyDecisions,{asOfDate:'2026-01-31'});
 assert.equal(input.calculationInputs.series['MSFT.capex'].observations.length,12);
 assert.equal(input.observationManifest.length,12);
 assert.equal(input.observationManifest[0].fetchedAt,'2026-02-01');
 assert.equal(input.fullSiteContext.industryMetrics[0].observations.length,3);
 assert.equal(modelPrompt(input).includes('987654'),false,'old numerical history must not be sent to the language model');
 for(const signal of input.quantitative.sectorSignals){
  const recommendation=input.calculationInputs.recommendations.find(item=>item.targetId===signal.targetId);
  const replay=buildQuantitativeSignal(recommendation,input.calculationInputs);
  assert.equal(replay.score,signal.score);
  assert.deepEqual(replay.factorContributions,signal.factorContributions);
 }
 historical[0].value=-1;
 assert.equal(input.calculationInputs.series['MSFT.capex'].observations[0].value,987654,'archive must not mutate with a source object');
});

test('only permitted reports enter the prompt and each fact preserves actual versus scenario roles',()=>{
 const report={id:'example-report',publisher:'Example institute',title:'Permitted public research',publishedAt:'2026-07-01',sourceUrl:'https://example.com/report',licenseUrl:'https://example.com/license',licenseNote:'Explicit permission for this use',status:'ready',version:'report-v1',modelUseAllowed:true,observationNature:'estimate',scope:'Global sector',unit:'TWh',methodology:'Historical survey and disclosed projection',facts:[{period:'2025',value:100,label:'Historical observed demand',nature:'actual'},{period:'2030',value:250,label:'Projected demand',nature:'forecast'}]};
 const denied={...report,id:'denied',title:'NEVER_SEND_THIS_REPORT',status:'authorization_required',modelUseAllowed:true};
 const notPermitted={...report,id:'unlicensed',title:'NOT_LICENSED_FOR_MODEL',modelUseAllowed:false};
 const input=buildResearchPacket({...industry,researchReports:[report,denied,notPermitted]},macro,macroDefinitions,policyRates,policyDecisions);
 assert.equal(input.institutionalReports.length,1);
 assert.deepEqual(input.institutionalReports[0].facts.map(fact=>fact.modelRole),['context','scenario_only']);
 assert.equal(input.institutionalReports[0].modelRole,'scenario_only');
 assert.ok(input.contextRefs.some(reference=>reference.metricId==='REPORT.example-report'&&reference.periodEnd==='2030'));
 const prompt=modelPrompt(input);
 assert.match(prompt,/Permitted public research/);
 assert.equal(prompt.includes('NEVER_SEND_THIS_REPORT'),false);
 assert.equal(prompt.includes('NOT_LICENSED_FOR_MODEL'),false);
 assert.equal(input.quantitative.sectorSignals[0].evidenceRefs.some(reference=>reference.metricId.startsWith('REPORT.')),false);
 const base=modelOutput(input),forecast=input.institutionalReports[0].facts[1].reference;
 const reference={metricId:forecast.metricId,observationVersion:forecast.observationVersion,periodEnd:forecast.periodEnd};
 const sector={...base.sectorViews[0],contextRefs:[reference]};
 assert.throws(()=>validateModelAnalysis({...base,sectorViews:[sector,base.sectorViews[1]]},input),/情景边界/);
 assert.equal(validateModelAnalysis({...base,sectorViews:[{...sector,thesis:'机构预测情景提示需求可能增加，实际兑现仍需后续验证。'},base.sectorViews[1]]},input).origin,'model');
});

test('new model outputs require three conditional scenarios and exact references',()=>{
 const input=packet(),base=modelOutput(input);
 assert.throws(()=>validateModelAnalysis(base,input,{requireScenarios:true}),/三个不同/);
 const views=base.sectorViews.map(view=>({...view,positiveCase:'投入数据提供正面线索，仍待验证。',contraryCase:'关键建设历史仍有缺口。',scenarios:['base','upside','downside'].map(name=>({name,assumption:'若后续正式披露维持当前方向。',implication:'则保持条件性的观察倾向。',invalidation:'需求或盈利连续走弱时重新核验。',evidenceRefs:view.evidenceRefs}))}));
 const value={...base,sectorViews:views};
 assert.equal(validateModelAnalysis(value,input,{requireScenarios:true}).sectorViews[0].scenarios.length,3);
 assert.throws(()=>validateModelAnalysis({...value,sectorViews:[{...views[0],scenarios:[views[0].scenarios[0],views[0].scenarios[0],views[0].scenarios[2]]},views[1]]},input,{requireScenarios:true}),/三个不同/);
 assert.throws(()=>validateModelAnalysis({...value,sectorViews:[{...views[0],scenarios:[{...views[0].scenarios[0],evidenceRefs:[{metricId:'fake',observationVersion:'fake',periodEnd:'2026-06-30'}]},...views[0].scenarios.slice(1)]},views[1]]},input,{requireScenarios:true}),/情景引用/);
 assert.throws(()=>validateModelAnalysis({...value,sectorViews:[{...views[0],evidenceRefs:[{metricId:'MSFT.capex'}]},views[1]]},input,{requireScenarios:true}),/引用缺少完整/);
});
