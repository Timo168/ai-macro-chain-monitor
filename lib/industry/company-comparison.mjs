import {chartRows} from './engine.mjs';

export const comparisonFamilies=[['capex','资本开支'],['capex_ratio','资本开支 / 收入'],['cloud_revenue','云业务收入'],['cloud_margin','云业务利润率'],['cloud_growth','Azure 披露增速'],['datacenter_revenue','数据中心业务收入'],['backlog','订单余额'],['inventory','库存'],['gross_margin','毛利率'],['operating_cash_flow','营业现金流'],['free_cash_flow','自由现金流']];
const names={MSFT:'微软',GOOG:'谷歌',META:'Meta',AMZN:'亚马逊',ORCL:'甲骨文',NVDA:'英伟达',AMD:'超威半导体',AVGO:'博通',DELL:'戴尔',HPE:'慧与',ANET:'Arista 网络',AMKR:'安靠',ENTG:'英特格',VRT:'维谛',ETN:'伊顿',MU:'美光',TSM:'台积电',ASE:'日月光',ASX:'日月光'};
const colors={MSFT:'#167c68',GOOG:'#5b80b2',META:'#c39848',AMZN:'#9e7cb0',ORCL:'#d38067',NVDA:'#619d48',AMD:'#b15555',AVGO:'#7158a3',DELL:'#386da1',HPE:'#249c8c',ANET:'#ba8b36',AMKR:'#467d87',ENTG:'#92764a',VRT:'#4c8c52',ETN:'#426fa8',MU:'#a263a5',TSM:'#b96b47'};
const palette=['#167c68','#5b80b2','#c39848','#9e7cb0','#d38067','#6b9b9d'];
export const companyName=entity=>names[entity]??entity;
export const companyColor=entity=>colors[entity]??palette[[...String(entity)].reduce((sum,char)=>(sum*31+char.charCodeAt(0))>>>0,0)%palette.length];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export const comparisonRangePreference=value=>typeof value==='string'&&['8q','1','3','5','all'].includes(value);
const canonicalIds={'ORCL|capex':'ORCL.capex','ETN|gross_margin':'ETN.company_gross_margin'};

/** Select one disclosed definition per company, never splice different scopes. */
export function comparisonDefinitions(data,family){
 const groups=new Map();
 for(const definition of data.definitions??[]){
  if(definition.family!==family||definition.frequency!=='quarterly'||!definition.entity)continue;
  const key=definition.entity;
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(definition);
 }
 return [...groups.values()].map(definitions=>{
  const preferred=canonicalIds[`${definitions[0].entity}|${family}`];
  return definitions.find(definition=>definition.id===preferred)
   ??definitions.find(definition=>(data.series?.[definition.id]?.observations??[]).some(point=>finite(point.value)))
   ??definitions[0];
 });
}
export function reportQuarter(date){
 if(typeof date!=='string'||!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(date))return null;
 const parsed=Date.parse(date+'T00:00:00Z');if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==date)return null;
 return date.slice(0,4)+'Q'+Math.ceil(Number(date.slice(5,7))/3);
}
const quarterIndex=quarter=>Number(quarter.slice(0,4))*4+Number(quarter.slice(-1))-1;
const indexQuarter=index=>Math.floor(index/4)+'Q'+(index%4+1);
function quarterMap(rows){
 const map=new Map();
 for(const point of rows){
  const quarter=reportQuarter(point.periodEnd);if(!quarter)continue;
  const previous=map.get(quarter);
  if(previous&&point.version==='missing'&&previous.version!=='missing')continue;
  if(!previous||point.periodEnd>=previous.periodEnd||previous.version==='missing')map.set(quarter,point);
 }
 return map;
}
function currencyFor(definition){
 if(definition.unit==='%')return '';
 if(definition.currency)return definition.currency;
 for(const [part,currency] of [['美元','USD'],['日元','JPY'],['人民币','CNY'],['新台币','TWD'],['欧元','EUR']])if(definition.unit.includes(part))return currency;
 return '';
}
const displayUnit=(definition,mode)=>mode==='normalized'?'起点＝100':mode==='value'?definition.unit:definition.unit==='%'?'个百分点':'%';
export function buildCompanyComparison(data,{family='capex',entities=[],mode='value',range='8q'}={}){
 const available=comparisonDefinitions(data,family);
 const definitions=available.filter(definition=>entities.includes(definition.entity));
 const maps=definitions.map(definition=>quarterMap(chartRows(definition,data.series?.[definition.id]?.observations??[],{range:'all',mode:mode==='yoy'?'yoy':mode==='qoq'?'qoq':'value'})));
 const originalMaps=definitions.map(definition=>quarterMap(data.series?.[definition.id]?.observations??[]));
 const observedQuarters=[...new Set(maps.flatMap(map=>[...map.keys()]))].sort();
 let allQuarters=[];
 if(observedQuarters.length){const start=quarterIndex(observedQuarters[0]),end=quarterIndex(observedQuarters.at(-1));allQuarters=Array.from({length:end-start+1},(_,index)=>indexQuarter(start+index));}
 const availableRanges=['all',...(['8q','1','3','5'].filter(value=>allQuarters.length>=(value==='8q'?8:Number(value)*4)))];
 const effectiveRange=availableRanges.includes(range)?range:'all';
 const count=effectiveRange==='all'?allQuarters.length:effectiveRange==='8q'?8:Number(effectiveRange)*4;
 const quarters=allQuarters.slice(-count||undefined);
 const commonBase=mode==='normalized'?quarters.find(quarter=>definitions.length>0&&maps.every(map=>finite(map.get(quarter)?.value)&&map.get(quarter).value>0))??null:null;
 const rows=quarters.map(quarter=>{
  const values={},points={},originalValues={};
  definitions.forEach((definition,index)=>{
   const point=maps[index].get(quarter)??null;let value=finite(point?.value)?point.value:null;
   if(mode==='normalized')value=commonBase&&quarter>=commonBase&&value!==null?value/maps[index].get(commonBase).value*100:null;
   values[definition.id]=value;points[definition.id]=point;originalValues[definition.id]=finite(originalMaps[index].get(quarter)?.value)?originalMaps[index].get(quarter).value:null;
  });
  return {quarter,values,points,originalValues};
 });
 const commonQuarters=definitions.length?rows.filter(row=>definitions.every(definition=>finite(row.values[definition.id]))).map(row=>row.quarter):[];
 const units=[...new Set(definitions.map(definition=>displayUnit(definition,mode)))];
 const bases=[...new Set(definitions.map(definition=>mode==='value'?`${definition.unit}|${currencyFor(definition)}`:displayUnit(definition,mode)))];
 const compatible=bases.length<=1;
 const coverage=definitions.map(definition=>({id:definition.id,entity:definition.entity,name:companyName(definition.entity),presentQuarters:rows.filter(row=>finite(row.values[definition.id])).map(row=>row.quarter),missingQuarters:rows.filter(row=>!finite(row.values[definition.id])).map(row=>row.quarter)}));
 return {family,mode,range:effectiveRange,availableRanges,available,definitions,rows,quarters,commonQuarters,commonBase,latestQuarter:quarters.at(-1)??null,defaultQuarter:commonQuarters.at(-1)??quarters.at(-1)??null,compatible,unit:compatible?units[0]??'—':'不同单位',coverage};
}
export function comparisonSnapshot(model,quarter,data){
 const row=model.rows.find(row=>row.quarter===quarter);
 const entries=model.definitions.map((definition,index)=>{
  const value=row?.values[definition.id]??null,originalValue=row?.originalValues[definition.id]??null,point=row?.points[definition.id]??null;
  let missingReason=null;
  if(!finite(value))missingReason=model.mode==='normalized'&&!model.commonBase?'缺少共同正值基期':model.mode==='normalized'&&finite(originalValue)&&quarter<model.commonBase?'早于共同起点':finite(originalValue)&&['yoy','qoq'].includes(model.mode)?'缺少可比基期':'该季度缺少观测';
  const series=data?.series?.[definition.id];
  const sourceStatus=series?.status==='cached'&&series.error?'获取失败 · 展示缓存':({ready:'已获取',reviewed:'官方核验',cached:'展示缓存',fetch_failed:'获取失败',not_configured:'未配置来源',authorization_required:'待授权',pending:'待接入',no_observation:'暂无观测',not_published:'尚未发布'}[series?.status??'pending']??'待核验');
  const status=missingReason?missingReason+(sourceStatus==='已获取'?'':' · '+sourceStatus):sourceStatus;
  return {definition,entity:definition.entity,name:companyName(definition.entity),color:companyColor(definition.entity),value:finite(value)?value:null,originalValue,point,missingReason,status,sourceStatus,index};
 });
 return model.compatible?entries.sort((a,b)=>a.value===null?(b.value===null?a.index-b.index:1):b.value===null?-1:b.value-a.value||a.index-b.index):entries;
}
export function comparisonBarGeometry(value,values){
 const numbers=values.filter(finite),minimum=Math.min(0,...numbers),maximum=Math.max(0,...numbers),span=maximum-minimum||1;
 const zero=-minimum/span*100;
 if(!finite(value))return {zero,start:zero,width:0};
 const end=(value-minimum)/span*100;
 return {zero,start:Math.min(zero,end),width:Math.abs(end-zero)};
}
export function coreCapexTotal(model,quarter){
 const companies=['MSFT','GOOG','META','AMZN','ORCL'];
 if(model.family!=='capex'||model.mode!=='value'||!model.compatible||model.definitions.length!==5||companies.some(company=>!model.definitions.some(definition=>definition.entity===company)))return null;
 const row=model.rows.find(row=>row.quarter===quarter);
 const missingEntities=model.definitions.filter(definition=>!finite(row?.values[definition.id])).map(definition=>definition.entity);
 return {quarter,unit:model.unit,value:missingEntities.length?null:model.definitions.reduce((sum,definition)=>sum+row.values[definition.id],0),missingEntities};
}
export function quarterSummary(quarters){
 if(!quarters.length)return '';
 const groups=[];let first=quarters[0],last=first;
 for(const quarter of quarters.slice(1)){if(quarterIndex(quarter)===quarterIndex(last)+1){last=quarter;continue;}groups.push(first===last?first:first+'—'+last);first=last=quarter;}
 groups.push(first===last?first:first+'—'+last);
 return groups.join('、');
}
