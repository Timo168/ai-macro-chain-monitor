import snapshot from '@/data/policy-rates.seed.json';

export async function GET(){
 return Response.json(snapshot,{headers:{'Cache-Control':'no-store'}});
}
