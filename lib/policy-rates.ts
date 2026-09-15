export type PolicyRateObservation={date:string;value:number};
export type PolicyRateSeries={
 id:string;
 name:string;
 country:string;
 shortName:string;
 sourceArea:string;
 sourceTitle:string;
 sourceUrl:string;
 observations:PolicyRateObservation[];
 latestObservationDate:string;
 latestValue:number;
 status:'ready'|'cached';
};
export type PolicyRatesDataset={
 generatedAt:string;
 checkedAt:string;
 status:'ready'|'cached';
 error?:string;
 source:{name:string;url:string;apiUrl:string;frequency:string;unit:string};
 series:PolicyRateSeries[];
};

export const policyRateColors=['#167c68','#466fb1','#a66b37','#8d5a9a','#bf5967','#3f8c9a'];

export function policyRateChange(series:PolicyRateSeries){
 const latest=series.observations.at(-1);
 const prior=series.observations.at(-2);
 return latest&&prior?latest.value-prior.value:null;
}
