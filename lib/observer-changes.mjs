const badStates=new Set(['cached','fetch_failed','delayed','unavailable']);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const safeDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const itemFor=(items,id)=>items.find(item=>item.id===id)||items.find(item=>item.id.startsWith(id+':'));
function record(id,title,scope,points,status,item,extra={}){
 const ordered=Object.entries(points).sort(([a],[b])=>a.localeCompare(b));
 const last=ordered.filter(([,value])=>finite(value)).at(-1);
 return {id,title,scope,points,status,bad:badStates.has(status),period:last?.[0]??'',value:last?.[1]??null,href:item?.href??'',...extra};
}
function numericPoints(observations,industry=false){
 const values={};
 for(const point of observations??[]){
  const key=industry?point.periodEnd:point.date;
  if(safeDate(key))values[key]=finite(point.value)?point.value:null;
 }
 return values;
}
/** Only observation values and explicit source states drive changes, never fetch time. */
export function buildVisitSnapshot(inputs,items=[],observedAt=new Date().toISOString()){
 const records={},scopes=[];
 if(inputs.macro?.generatedAt){
  scopes.push('macro');
  for(const [id,series] of Object.entries(inputs.macro.series??{})){
   const item=itemFor(items,'macro:'+id),status=series.publication?.state==='delayed'?'delayed':series.status??'not_configured';
   records['macro:'+id]=record('macro:'+id,item?.title??id,'macro',numericPoints(series.observations),status,item);
  }
 }
 if(inputs.industry?.generatedAt){
  scopes.push('industry');
  for(const def of inputs.industry.definitions??[]){
   const series=inputs.industry.series?.[def.id];if(!series)continue;
   records['industry:'+def.id]=record('industry:'+def.id,`${def.entity??''} ${def.nameZh}`.trim(),'industry',numericPoints(series.observations,true),series.status,itemFor(items,'industry:'+def.id));
  }
 }
 if(inputs.policyRates?.generatedAt){
  scopes.push('policy');
  for(const series of inputs.policyRates.series??[])records['policy:'+series.id]=record('policy:'+series.id,series.name+' · 月末利率','policy',numericPoints(series.observations),series.status??inputs.policyRates.status,itemFor(items,'policy:'+series.id));
 }
 if(inputs.policyDecisions?.generatedAt){
  scopes.push('decisions');
  for(const decision of inputs.policyDecisions.decisions??[]){
   const id='decision:'+decision.bankId;
   const row=records[id]??record(id,decision.bank+' · 官方决议','decisions',{},inputs.policyDecisions.status,itemFor(items,'policy:'+decision.bankId));
   row.points[decision.announcementDate]=finite(decision.midpoint)?decision.midpoint:null;
   // The range is part of the fact: two different bands can share a midpoint.
   row.bands={...row.bands,[decision.announcementDate]:[decision.lower,decision.upper]};
   row.period=Object.keys(row.points).sort().at(-1)??'';records[id]=row;
  }
  for(const check of inputs.policyDecisions.checks??[]){
   const id='source:'+check.bankId;
   records[id]=record(id,check.bank+' · 官方来源','decisions',{},check.status,itemFor(items,'policy:'+check.bankId));
  }
 }
 return {version:1,observedAt,scopes,records};
}
export function validVisitSnapshot(value){
 if(!value||value.version!==1||!safeDate(value.observedAt)||!Array.isArray(value.scopes)||!value.records||typeof value.records!=='object'||Array.isArray(value.records))return false;
 const rows=Object.values(value.records);if(rows.length>3000)return false;
 return rows.every(row=>row&&typeof row.id==='string'&&typeof row.scope==='string'&&row.points&&typeof row.points==='object'&&!Array.isArray(row.points)&&Object.keys(row.points).length<=50000);
}
export function compareVisitSnapshots(previous,current){
 if(!validVisitSnapshot(previous))return [];
 const events=[];
 for(const row of Object.values(current.records??{})){
  if(!previous.scopes.includes(row.scope))continue; // First successful load of a module is a baseline, not a new publication.
  const old=previous.records[row.id];
  const add=(kind,description,count=1)=>events.push({id:row.id+':'+kind,kind,title:row.title,scope:row.scope,href:row.href,period:row.period,description,count});
  if(!old){if(Object.values(row.points).some(finite))add('new','新增可观察系列；此前没有对比记录');continue;}
  const priorDates=Object.keys(old.points).sort(),latest=priorDates.at(-1)??'';
  const newDates=Object.keys(row.points).filter(date=>finite(row.points[date])&&!finite(old.points[date]));
  const added=newDates.filter(date=>date>latest).length,backfill=newDates.length-added;
  const revised=Object.keys(row.points).filter(date=>Object.hasOwn(old.points,date)&&row.points[date]!==old.points[date]&&!(old.points[date]==null&&finite(row.points[date]))).length;
  const removed=priorDates.filter(date=>!Object.hasOwn(row.points,date)).length;
  const bandsChanged=Object.keys(row.bands??{}).filter(date=>old.bands?.[date]&&JSON.stringify(old.bands[date])!==JSON.stringify(row.bands[date])).length;
  if(added)add('new',`新增 ${added} 期观测；最新观测 ${row.period}`,added);
  if(backfill)add('revision',`补齐 ${backfill} 期历史观测`,backfill);
  if(revised||removed||bandsChanged)add('revision',`${revised||bandsChanged} 期历史数值修订${removed?`，${removed} 期从当前来源版本移除`:''}`,Math.max(revised,bandsChanged)+removed);
  if(row.bad&&!old.bad)add('failure',`来源状态由 ${stateLabel(old.status)} 变为 ${stateLabel(row.status)}；已有值仍保留`);
  if(!row.bad&&old.bad&&['ready','reviewed'].includes(row.status))add('recovery',`来源已恢复：${stateLabel(row.status)}`);
 }
 return events.sort((a,b)=>(a.kind==='failure'?-1:0)-(b.kind==='failure'?-1:0)||b.period.localeCompare(a.period)||a.title.localeCompare(b.title));
}
export function mergeVisitBaseline(previous,current){
 // A failed request must not delete the last comparison baseline for that module.
 const records={};
 for(const [id,row] of Object.entries(previous?.records??{}))if(!current.scopes.includes(row.scope))records[id]=row;
 return {...current,scopes:[...new Set([...(previous?.scopes??[]),...current.scopes])],records:{...records,...current.records}};
}
export function stateLabel(state){return ({ready:'已获取',reviewed:'已核验',cached:'获取失败，展示缓存',fetch_failed:'获取失败',delayed:'来源发布延迟',unavailable:'来源暂不可用',not_configured:'来源未配置',pending:'待接入',no_observation:'尚未发布',not_published:'尚未发布',awaiting_release:'等待发布',authorization_required:'待授权'})[state]??state;}
