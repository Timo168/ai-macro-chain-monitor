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

const policyRateColorsByBank:Record<string,string>={
 fed:'#167c68',
 boj:'#466fb1',
 bok:'#8d5a9a',
 ecb:'#a66b37',
  boe:'#bf5967',
  // Use a warm orange-red so Canada stays distinct from the Fed's green in every selection.
  boc:'#df5a2a',
  rba:'#007f87',
  rbnz:'#6c55aa',
  snb:'#718234',
  pboc:'#a94878',
  cbr:'#8a3d36',
  rbi:'#9c6b00',
  bcb:'#177f82',
  sarb:'#4a5f9e',
};

const fallbackPolicyRateColors=['#167c68','#466fb1','#8d5a9a','#a66b37','#bf5967','#df5a2a','#007f87','#6c55aa','#718234','#a94878','#8a3d36','#9c6b00','#177f82','#4a5f9e'];

export function policyRateColor(bankId:string,index=0){
 return policyRateColorsByBank[bankId]??fallbackPolicyRateColors[index%fallbackPolicyRateColors.length];
}

export function policyRateChange(series:PolicyRateSeries){
 const latest=series.observations.at(-1);
 const prior=series.observations.at(-2);
 return latest&&prior?latest.value-prior.value:null;
}
