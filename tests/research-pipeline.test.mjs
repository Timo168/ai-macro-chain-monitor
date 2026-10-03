import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const builder=new URL('../scripts/build-investment-research.mjs',import.meta.url);
test('complete background research pipeline records real response metadata and safely reuses or falls back',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'research-integration-')),cwd=process.cwd(),prior={...process.env};
 const json=(name,value)=>writeFileSync(join(directory,name),JSON.stringify(value));
 const read=name=>JSON.parse(readFileSync(join(directory,'data/industry',name),'utf8'));
 const recommendation={targetId:'overall',targetName:'AI产业链整体',level:'insufficient_data',confidence:'low',coverage:0,requiredDimensionCount:5,availableDimensionCount:0,reason:'证据不足',dataCutoffAt:'',positiveEvidence:[],negativeEvidence:[],neutralEvidence:[],missingMetrics:['未配置建设数据'],invalidationConditions:['下一次正式披露后重新核验。']};
 let requests=0,mode='success';const fetchPrior=globalThis.fetch;
 try{
  mkdirSync(join(directory,'data/industry'),{recursive:true});mkdirSync(join(directory,'lib'));
  json('lib/indicators.json',[]);json('data/industry/latest.json',{definitions:[],series:{},recommendations:[recommendation],projects:[],events:[]});
  process.chdir(directory);process.env.OPENAI_API_KEY='local-mock-only-never-a-live-key';process.env.REASONING_MODEL='gpt-5-mini';process.env.REASONING_EFFORT='medium';
  globalThis.fetch=async(url,options)=>{
   requests++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.reasoning.effort,'medium');
   const packet=JSON.parse(body.input.split('数据包：\n').at(-1));
   const answer={overallStance:packet.quantitative.overall.stance,summary:'整体证据不足，仍需验证。',marketRegime:packet.marketRegime,confidence:'low',limitations:['当前是条件性产业研究。'],sectorViews:packet.quantitative.sectorSignals.map(signal=>({targetId:signal.targetId,stance:signal.stance,thesis:'当前关键直接证据不足，保留观察。',evidenceRefs:[],contextRefs:[],missingMetricIds:signal.missingMetrics,risks:['后续公开数据仍待确认。'],nextEvidence:['核对下一期正式披露。'],positiveCase:'已有研究框架可追溯。',contraryCase:'当前关键数据尚缺。',scenarios:['base','upside','downside'].map(name=>({name,assumption:'若后续官方披露发生变化。',implication:'则重新核验条件性研究判断。',invalidation:'正式披露与当前假设不一致时重算。',evidenceRefs:[]}))}))};
   if(mode==='bad-citation')answer.sectorViews[0].evidenceRefs=[{metricId:'invented',observationVersion:'wrong',periodEnd:'2026-06-30'}];
   return {ok:true,headers:{get:()=>`req-mock-${requests}`},json:async()=>({id:`resp-mock-${requests}`,model:'gpt-5-mini-2025-08-07',status:mode==='incomplete'?'incomplete':'completed',incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:1000,output_tokens:500,input_tokens_details:{cached_tokens:100},output_tokens_details:{reasoning_tokens:400}},output_text:JSON.stringify(answer)})};
  };
  const build=async number=>import(builder.href+'?pipeline-case='+number);
  await build(1);let result=read('research.json');assert.equal(result.model.status,'ready',result.model.error);assert.equal(result.analysis.origin,'model');assert.equal(result.analysis.sectorViews[0].scenarios.length,3);assert.equal(result.model.requestId,'req-mock-1');assert.equal(result.model.resolvedModel,'gpt-5-mini-2025-08-07');assert.equal(result.model.usage.reasoningTokens,400);assert.ok(result.model.usage.estimatedCostUsd>0);
  await build(2);assert.equal(requests,1);assert.equal(read('research.json').model.status,'cached');assert.equal(read('research-model-calls.json').length,1);
  mode='bad-citation';json('data/industry/latest.json',{definitions:[],series:{},recommendations:[{...recommendation,reason:'增加了一条待核验的来源。'}],projects:[],events:[]});
  await build(3);result=read('research.json');assert.equal(result.model.status,'rejected');assert.equal(result.analysis.origin,'deterministic');assert.equal(result.model.citationAudit.invalid,1);assert.equal(result.modelAudit.rejectedCalls,1);assert.ok(result.modelAudit.estimatedCostUsd>0);
  await build(4);assert.equal(requests,2);assert.equal(read('research.json').model.status,'deferred');
  mode='incomplete';json('data/industry/latest.json',{definitions:[],series:{},recommendations:[{...recommendation,reason:'另外一个新的证据包。'}],projects:[],events:[]});
  await build(5);result=read('research.json');assert.equal(result.model.status,'fetch_failed');assert.equal(result.model.usage.outputTokens,500);assert.equal(result.modelAudit.totalCalls,3);
  delete process.env.OPENAI_API_KEY;await build(6);result=read('research.json');assert.equal(result.model.status,'not_configured');assert.equal(result.analysis.origin,'deterministic');assert.equal(requests,3);
  assert.equal(readFileSync(join(directory,'data/industry/research.json'),'utf8').includes('local-mock-only-never-a-live-key'),false);
 }finally{globalThis.fetch=fetchPrior;process.chdir(cwd);for(const key of Object.keys(process.env))if(!Object.hasOwn(prior,key))delete process.env[key];Object.assign(process.env,prior);rmSync(directory,{recursive:true,force:true});}
});
