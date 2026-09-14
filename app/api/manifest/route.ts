import macro from '@/data/seed.json';
import industry from '@/data/industry/seed.json';

export async function GET(){
 return Response.json({
  generatedAt:new Date().toISOString(),
  macro:{version:macro.generatedAt,generatedAt:macro.generatedAt},
  industry:{version:industry.generatedAt,generatedAt:industry.generatedAt}
 },{headers:{'Cache-Control':'no-store'}});
}
