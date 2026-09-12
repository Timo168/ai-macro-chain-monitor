import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {generateRecommendations} from '../lib/industry/engine.mjs';
import {pendingMetrics} from '../lib/industry/catalog.mjs';
const folder='data/industry';mkdirSync(folder,{recursive:true});const out=folder+'/latest.json';const prior=existsSync(out)?JSON.parse(readFileSync(out,'utf8')):null;
const merged={schemaVersion:'1',generatedAt:new Date().toISOString(),definitions:[],series:{},projects:[],events:[],recommendations:[],recommendationHistory:prior?.recommendationHistory??[],scheduler:{mode:process.env.GITHUB_ACTIONS?'github_actions':'local',lastRunAt:new Date().toISOString()}};
for(const file of ['companies.json','oracle.json','hardware.json','costs.json','sia.json'])if(existsSync(folder+'/'+file)){const p=JSON.parse(readFileSync(folder+'/'+file,'utf8'));for(const d of p.definitions){if(!merged.definitions.some(m=>m.id===d.id))merged.definitions.push(d);}Object.assign(merged.series,p.series);merged.projects.push(...(p.projects??[]));merged.events.push(...(p.events??[]));}
for(const d of pendingMetrics)if(!merged.definitions.some(m=>m.id===d.id)){merged.definitions.push(d);merged.series[d.id]={observations:[],status:d.valueType==='third_party'?'authorization_required':'pending',note:d.note};}
merged.projects=[...new Map(merged.projects.map(p=>[p.id,p])).values()];
merged.recommendations=generateRecommendations(merged,merged.generatedAt,prior?.recommendations??[]);
for(const r of merged.recommendations){const prev=prior?.recommendations?.find(p=>p.targetId===r.targetId);if(prev?.id!==r.id)merged.recommendationHistory.push(r);}
writeFileSync(out+'.tmp',JSON.stringify(merged));renameSync(out+'.tmp',out);
// Append-only revision ledger remains on durable data branch; website serves a bounded display history.
const historyDir=folder+'/recommendations';mkdirSync(historyDir,{recursive:true});for(const r of merged.recommendationHistory){const file=historyDir+'/'+r.generatedAt.replaceAll(':','-')+'-'+r.id+'.json';if(!existsSync(file))writeFileSync(file,JSON.stringify(r));}
merged.recommendationHistory=merged.recommendationHistory.slice(-200);
writeFileSync(out+'.tmp',JSON.stringify(merged));renameSync(out+'.tmp',out);
console.log(`Industry cache: ${merged.definitions.length} metrics; ${Object.values(merged.series).filter(s=>s.observations.some(p=>p.value!=null)).length} connected; ${merged.recommendations.length} recommendation targets.`);
