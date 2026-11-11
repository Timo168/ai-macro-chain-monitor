// Geography is derived from disclosed project locations and state-scoped EIA IDs.
// Company totals, national totals and grid-region load are never assigned to states.
export const STATE_NAMES = Object.freeze({AL:'阿拉巴马州',AK:'阿拉斯加州',AZ:'亚利桑那州',AR:'阿肯色州',CA:'加利福尼亚州',CO:'科罗拉多州',CT:'康涅狄格州',DE:'特拉华州',DC:'哥伦比亚特区',FL:'佛罗里达州',GA:'佐治亚州',HI:'夏威夷州',ID:'爱达荷州',IL:'伊利诺伊州',IN:'印第安纳州',IA:'艾奥瓦州',KS:'堪萨斯州',KY:'肯塔基州',LA:'路易斯安那州',ME:'缅因州',MD:'马里兰州',MA:'马萨诸塞州',MI:'密歇根州',MN:'明尼苏达州',MS:'密西西比州',MO:'密苏里州',MT:'蒙大拿州',NE:'内布拉斯加州',NV:'内华达州',NH:'新罕布什尔州',NJ:'新泽西州',NM:'新墨西哥州',NY:'纽约州',NC:'北卡罗来纳州',ND:'北达科他州',OH:'俄亥俄州',OK:'俄克拉何马州',OR:'俄勒冈州',PA:'宾夕法尼亚州',RI:'罗得岛州',SC:'南卡罗来纳州',SD:'南达科他州',TN:'田纳西州',TX:'得克萨斯州',UT:'犹他州',VT:'佛蒙特州',VA:'弗吉尼亚州',WA:'华盛顿州',WV:'西弗吉尼亚州',WI:'威斯康星州',WY:'怀俄明州'});
const ENGLISH_NAMES = ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','District of Columbia','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming'];
const NAME_CODES = new Map(Object.keys(STATE_NAMES).flatMap((code,index)=>[[ENGLISH_NAMES[index].toLowerCase(),code],[STATE_NAMES[code],code]]));
export const PROJECT_STATUS_LABELS=Object.freeze({announced:'已公告',planning:'规划中',approval:'审批中',construction:'在建',partially_operational:'部分投运',operational:'已投运',delayed:'延迟',cancelled:'取消',unknown:'状态待核实'});
export const CAPACITY_KIND_LABELS=Object.freeze({compute_capacity:'计算容量',data_center_planned_capacity:'数据中心规划容量',operational_data_center_capacity:'已投运数据中心容量',grid_interconnection_capacity:'并网容量',onsite_generation_capacity:'现场发电容量',unspecified_project_capacity:'容量口径未细分'});
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const monthOf=value=>typeof value==='string'&&/^\d{4}-(0[1-9]|1[0-2])(?:-|$)/.test(value)?value.slice(0,7):null;
const byDate=(a,b)=>String(a.periodEnd??a.date).localeCompare(String(b.periodEnd??b.date))||String(a.fetchedAt??'').localeCompare(String(b.fetchedAt??''));
function safeUrl(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}

export function projectStateCode(project){
 if(!project||!['美国','us','usa','united states','united states of america'].includes(String(project.country??'').trim().toLowerCase()))return null;
 const code=String(project.stateCode??'').trim().toUpperCase();
 if(Object.hasOwn(STATE_NAMES,code))return code;
 return NAME_CODES.get(String(project.region??'').trim().toLowerCase())??null;
}

export function projectSourceStatus(project,data){
 const urls=new Set((project?.sourceUrls??[]).map(safeUrl).filter(Boolean));
 const sources=(data?.sources??[]).filter(source=>urls.has(safeUrl(source.url)));
 const ready=sources.some(source=>['ready','reviewed','available'].includes(source.status));
 const failed=sources.some(source=>source.status==='fetch_failed');
 const status=ready?'ready':failed||sources.some(source=>source.status==='cached')?'cached':sources.some(source=>source.status==='not_configured')?'not_configured':'historical';
 return {status,label:ready?'来源已核验':status==='cached'?'历史记录 · 本轮未核验':status==='not_configured'?'来源未配置':'历史公开记录',lastVerifiedAt:project?.lastVerifiedAt??null,checkedAt:sources.map(source=>source.checkedAt??source.fetchedAt).filter(Boolean).sort().at(-1)??null,error:sources.map(source=>source.error).filter(Boolean).join('；')||null,sources};
}

function uniqueProjects(projects){
 const unique=new Map();
 for(const project of projects??[]){if(!project||typeof project.id!=='string'||!project.id)continue;const previous=unique.get(project.id);if(!previous||String(project.lastVerifiedAt??'')>=String(previous.lastVerifiedAt??''))unique.set(project.id,project);}
 return [...unique.values()];
}
function capacityGroups(projects){
 const groups=new Map();
 for(const project of projects){
  if(!finite(project.powerCapacityMw)||project.powerCapacityMw<0||project.isEstimated===true)continue;
  const kind=project.capacityKind||'unspecified_project_capacity';
  const group=groups.get(kind)??{kind,label:CAPACITY_KIND_LABELS[kind]??kind,value:0,count:0,projectIds:[]};
  group.value+=project.powerCapacityMw;group.count++;group.projectIds.push(project.id);groups.set(kind,group);
 }
 return [...groups.values()].sort((a,b)=>a.kind.localeCompare(b.kind));
}
function capacityFor(projects,statuses,kind){
 const values=projects.filter(project=>statuses.includes(project.status)&&project.capacityKind===kind&&finite(project.powerCapacityMw)&&project.powerCapacityMw>=0&&project.isEstimated!==true);
 return values.length?values.reduce((sum,project)=>sum+project.powerCapacityMw,0):null;
}
function observationInMonth(series,month){return (series?.observations??[]).filter(point=>monthOf(point.periodEnd)===month).sort(byDate).at(-1)??null;}
function metricSnapshot(data,id,month){
 const definition=(data?.definitions??[]).find(item=>item.id===id)??null;
 const series=data?.series?.[id]??null;
 const observation=month?observationInMonth(series,month):null;
 const latest=(series?.observations??[]).filter(point=>finite(point.value)).sort(byDate).at(-1)??null;
 const value=finite(observation?.value)?observation.value:null;
 const seriesStatus=series?.status??'not_configured';
 // A missing selected month must not borrow a different month's value.
 const status=value!==null?seriesStatus:['fetch_failed','cached','not_configured','authorization_required'].includes(seriesStatus)?seriesStatus:'no_observation';
 return {metricId:id,definition,series,month,observation,latest,value,unit:definition?.unit??'',sourceName:definition?.sourceName??'EIA',seriesStatus,status,sourceUrl:safeUrl(observation?.sourceUrl??definition?.sourceUrl),fetchedAt:observation?.fetchedAt??series?.fetchedAt??null,lastSuccessfulAt:series?.lastSuccessfulAt??series?.fetchedAt??null,checkedAt:series?.checkedAt??null,error:series?.error??null};
}

export function buildInfrastructureGeography(data,{sector='industrial',month,statuses}={}){
 if(!['industrial','commercial'].includes(sector))throw new Error('Unknown electricity sector');
 const projects=uniqueProjects(data?.projects);
 const byState=new Map();const unlocatedProjects=[];
 for(const project of projects){const code=projectStateCode(project);if(!code){unlocatedProjects.push(project);continue;}const stateProjects=byState.get(code)??[];stateProjects.push(project);byState.set(code,stateProjects);}
 const definitions=(data?.definitions??[]).filter(definition=>new RegExp(`^EIA\\.[A-Z]{2}\\.${sector}$`).test(definition.id)&&Object.hasOwn(STATE_NAMES,definition.id.split('.')[1]));
 const monthSets=definitions.map(definition=>new Set((data?.series?.[definition.id]?.observations??[]).filter(point=>finite(point.value)&&monthOf(point.periodEnd)).map(point=>monthOf(point.periodEnd))));
 const months=[...new Set(monthSets.flatMap(set=>[...set]))].sort().reverse();
 const populated=monthSets.filter(set=>set.size);
 const latestCommonMonth=populated.length?months.find(candidate=>populated.every(set=>set.has(candidate)))??null:null;
 // Compare the latest shared release by default; users can still select newer
 // partial coverage explicitly. Missing selected-period values always stay null.
 const selectedMonth=month===undefined?latestCommonMonth??months[0]??null:monthOf(month);
 const codes=Object.keys(STATE_NAMES).sort();
 const rows=codes.map(code=>{
  const stateProjects=byState.get(code)??[];
  const matchedProjects=statuses===undefined?stateProjects:stateProjects.filter(project=>statuses.includes(project.status));
  const statusCounts=stateProjects.length?Object.fromEntries(Object.keys(PROJECT_STATUS_LABELS).map(status=>[status,stateProjects.filter(project=>project.status===status).length])):{};
  return {code,name:STATE_NAMES[code],projects:stateProjects,matchedProjects,projectCount:stateProjects.length?matchedProjects.length:null,statusCounts,
   constructionCount:stateProjects.length?matchedProjects.filter(project=>project.status==='construction').length:null,
   operationalCount:stateProjects.length?matchedProjects.filter(project=>['operational','partially_operational'].includes(project.status)).length:null,
   constructionMw:capacityFor(matchedProjects,['construction'],'data_center_planned_capacity'),
   operationalMw:capacityFor(matchedProjects,['operational','partially_operational'],'operational_data_center_capacity'),
   capacityGroups:capacityGroups(matchedProjects),capacityUnknownCount:matchedProjects.filter(project=>!finite(project.powerCapacityMw)||!project.capacityKind||project.isEstimated===true).length,
   price:metricSnapshot(data,`EIA.${code}.${sector}`,selectedMonth),sales:metricSnapshot(data,`EIA.${code}.${sector}_sales`,selectedMonth)};
 });
 return {rows,months,month:selectedMonth,sector,latestCommonMonth,unlocatedProjects,summary:{projectCount:projects.length,mappedProjectCount:projects.length-unlocatedProjects.length,unlocatedCount:unlocatedProjects.length,stateCount:byState.size,pricedStateCount:rows.filter(row=>row.price.value!==null).length,constructionCount:rows.reduce((sum,row)=>sum+(row.constructionCount??0),0),operationalCount:rows.reduce((sum,row)=>sum+(row.operationalCount??0),0),latestVerifiedAt:projects.map(project=>project.lastVerifiedAt).filter(Boolean).sort().at(-1)??null}};
}

export function regionalMarketSnapshot(data,{kind='load',date}={}){
 if(!['load','wholesale_price'].includes(kind))throw new Error('Unknown regional energy kind');
 const regions=(data?.regions??[]).map(region=>({region,series:region.series?.find(item=>item.kind===kind)??null}));
 const dateSets=regions.map(({series})=>new Set((series?.observations??[]).filter(point=>finite(point.value)&&typeof point.date==='string').map(point=>point.date)));
 const dates=[...new Set(dateSets.flatMap(set=>[...set]))].sort().reverse();
 const populated=dateSets.filter(set=>set.size);
 const commonDate=populated.length?dates.find(candidate=>populated.every(set=>set.has(candidate)))??null:null;
 const selectedDate=date??commonDate??dates[0]??null;
 const rows=regions.map(({region,series})=>{
  const points=[...(series?.observations??[])].sort(byDate);
  const latest=points.filter(point=>finite(point.value)).at(-1)??null;
  const observation=points.filter(point=>point.date===selectedDate).at(-1)??null;
  const value=finite(observation?.value)?observation.value:null;
  return {id:region.id,name:region.name,series,latest,observation,value,status:series?.status??'not_configured'};
 });
 return {kind,date:selectedDate,dates,commonDate,rows};
}

export function heatExtent(values){const valid=values.filter(finite);return valid.length?{min:Math.min(...valid),max:Math.max(...valid),count:valid.length}:null;}
export function heatLevel(value,values,steps=5){
 if(!finite(value))return null;
 const extent=heatExtent(values);if(!extent)return null;
 if(!Number.isInteger(steps)||steps<1)throw new Error('Heat scale steps must be a positive integer');
 if(extent.max===extent.min)return Math.floor((steps-1)/2);
 return Math.max(0,Math.min(steps-1,Math.floor((value-extent.min)/(extent.max-extent.min)*steps)));
}
export function heatBucket(value,values){return heatLevel(value,values,4);}

// Limit by elapsed periods, not by a count of available rows: a sparse series
// must not stretch "7 days" or "24 months" into a longer historical interval.
export function geographyHistory(points,{frequency,cutoff,limit}={}){
 if(!['monthly','hourly','daily'].includes(frequency))throw new Error('Unknown history frequency');
 const periods=limit??({monthly:24,hourly:168,daily:90}[frequency]);
 if(!Number.isInteger(periods)||periods<1)throw new Error('History limit must be a positive integer');
 const hour=3600000,day=24*hour;
 const monthIndex=value=>{const month=monthOf(value);return month?Number(month.slice(0,4))*12+Number(month.slice(5,7))-1:null;};
 const timestamp=value=>{const result=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(result)?result:null;};
 const unique=new Map();
 for(const point of points??[]){
  if(!point||typeof point.date!=='string'||point.value!==null&&!finite(point.value))continue;
  const at=frequency==='monthly'?monthIndex(point.date):timestamp(point.date);
  if(at===null)continue;
  unique.set(at,{date:frequency==='hourly'?new Date(at).toISOString():point.date,value:point.value,at});
 }
 const sorted=[...unique.values()].sort((a,b)=>a.at-b.at);
 if(!sorted.length)return [];
 let end=cutoff===undefined?sorted.at(-1).at:frequency==='monthly'?monthIndex(cutoff):timestamp(cutoff);
 if(end===null)return [];
 // A day-only cutoff includes that day's observations. Monthly comparisons
 // use calendar months rather than approximating each month as 30 days.
 if(frequency!=='monthly'&&cutoff!==undefined&&/^\d{4}-\d\d-\d\d$/.test(cutoff))end+=day-1;
 const start=frequency==='monthly'?end-periods+1:end-periods*(frequency==='hourly'?hour:day);
 const visible=sorted.filter(point=>(frequency==='monthly'?point.at>=start:point.at>start)&&point.at<=end);
 const result=[];let previous=null;
 for(const point of visible){
  const interval=frequency==='monthly'?1:hour;
  if(previous!==null&&frequency!=='daily'&&point.at-previous>interval){
   const gapAt=previous+interval;
   const gapDate=frequency==='monthly'?`${String(Math.floor(gapAt/12)).padStart(4,'0')}-${String(gapAt%12+1).padStart(2,'0')}-01`:new Date(gapAt).toISOString();
   result.push({date:gapDate,value:null,gap:true});
  }
  result.push({date:point.date,value:point.value,gap:false});previous=point.at;
 }
 return result;
}
