import snapshot from '@/data/calendar.seed.json';

export async function GET(){
 return Response.json(snapshot,{headers:{'Cache-Control':'no-store'}});
}
