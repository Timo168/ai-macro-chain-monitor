export type PolicyDecision={
 bankId:string;
 bank:string;
 country:string;
 announcementDate:string;
 announcedAt?:string|null;
 effectiveDate?:string|null;
 lower:number;
 upper:number;
 midpoint:number;
 action:'raise'|'lower'|'maintain';
 changeBps:number;
 statementUrl:string;
 implementationUrl?:string;
 sourceName:string;
 fetchedAt:string;
};

export type PolicyDecisionsDataset={
 generatedAt:string;
 checkedAt:string;
 status:'ready'|'cached'|'fetch_failed'|'unavailable';
 error?:string;
 source:{name:string;url:string;frequency:string;unit:string};
 decisions:PolicyDecision[];
};

export function policyDecisionChange(decision:PolicyDecision){
 if(decision.action==='maintain'||decision.changeBps===0)return '维持不变';
 return `${decision.action==='raise'?'上调':'下调'} ${Math.abs(decision.changeBps).toFixed(0)}bp`;
}

export function isDecisionAheadOfMonthlyHistory(decision:PolicyDecision,latestObservationDate:string){
 const effectivePeriod=(decision.effectiveDate||decision.announcementDate).slice(0,7);
 const latestPeriod=latestObservationDate.slice(0,7);
 return effectivePeriod>latestPeriod;
}
