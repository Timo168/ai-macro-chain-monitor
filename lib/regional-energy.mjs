const STATES=new Set(['available','cached','fetch_failed','not_published','not_configured']);
const DAY=86400000;
export const REGIONAL_ENERGY_STATES={available:'已获取',cached:'使用缓存',fetch_failed:'获取失败',not_published:'尚未发布',not_configured:'来源未配置'};
export function regionalSourceUrl(value){
 try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
function validDate(value,hourly){
 if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return false;
 if(hourly)return /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value);
 return /^\d{4}-\d\d-\d\d$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
}
export function parseRegionalEnergy(value){
 if(!value||typeof value!=='object'||!Array.isArray(value.regions)||!value.regions.length)throw Error('区域电力文件格式不正确');
 const regionIds=new Set(),seriesIds=new Set();
 const regions=value.regions.map(region=>{
  if(!region||typeof region.id!=='string'||regionIds.has(region.id)||typeof region.name!=='string'||!Array.isArray(region.series))throw Error('区域定义不正确');
  regionIds.add(region.id);
  const series=region.series.map(item=>{
   if(!item||typeof item.id!=='string'||seriesIds.has(item.id)||!['wholesale_price','load'].includes(item.kind)||!['daily','hourly'].includes(item.frequency)||!STATES.has(item.status)||typeof item.unit!=='string'||!Array.isArray(item.observations))throw Error('区域指标定义不正确');
   seriesIds.add(item.id);
   const byDate=new Map();
   for(const point of item.observations){
    if(!point||!validDate(point.date,item.frequency==='hourly')||point.value!==null&&(typeof point.value!=='number'||!Number.isFinite(point.value)))throw Error('区域观测格式不正确');
    const date=item.frequency==='hourly'?new Date(point.date).toISOString():point.date;
    if(byDate.has(date))throw Error('区域观测日期重复');
    byDate.set(date,{...point,date,value:point.value});
   }
   let timeZone=item.timeZone||region.timeZone||'UTC';try{new Intl.DateTimeFormat('zh-CN',{timeZone}).format(new Date(0));}catch{timeZone='UTC';}
   return {...item,name:typeof item.name==='string'?item.name:typeof item.title==='string'?item.title:item.id,timeZone,sourceUrl:regionalSourceUrl(item.sourceUrl),dataUrl:regionalSourceUrl(item.dataUrl),exportAllowed:item.exportAllowed===true,observations:[...byDate.values()].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date))};
  });
  return {...region,series};
 });
 return {...value,regions};
}
export function regionalStatus(series,readFailed=false){
 const hasData=!!series?.observations?.some(point=>Number.isFinite(point.value));
 const status=readFailed?(hasData?'cached':'fetch_failed'):series?.status??'not_configured';
 const delayed=status==='available'&&series?.freshness==='delayed';
 return {status:delayed?'delayed':status,label:delayed?'来源观测滞后':REGIONAL_ENERGY_STATES[status]??'状态待核对',warning:status!=='available'||delayed,detail:readFailed?'页面读取失败，保留上次已加载数据。':series?.lastFetchStatus==='fetch_failed'&&hasData?'本次来源检查失败，保留最后成功观测。':delayed?`最新观测已超出来源通常更新周期，最后有效观测 ${series.latestObservationAt??series.observations?.filter(point=>Number.isFinite(point.value)).at(-1)?.date??'尚无记录'}。`:series?.error??''};
}
export function regionalRanges(series){
 const points=series?.observations??[],span=points.length?Date.parse(points.at(-1).date)-Date.parse(points[0].date):0;
 const choices=series?.frequency==='hourly'?[['1','24 小时'],['7','7 天'],['30','30 天']]:[['30','30 天'],['90','90 天'],['365','1 年']];
 return [...choices.map(([value,label])=>({value,label,available:span>=Number(value)*DAY-(series.frequency==='hourly'?3600000:0)})),{value:'all',label:'全部',available:true}];
}
export function regionalWindow(series,range){
 const points=series?.observations??[];if(range==='all'||!points.length)return points;
 const numeric=Number(range);if(!Number.isFinite(numeric)||numeric<=0)return points;
 const start=Date.parse(points.at(-1).date)-numeric*DAY;
 return points.filter(point=>Date.parse(point.date)>start);
}
export function regionalChartRows(points,frequency){
 const rows=[];let previous=null;
 for(const point of points){
  const timestamp=Date.parse(point.date);
  // A null plotting separator exposes a missing hour without inventing a value.
  if(frequency==='hourly'&&previous!==null&&timestamp-previous>3600000)rows.push({date:new Date(previous+3600000).toISOString(),value:null,gap:true});
  rows.push({...point,gap:false});previous=timestamp;
 }
 return rows;
}
export function regionalStats(points,frequency){
 const valid=points.filter(point=>Number.isFinite(point.value));const first=valid[0]??null,last=valid.at(-1)??null,previous=valid.at(-2)??null;
 const latestMissing=!!points.length&&points.at(-1).value==null;
 const adjacent=previous&&last&&(frequency!=='hourly'||Date.parse(last.date)-Date.parse(previous.date)===3600000);
 return {first,last,latestMissing,previousChange:adjacent&&!latestMissing?last.value-previous.value:null,rangeChange:first&&last?last.value-first.value:null};
}
export function regionalDate(date,frequency,timeZone='Asia/Shanghai',short=false){
 if(!date||!Number.isFinite(Date.parse(date)))return '尚无观测';
 if(frequency!=='hourly')return date.slice(0,10);
 return new Intl.DateTimeFormat('zh-CN',{timeZone,year:short?undefined:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZoneName:short?undefined:'shortOffset'}).format(new Date(date));
}
export function regionalNavigation(data,search,hash){
 const query=new URLSearchParams(search);if(query.has('page')&&query.get('page')!=='materials')return null;
 let anchor='';try{anchor=decodeURIComponent(hash.replace(/^#/,''));}catch{return null;}
 const anchored=data?.regions?.find(region=>region.series.some(series=>series.id===anchor));
 if(anchored)return {regionId:anchored.id,seriesId:anchor};
 const region=data?.regions?.find(region=>region.id===query.get('region'));
 if(region)return {regionId:region.id,seriesId:null};
 return null;
}
function csvCell(value){const text=String(value??'');return '"'+(/^[=+@\-\t\r]/.test(text)&&typeof value!=='number'?'\''+text:text).replaceAll('"','""')+'"';}
export function regionalCsv(series,points){
 if(series.exportAllowed!==true)throw Error('此来源尚未开放导出');
 const rows=[['观测日期／小时结束时刻',series.name+' ('+series.unit+')','观测时区'],...points.filter(point=>!point.gap).map(point=>[point.date,point.value,series.frequency==='hourly'?'UTC':series.timeZone]),[],['来源',series.sourceName,series.sourceUrl],['原始文件',series.dataUrl],['口径',series.methodology],['成功获取',series.fetchedAt??series.lastSuccessAt],['版本',series.version],['状态',series.status]];
 return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
}
