import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {generateRecommendations,ruleReachability} from '../lib/industry/engine.mjs';
import {pendingMetrics} from '../lib/industry/catalog.mjs';

const folder='data/industry';
const now=new Date().toISOString();
mkdirSync(folder,{recursive:true});
const out=folder+'/latest.json';
const prior=existsSync(out)?JSON.parse(readFileSync(out,'utf8')):null;
const seedPath=folder+'/seed.json';
const seed=existsSync(seedPath)?JSON.parse(readFileSync(seedPath,'utf8')):null;
const sourceFiles=['companies.json','oracle.json','hardware.json','costs.json','sia.json','extended.json','power-load.json',existsSync(folder+'/reviewed-cache.json')?'reviewed-cache.json':'public-reviewed.json'];
const hasValue=point=>typeof point?.value==='number'&&Number.isFinite(point.value);
const observed=series=>(series?.observations??[]).filter(hasValue);

// Source adapters must never erase an already verified chart merely because a
// network request failed or returned an incomplete range. New observations win;
// prior valid observations fill only the gaps that the candidate omitted.
export function preserveLastKnownGood(candidate,previous){
 if(!previous?.observations?.some(hasValue))return candidate;
 const incoming=candidate?.observations??[];
 if(!incoming.some(hasValue))return {...previous,...candidate,observations:previous.observations,status:'cached',fetchedAt:previous.fetchedAt,lastSuccessfulAt:previous.lastSuccessfulAt??previous.fetchedAt,checkedAt:candidate?.checkedAt??now,error:candidate?.error??'本次更新未获得有效观测，正在展示最近成功版本。'};
 const byPeriod=new Map(previous.observations.map(point=>[point.periodEnd,point]));
 for(const point of incoming){
  const priorPoint=byPeriod.get(point.periodEnd);
  if(hasValue(point)||!priorPoint)byPeriod.set(point.periodEnd,point);
 }
 const observations=[...byPeriod.values()].sort((a,b)=>a.periodEnd.localeCompare(b.periodEnd));
 const recovered=observed(previous).length>observed(incoming).length;
 return {...candidate,observations,lastSuccessfulAt:candidate.fetchedAt??previous.lastSuccessfulAt??previous.fetchedAt,note:recovered?[candidate.note,'来源本次返回的历史范围较短，已保留之前核验的观测。'].filter(Boolean).join(' '):candidate.note};
}

const merged={schemaVersion:'1',generatedAt:now,definitions:[],series:{},projects:[],events:[],recommendations:[],recommendationHistory:prior?.recommendationHistory??[],scheduler:{mode:process.env.GITHUB_ACTIONS?'github_actions':'local',lastRunAt:now}};
for(const file of sourceFiles){
 const path=folder+'/'+file;
 if(!existsSync(path))continue;
 const payload=JSON.parse(readFileSync(path,'utf8'));
 for(const definition of payload.definitions??[])if(!merged.definitions.some(existing=>existing.id===definition.id))merged.definitions.push(definition);
 for(const [id,series] of Object.entries(payload.series??{})){
  const previous=prior?.series?.[id]?.observations?.some(hasValue)?prior.series[id]:seed?.series?.[id];
  merged.series[id]=preserveLastKnownGood(series,previous);
 }
 merged.projects.push(...(payload.projects??[]));
 merged.events.push(...(payload.events??[]));
}
for(const definition of pendingMetrics)if(!merged.definitions.some(existing=>existing.id===definition.id)){
 merged.definitions.push(definition);
 merged.series[definition.id]={observations:[],status:definition.valueType==='third_party'?'authorization_required':'pending',note:definition.note};
}
merged.projects=[...new Map(merged.projects.map(project=>[project.id,project])).values()];
merged.verification={recommendationRuleReachability:ruleReachability(merged.definitions)};
merged.recommendations=generateRecommendations(merged,merged.generatedAt,prior?.recommendations??[]);
for(const recommendation of merged.recommendations){
 const previous=prior?.recommendations?.find(item=>item.targetId===recommendation.targetId);
 if(previous?.id!==recommendation.id)merged.recommendationHistory.push(recommendation);
}
// Append-only revision ledger remains on durable data branch; website serves a bounded display history.
const historyDir=folder+'/recommendations';
mkdirSync(historyDir,{recursive:true});
for(const recommendation of merged.recommendationHistory){
 const file=historyDir+'/'+recommendation.generatedAt.replaceAll(':','-')+'-'+recommendation.id+'.json';
 if(!existsSync(file))writeFileSync(file,JSON.stringify(recommendation));
}
merged.recommendationHistory=merged.recommendationHistory.slice(-200);
writeFileSync(out+'.tmp',JSON.stringify(merged));
renameSync(out+'.tmp',out);
console.log(`Industry cache: ${merged.definitions.length} metrics; ${Object.values(merged.series).filter(series=>series.observations.some(hasValue)).length} connected; ${merged.recommendations.length} recommendation targets.`);
