import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
// Development backend reads the atomic cache at request time. No client-side fetching of sources.
export function localData():Plugin{return {name:'macro-local-data',configureServer(server){server.middlewares.use('/api/data',async(req,res,next)=>{if(req.method!=='GET')return next();try{const data=JSON.parse(await readFile(resolve(process.cwd(),'data/latest.json'),'utf8'));res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({...data,storage:'local_database_cache'}))}catch{res.statusCode=503;res.end(JSON.stringify({error:'Data cache unavailable'}))}})}}}
