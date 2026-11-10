import snapshot from '@/data/regional-energy.seed.json';

export async function GET(){
 return Response.json(snapshot,{headers:{'Cache-Control':'no-store'}});
}
