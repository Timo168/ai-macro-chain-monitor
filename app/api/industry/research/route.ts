import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import snapshot from '../../../../data/industry/research.seed.json';

export const dynamic='force-dynamic';

export async function GET(){
 const path=join(process.cwd(),'data','industry','research.json');
 const payload=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):snapshot;
 return Response.json(payload,{headers:{'Cache-Control':'no-store'}});
}
