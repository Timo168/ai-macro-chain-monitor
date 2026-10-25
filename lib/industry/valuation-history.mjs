/** Historical valuation uses dated original issuer releases or saved live
 * snapshots. A current third-party TTM field is never applied to old prices. */
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const day=value=>String(value??'').slice(0,10);
const elapsed=(from,to)=>(Date.parse(to)-Date.parse(from))/86400000;
const knownAt=point=>point.availableAt??point.publishedAt;
export const VALUATION_HISTORY_VERSION='valuation-history-2.0.0';

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
 const dated=new Map(rows.filter(p=>numeric(p[key])).map(p=>[p.priceAt??p.date,p[key]]));
 const values=[...dated.values()].sort((a,b)=>a-b);
 // A percentile from a handful of newly saved snapshots would imply a
 // historical range that does not yet exist. Retain sample count honestly.
 const ready=values.length>=60;
 return {count:values.length,p10:ready?quantile(values,.1):null,median:ready?quantile(values,.5):null,p90:ready?quantile(values,.9):null,percentile:ready&&numeric(current)?100*(values.filter(v=>v<current).length+values.filter(v=>v===current).length/2)/values.length:null};
}

const keys=['pe','ps','fcfYield'];
const clone=value=>JSON.parse(JSON.stringify(value));
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const snapshotTime=p=>p.recordedAt??p.asOf??p.date;
const visibleAt=(p,asOf,recordedAt)=>Boolean(p.recordedAt&&day(snapshotTime(p))<=asOf&&(p.asOf??p.date)<=asOf&&(!recordedAt||Date.parse(snapshotTime(p))<=Date.parse(recordedAt)));
function inputKey(name,p){
 // A source version identifies the same financial input despite later fetches.
 // Without a version or value, an older legacy field cannot establish identity.
 if(!p.version&&!numeric(p.value))return null;
 return stable({name,periodEnd:p.periodEnd,sourceUrl:p.sourceUrl,version:p.version??null,...(!p.version?{value:p.value,currency:p.currency,unit:p.unit}:{})});
}
function financialInputs(p,key){
 if(key==='pe'&&p.peBasis==='price_over_reported_diluted_eps')return (p.epsInputs??[]).map((v,i)=>[`eps.${v.periodEnd??i}`,v]);
 const names=key==='pe'?['shares','netIncome']:key==='ps'?['shares','revenue']:['shares','operatingCashFlow','capex'];
 return names.map(name=>[name,p.financeVersions?.[name]]);
}
function snapshotAvailability(p,key,firstKnown){
 const quoteDate=p.priceAt??p.date;const inputs=financialInputs(p,key);const known=[];let inferred=false;
 for(const [name,input] of inputs){
  if(input?.periodEnd>quoteDate)return {eligible:false,availableAt:input.periodEnd,reason:'财务报告期晚于该报价日'};
  const published=input?.isRestated&&!input.availableAt?null:input?.availableAt??input?.publishedAt;
  if(published){
   // Date-only disclosures may be released after the market closes. The
   // following date is the first safe daily historical valuation date.
   const publishedTime=Date.parse(day(published));
   if(!Number.isFinite(publishedTime))return {eligible:false,availableAt:null,reason:'财务发布时间无效'};
   const nextDay=new Date(publishedTime+86400000).toISOString().slice(0,10);
   known.push(nextDay);
  }else{
   inferred=true;
   const identity=input&&inputKey(name,input);
   known.push(day(identity&&firstKnown.get(identity)||snapshotTime(p)));
  }
 }
 if(!inputs.length){inferred=true;known.push(day(snapshotTime(p)));}
 const availableAt=known.sort().at(-1)??day(snapshotTime(p));
 return {eligible:availableAt<=quoteDate,availableAt,inferred,reason:availableAt>quoteDate?'该财务版本在报价日后才公开或首次留存，不倒填旧行情':null};
}
function snapshotSignature(p){
 // Fetch/record timestamps are audit metadata, not additional price samples.
 const omitTimes=value=>Array.isArray(value)?value.map(omitTimes):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['fetchedAt','priceFetchedAt','recordedAt','asOf','date'].includes(key)).map(([key,v])=>[key,omitTimes(v)])):value;
 return stable(omitTimes({...p,priceAt:p.priceAt??p.date}));
}

export function buildValuationHistory(company,market,{asOf,previous=null,recordedAt=null}={}){
 const entity=company.entity;const prices=market?.prices?.[entity]??{};const observations=new Map();
 // Migrate once without rewriting original dates, timestamps, or provenance.
 // This append-only archive is separate from the one-sample-per-quote view.
 const snapshots=clone(previous?.snapshots??(previous?.observations??[]).filter(p=>p.origin==='live_snapshot'));
 const reconstructionRevisions=clone(previous?.reconstructionRevisions??[]);
 const scopeValid=company.status!=='scope_mismatch'&&!company.isManual;
 const currentValid=scopeValid&&company.priceAt&&elapsed(company.priceAt,asOf)>=0&&elapsed(company.priceAt,asOf)<=7&&numeric(company.price)&&company.price>0&&prices.currency==='USD'&&['ready','cached'].includes(prices.status);
 let currentSnapshot=null;
 if(currentValid&&keys.some(key=>numeric(company[key]))){
  currentSnapshot={date:company.priceAt,asOf,priceAt:company.priceAt,price:company.price,pe:company.pe??null,ps:company.ps??null,fcfYield:company.fcfYield??null,origin:'live_snapshot',recordedAt:recordedAt??asOf,peBasis:company.peBasis??'market_cap_over_ttm_income',ttmEnd:company.ttmEnd,sourceUrl:company.sourceUrl,priceVersion:company.priceVersion,priceFetchedAt:company.priceFetchedAt,epsInputs:company.dilutedEps?.inputs??[],financeVersions:clone(company.fields??{})};
  const latest=snapshots.filter(p=>(p.priceAt??p.date)===company.priceAt&&visibleAt(p,asOf,recordedAt)).sort((a,b)=>String(snapshotTime(a)).localeCompare(String(snapshotTime(b)))).at(-1);
  if(!latest||snapshotSignature(latest)!==snapshotSignature(currentSnapshot))snapshots.push(clone(currentSnapshot));
 }
 const visible=snapshots.filter(p=>visibleAt(p,asOf,recordedAt)).sort((a,b)=>String(snapshotTime(a)).localeCompare(String(snapshotTime(b))));
 const firstKnown=new Map();
 for(const p of visible)for(const key of keys)for(const [name,input] of financialInputs(p,key)){
  if(!input)continue;
  const identity=inputKey(name,input);if(!identity)continue;
  const fetched=input.fetchedAt&&input.fetchedAt<=snapshotTime(p)?input.fetchedAt:snapshotTime(p);
  if(!firstKnown.has(identity)||fetched<firstKnown.get(identity))firstKnown.set(identity,fetched);
 }
 for(const p of previous?.observations??[]){
  if(p.origin==='issuer_release_reconstruction'&&p.date<=asOf&&visibleAt(p,asOf,recordedAt))observations.set(p.priceAt??p.date,clone(p));
 }
 if(scopeValid&&['ready','cached'].includes(prices.status)&&prices.currency==='USD'){
  for(const quote of prices.observations??[]){
   if(quote.date>asOf||!numeric(quote.close)||quote.close<=0)continue;
   const eps=disclosedDilutedEps(market,entity,quote.date,{afterPublicationDay:true});
   if(!(eps?.value>0))continue;
   const prior=observations.get(quote.date);
   const point={date:quote.date,priceAt:quote.date,price:quote.close,pe:quote.close/eps.value,ps:null,fcfYield:null,origin:'issuer_release_reconstruction',recordedAt:recordedAt??asOf,peBasis:'price_over_reported_diluted_eps',ttmEnd:eps.periodEnd,publishedAt:eps.publishedAt,eps:eps.value,epsInputs:eps.inputs,priceVersion:prices.version??null,sourceUrl:prices.sourceUrl??null};
   if(prior&&(prior.price!==point.price||prior.pe!==point.pe||stable(prior.epsInputs)!==stable(point.epsInputs)))reconstructionRevisions.push(clone(prior));
   observations.set(quote.date,point);
  }
 }
 for(const p of visible){
  const priceAt=p.priceAt??p.date;if(priceAt>asOf)continue;
  const metricAvailability=Object.fromEntries(keys.map(key=>[key,snapshotAvailability(p,key,firstKnown)]));
  if(!keys.some(key=>numeric(p[key])&&metricAvailability[key].eligible))continue;
  const prior=observations.get(priceAt);const metricSources={};const values={};
  for(const key of keys){
   if(metricAvailability[key].eligible){
    values[key]=p[key]??null;
    metricSources[key]={origin:'live_snapshot',snapshotIndex:snapshots.indexOf(p)};
   }else if(prior?.price===p.price&&numeric(prior[key])){
    // A newly disclosed denominator must not erase the ratio that really was
    // known on this quote day. Keep its own provenance, not the new fields.
    values[key]=prior[key];metricAvailability[key]=prior.metricAvailability?.[key]??{eligible:true,availableAt:prior.date};
    metricSources[key]=prior.metricSources?.[key]??{origin:prior.origin,recordedAt:prior.recordedAt,epsInputs:prior.epsInputs,priceVersion:prior.priceVersion};
   }else values[key]=null;
  }
  observations.set(priceAt,{...clone(p),date:priceAt,priceAt,metricAvailability,metricSources,...values});
 }
 if(currentSnapshot){
  currentSnapshot.metricAvailability=Object.fromEntries(keys.map(key=>[key,snapshotAvailability(currentSnapshot,key,firstKnown)]));
  const excluded=keys.filter(key=>numeric(currentSnapshot[key])&&!currentSnapshot.metricAvailability[key].eligible);
  currentSnapshot.historyEligible=excluded.length===0;
  currentSnapshot.excludedMetrics=excluded;
  currentSnapshot.exclusionReason=excluded.length?'当前估值使用了报价日之后才公开或首次留存的财务版本；保留当前结果，历史曲线不倒填该版本。':null;
 }
 const rows=[...observations.values()].sort((a,b)=>a.date.localeCompare(b.date));
 const metrics=Object.fromEntries(keys.map(key=>[key,distribution(rows,key,currentValid?company[key]:null)]));
 const issuerCount=rows.filter(p=>p.origin==='issuer_release_reconstruction').length;
 return {version:VALUATION_HISTORY_VERSION,status:rows.length?['ready','cached'].includes(prices.status)?prices.status==='cached'||market?.finance?.[entity]?.epsHistory?.status==='cached'?'cached':Object.values(metrics).some(m=>m.count>=60)?'available':'accumulating':'cached':'insufficient_history',count:rows.length,from:rows[0]?.date??null,to:rows.at(-1)?.date??null,metrics,observations:rows,reconstructedCount:issuerCount,snapshotCount:rows.length-issuerCount,snapshots,recordedSnapshotCount:snapshots.length,reconstructionRevisions,currentSnapshot,method:(issuerCount?'P/E按各日已公布且连续四季的GAAP稀释每股收益重建；公告未提供精确时刻时从公告次日起使用。季度EPS分母和四舍五入口径不同于全年EPS；按已知拆股统一分母。':'从真实留存之日起积累估值。')+'历史按实际行情日期去重；重复采集不增加样本。原始快照与修订另行保留，未取得发布日期时以该财务版本首次留存时间为边界，不倒填旧行情。',note:'至少60个不同的有效行情日期才展示该项历史分位。分位只描述已覆盖区间中的相对位置，不代表合理价值或未来回报。数据源失败时保留最后成功观测。'};
}
