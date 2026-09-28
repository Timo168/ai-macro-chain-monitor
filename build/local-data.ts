import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import type {Plugin} from 'vite';

type SnapshotRoute={route:string;folder:string;current:string;fallback:string};

const snapshots:SnapshotRoute[]=[
 {route:'/api/data',folder:'data',current:'latest.json',fallback:'seed.json'},
 {route:'/data/latest.json',folder:'data',current:'latest.json',fallback:'seed.json'},
 {route:'/api/industry',folder:'data/industry',current:'latest.json',fallback:'seed.json'},
 {route:'/api/industry/research',folder:'data/industry',current:'research.json',fallback:'research.seed.json'},
 {route:'/api/policy-rates',folder:'data',current:'policy-rates.json',fallback:'policy-rates.seed.json'},
 {route:'/api/policy-decisions',folder:'data',current:'policy-decisions.json',fallback:'policy-decisions.seed.json'},
];

const macroSnapshot=snapshots.find(snapshot=>snapshot.route==='/api/data')!;
const industrySnapshot=snapshots.find(snapshot=>snapshot.route==='/api/industry')!;
const researchSnapshot=snapshots.find(snapshot=>snapshot.route==='/api/industry/research')!;
const policyRatesSnapshot=snapshots.find(snapshot=>snapshot.route==='/api/policy-rates')!;
const policyDecisionsSnapshot=snapshots.find(snapshot=>snapshot.route==='/api/policy-decisions')!;
const version=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);

async function currentSnapshot(snapshot:SnapshotRoute){
 const current=resolve(process.cwd(),snapshot.folder,snapshot.current);
 const fallback=resolve(process.cwd(),snapshot.folder,snapshot.fallback);
 return readFile(current,'utf8').catch(()=>readFile(fallback,'utf8'));
}

// Development backend reads atomic caches at request time. Browser code never
// requests original sources, and a scheduler update appears on the next poll
// without restarting Vite.
export function localData():Plugin{
 return {name:'macro-local-data',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(req.method!=='GET')return next();
  const pathname=(req.url??'').split('?')[0];
  const snapshot=snapshots.find(item=>item.route===pathname);
  try{
   if(pathname==='/api/manifest'){
    const [macroRaw,industryRaw,researchRaw,policyRatesRaw,policyDecisionsRaw]=await Promise.all([macroSnapshot,industrySnapshot,researchSnapshot,policyRatesSnapshot,policyDecisionsSnapshot].map(currentSnapshot));
    const [macro,industry,research,policyRates,policyDecisions]=[macroRaw,industryRaw,researchRaw,policyRatesRaw,policyDecisionsRaw].map(raw=>JSON.parse(raw));
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
    return res.end(JSON.stringify({generatedAt:new Date().toISOString(),macro:{version:version(macro),generatedAt:macro.generatedAt},industry:{version:version(industry),generatedAt:industry.generatedAt},industryResearch:{version:version(research),generatedAt:research.generatedAt},policyRates:{version:version(policyRates),generatedAt:policyRates.generatedAt},policyDecisions:{version:version(policyDecisions),generatedAt:policyDecisions.generatedAt}}));
   }
   if(pathname==='/api/industry/history'){
    const industry=JSON.parse(await currentSnapshot(industrySnapshot));
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
    return res.end(JSON.stringify(industry.recommendationHistory??[]));
   }
   if(!snapshot)return next();
   const raw=await currentSnapshot(snapshot);
   res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
   return res.end(raw);
  }catch{
   res.statusCode=503;return res.end(JSON.stringify({error:'Data cache unavailable'}));
  }
 });}};
}
