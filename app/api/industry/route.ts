import snapshot from '../../../data/industry/seed.json';
export async function GET(){return Response.json(snapshot,{headers:{'Cache-Control':'no-store'}})}
