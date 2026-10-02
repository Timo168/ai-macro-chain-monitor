// Publication and successful ingestion are separate facts. Never infer a
// publication from an HTTP error, a quarter-end, or a new fetch timestamp.
const day=value=>typeof value==='string'?value.slice(0,10):'';
const numeric=point=>typeof point?.value==='number'&&Number.isFinite(point.value)&&!point.isEstimated;
const sameUrl=(a,b)=>{try{const x=new URL(a),y=new URL(b);return x.origin+x.pathname===y.origin+y.pathname;}catch{return false;}};
function currentQuarter(point,release){
 const year=release.fiscalYear,q=release.quarter;
 if(!Number.isInteger(year)||![1,2,3,4].includes(q))return false;
 if(point.fiscalPeriod&&point.fiscalPeriod!==`FY${year} Q${q}`)return false;
 const months={MSFT:[9,12,3,6],ORCL:[8,11,2,5],NVDA:[4,7,10,1],DELL:[4,7,10,1],HPE:[1,4,7,10],MU:[11,2,5,8]};
 const month=months[release.entity]?.[q-1]??q*3;
 const priorYear=(['MSFT','ORCL'].includes(release.entity)&&q<=2)||(['NVDA','DELL'].includes(release.entity)&&q<4)||(release.entity==='MU'&&q===1);
 const expected=Date.UTC(year-(priorYear?1:0),month,0);
 const actual=Date.parse(day(point.periodEnd));
 return Number.isFinite(actual)&&Math.abs(actual-expected)<=14*86400000;
}
export function financialUpdates(discovery={},dataset={},ingested=[],asOf=new Date().toISOString()){
 const today=day(asOf);
 return Object.entries(discovery.entities??{}).map(([entity,source])=>{
  const definitions=(dataset.definitions??[]).filter(def=>def.entity===entity&&def.frequency==='quarterly'&&def.valueType!=='demo');
  const series=definitions.map(def=>dataset.series?.[def.id]).filter(Boolean);
  const points=series.flatMap(item=>item.observations??[]).filter(numeric).filter(point=>day(point.periodEnd)<=today);
  const latestPoint=[...points].sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd))[0];
  const releases=(source.releases??[]).filter(release=>release.publishedAt&&day(release.publishedAt)<=today).sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt));
  const release=releases[0]??null;
  const record=release?ingested.find(item=>item.entity===entity&&sameUrl(item.url,release.url)&&item.fiscalYear===release.fiscalYear&&item.quarter===release.quarter&&day(item.publishedAt)===day(release.publishedAt)&&day(item.periodEnd)<=today&&points.some(point=>point.periodEnd===item.periodEnd&&currentQuarter(point,release))):null;
  // An already verified source observation can establish ingestion even before
  // this release ledger was introduced; matching the publication date alone
  // cannot prove that a different or revised report was parsed.
  const matched=release?points.find(point=>sameUrl(point.sourceUrl,release.url)&&day(point.publishedAt)===day(release.publishedAt)&&currentQuarter(point,release)):null;
  const upcoming=(source.upcoming??[]).map(event=>({...event,releaseAt:event.releaseAt??event.eventAt??null})).filter(event=>day(event.releaseAt)>today).sort((a,b)=>a.releaseAt.localeCompare(b.releaseAt))[0]??null;
  const sourceFailed=['cached','fetch_failed'].includes(source.status)||source.partialFailure;
  const dataCached=series.some(item=>['cached','fetch_failed'].includes(item.status));
  const tracked=definitions.filter(def=>(dataset.series?.[def.id]?.observations??[]).some(numeric));
  const currentMetricIds=release?tracked.filter(def=>(dataset.series?.[def.id]?.observations??[]).some(point=>numeric(point)&&currentQuarter(point,release))).map(def=>def.id):[];
  const pendingMetricIds=release?tracked.filter(def=>!currentMetricIds.includes(def.id)).map(def=>def.id):[];
  let status=release?(record||matched?'collected':'published_pending'):upcoming?'not_published':source.status==='not_configured'?'not_configured':'unknown';
  if(!release&&!upcoming&&sourceFailed)status=points.length?'cached':'fetch_failed';
  return {entity,status,release,upcoming,sourceStatus:source.partialFailure?'partial_failure':source.status??'not_configured',checkedAt:source.checkedAt??null,lastSuccessfulAt:source.lastSuccessfulAt??null,
   sourceUrl:source.indexUrl??source.indexUrls?.[0]??release?.indexUrl??null,error:source.error??null,dataStatus:points.length?(dataCached?'cached':'ready'):'no_observation',
   latestObservationAt:latestPoint?.periodEnd??null,ingestedPeriodEnd:record?.periodEnd??matched?.periodEnd??null,parsedAt:record?.parsedAt??null,currentMetricIds,pendingMetricIds,
   note:status==='published_pending'?'官方已发布新财报，相关数据仍待解析校验；当前图表保留已核验历史。':status==='not_published'?'官方已公告未来发布时间，尚未到该日；发布后的发现与解析分别核验。':sourceFailed?'本次官方发布列表检查失败，无法确认是否有更新；保留上次核验结果。':null};
 }).sort((a,b)=>a.entity.localeCompare(b.entity));
}
