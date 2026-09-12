import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
// Development backend reads the atomic cache at request time. No client-side fetching of sources.
export function localData():Plugin{return {name:'macro-local-data',configureServer(server){
 for(const [route,folder] of [['/api/data','data'],['/api/industry','data/industry']])server.middlewares.use(route,async(req,res,next)=>{
  if(req.method!=='GET')return next();
  try{const raw=await readFile(resolve(process.cwd(),folder,'latest.json'),'utf8').catch(()=>readFile(resolve(process.cwd(),folder,'seed.json'),'utf8'));res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(raw)}
  catch{res.statusCode=503;res.end(JSON.stringify({error:'Data cache unavailable'}))}
 });
}}}
