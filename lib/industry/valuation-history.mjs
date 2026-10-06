/** Historical valuation uses dated original issuer releases or saved live
 * snapshots. A current third-party TTM field is never applied to old prices. */
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const day=value=>String(value??'').slice(0,10);
const elapsed=(from,to)=>(Date.parse(to)-Date.parse(from))/86400000;
const knownAt=point=>point.availableAt??point.publishedAt;
export const VALUATION_HISTORY_VERSION='valuation-history-1.0.0';

export function disclosedDilutedEps(market,entity,at,{afterPublicationDay=false}={}){
 const finance=market?.finance?.[entity];const history=finance?.epsHistory;
 if(!['ready','cached'].includes(history?.status))return null;
 const visible=new Map();
 for(const p of [...(history.observations??[])].sort((a,b)=>String(knownAt(a)).localeCompare(String(knownAt(b))))){
  const known=day(knownAt(p));
  if(!known||known>at||afterPublicationDay&&known===at||p.periodEnd>at||p.currency!=='USD'||p.unit!=='USD per diluted share'||!numeric(p.value))continue;
  if(p.isRestated&&!p.availableAt)continue;
  visible.set(p.periodEnd,p);
 }
 const rows=[...visible.values()].sort((a,b)=>a.periodEnd.localeCompare(b.periodEnd)).slice(-4);
 if(rows.length!==4||elapsed(rows.at(-1).periodEnd,at)>200||rows.some((p,i)=>i>0&&(elapsed(rows[i-1].periodEnd,p.periodEnd)<70||elapsed(rows[i-1].periodEnd,p.periodEnd)>105)))return null;
 const prices=market.prices?.[entity]??{};const splits=prices.splits??[];
 if(splits.length&&prices.closeAdjustment!=='split_adjusted')return null;
 const basisDate=prices.closeBasisDate??prices.observations?.at(-1)?.date??at;
 let sum=0;
 for(const p of rows){
  // A split between quarter-end and publication may already be reflected in
  // issuer EPS. Without an explicit restatement basis, do not guess twice.
  if(splits.some(s=>s.date>p.periodEnd&&s.date<=day(p.publishedAt)))return null;
  let divisor=1;
  for(const split of splits.filter(s=>s.date>day(p.publishedAt)&&s.date<=basisDate)){
   if(!(numeric(split.numerator)&&split.numerator>0&&numeric(split.denominator)&&split.denominator>0))return null;
   divisor*=split.numerator/split.denominator;
  }
  sum+=p.value/divisor;
 }
 return {value:sum,periodEnd:rows.at(-1).periodEnd,publishedAt:rows.map(knownAt).sort().at(-1),basis:'official_reported_diluted_eps',sourceStatus:history.status,inputs:rows.map(p=>({periodEnd:p.periodEnd,value:p.value,availableAt:knownAt(p),sourceUrl:p.sourceUrl,version:p.version})),splitBasisDate:basisDate};
}

function quantile(values,q){const i=(values.length-1)*q;const lower=Math.floor(i);return values[lower]+(values[Math.ceil(i)]-values[lower])*(i-lower);}
function distribution(rows,key,current){
 const values=rows.map(p=>p[key]).filter(numeric).sort((a,b)=>a-b);
 // A percentile from a handful of newly saved snapshots would imply a
 // historical range that does not yet exist. Retain sample count honestly.
 const ready=values.length>=60;
 return {count:values.length,p10:ready?quantile(values,.1):null,median:ready?quantile(values,.5):null,p90:ready?quantile(values,.9):null,percentile:ready&&numeric(current)?100*(values.filter(v=>v<current).length+values.filter(v=>v===current).length/2)/values.length:null};
}

export function buildValuationHistory(company,market,{asOf,previous=null,recordedAt=null}={}){
 const entity=company.entity;const prices=market?.prices?.[entity]??{};const observations=new Map();
 // Old observations are immutable actual saved values; they are not rebuilt
 // with today's financial fields, company scope, or balance sheet.
 for(const p of previous?.observations??[]){if(p.date<=asOf&&p.recordedAt&&day(p.recordedAt)<=asOf&&p.origin==='live_snapshot')observations.set(p.date,p);}
 if(['ready','cached'].includes(prices.status)&&prices.currency==='USD'){
  for(const quote of prices.observations??[]){
   if(quote.date>asOf||!numeric(quote.close)||quote.close<=0)continue;
   const eps=disclosedDilutedEps(market,entity,quote.date,{afterPublicationDay:true});
   if(!(eps?.value>0))continue;
   const prior=observations.get(quote.date);
   if(prior?.origin==='live_snapshot')continue;
   observations.set(quote.date,{...prior,date:quote.date,priceAt:quote.date,price:quote.close,pe:quote.close/eps.value,ps:prior?.ps??null,fcfYield:prior?.fcfYield??null,origin:prior?'live_snapshot':'issuer_release_reconstruction',recordedAt:prior?.recordedAt??recordedAt??asOf,peBasis:'price_over_reported_diluted_eps',ttmEnd:eps.periodEnd,publishedAt:eps.publishedAt,eps:eps.value,epsInputs:eps.inputs,priceVersion:prices.version??null,sourceUrl:prices.sourceUrl??null});
  }
 }
 const currentValid=company.status!=='scope_mismatch'&&!company.isManual&&company.priceAt&&elapsed(company.priceAt,asOf)<=7&&['ready','cached'].includes(prices.status);
 if(currentValid&&['pe','ps','fcfYield'].some(key=>numeric(company[key]))){
  const prior=observations.get(asOf);
  if(prior?.origin!=='live_snapshot')observations.set(asOf,{date:asOf,priceAt:company.priceAt,price:company.price,pe:company.pe,ps:company.ps,fcfYield:company.fcfYield,origin:'live_snapshot',recordedAt:recordedAt??asOf,peBasis:company.peBasis??'market_cap_over_ttm_income',ttmEnd:company.ttmEnd,sourceUrl:company.sourceUrl,priceVersion:company.priceVersion,financeVersions:Object.fromEntries(Object.entries(company.fields??{}).map(([key,p])=>[key,{periodEnd:p.periodEnd,publishedAt:p.publishedAt??null,fetchedAt:p.fetchedAt??null,version:p.version??null,sourceUrl:p.sourceUrl??null}]))});
 }
 const rows=[...observations.values()].sort((a,b)=>a.date.localeCompare(b.date));
 const metrics=Object.fromEntries(['pe','ps','fcfYield'].map(key=>[key,distribution(rows,key,company[key])]));
 const issuerCount=rows.filter(p=>p.origin==='issuer_release_reconstruction').length;
 return {version:VALUATION_HISTORY_VERSION,status:rows.length?['ready','cached'].includes(prices.status)?prices.status==='cached'||market?.finance?.[entity]?.epsHistory?.status==='cached'?'cached':Object.values(metrics).some(m=>m.count>=60)?'available':'accumulating':'cached':'insufficient_history',count:rows.length,from:rows[0]?.date??null,to:rows.at(-1)?.date??null,metrics,observations:rows,reconstructedCount:issuerCount,snapshotCount:rows.length-issuerCount,method:issuerCount?'P/E按各日已公布且连续四季的GAAP稀释每股收益重建；公告未提供精确时刻时从公告次日起使用。季度EPS分母和四舍五入口径不同于全年EPS；按已知拆股统一分母。P/S及现金流收益率仅保留当日真实快照。':'从真实留存之日起积累估值；未取得历史发布日期的当前财务不倒填过去。',note:'至少60个有效日期才展示该项历史分位。分位只描述已覆盖区间中的相对位置，不代表合理价值或未来回报。数据源失败时保留最后成功观测。'};
}
