import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Plugin} from 'vite';

type SnapshotRoute={route:string;folder:string;current:string;fallback:string};

const snapshots:SnapshotRoute[]=[
 {route:'/api/data',folder:'data',current:'latest.json',fallback:'seed.json'},
 {route:'/data/latest.json',folder:'data',current:'latest.json',fallback:'seed.json'},
 {route:'/api/industry',folder:'data/industry',current:'latest.json',fallback:'seed.json'},
 {route:'/api/policy-rates',folder:'data',current:'policy-rates.json',fallback:'policy-rates.seed.json'},
 {route:'/api/policy-decisions',folder:'data',current:'policy-decisions.json',fallback:'policy-decisions.seed.json'},
];

async function currentSnapshot(snapshot:SnapshotRoute){
 const current=resolve(process.cwd(),snapshot.folder,snapshot.current);
 const fallback=resolve(process.cwd(),snapshot.folder,snapshot.fallback);
 return readFile(current,'utf8').catch(()=>readFile(fallback,'utf8'));
}

// Development backend reads atomic caches at request time. Browser code never
// requests original sources, and a scheduler update appears on the next poll
// without restarting Vite.
export function localData():Plugin{
 return {name:'macro-local-data',configureServer(server){
  for(const snapshot of snapshots)server.middlewares.use(snapshot.route,async(req,res,next)=>{
   if(req.method!=='GET')return next();
   try{
    const raw=await currentSnapshot(snapshot);
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    res.end(raw);
   }catch{
    res.statusCode=503;
    res.end(JSON.stringify({error:'Data cache unavailable'}));
   }
  });
 }};
}
