import snapshot from '@/data/seed.json';
export async function GET(){
 return Response.json({...snapshot,storage:'snapshot',scheduler:{mode:'snapshot',lastRunAt:snapshot.generatedAt}},{headers:{'Cache-Control':'no-store'}})
}
