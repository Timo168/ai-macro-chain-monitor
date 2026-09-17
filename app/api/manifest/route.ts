import macro from '@/data/seed.json';
import industry from '@/data/industry/seed.json';
import policyRates from '@/data/policy-rates.seed.json';
import policyDecisions from '@/data/policy-decisions.seed.json';

export async function GET(){
 return Response.json({
  generatedAt:new Date().toISOString(),
  macro:{version:macro.generatedAt,generatedAt:macro.generatedAt},
  industry:{version:industry.generatedAt,generatedAt:industry.generatedAt},
  policyRates:{version:policyRates.generatedAt,generatedAt:policyRates.generatedAt},
  policyDecisions:{version:policyDecisions.generatedAt,generatedAt:policyDecisions.generatedAt}
 },{headers:{'Cache-Control':'no-store'}});
}
