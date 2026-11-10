export const ALERTS_STORAGE_KEY='macro-observatory:alerts:v1';
const MAX_RULES=100,MAX_HISTORY=200,MAX_BYTES=2_000_000;
const kinds=new Set(['above','below','change_up','change_down','consecutive_up','consecutive_down','new_observation']);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=300)=>typeof value==='string'&&value.length<=max;
const timestamp=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const safeId=value=>text(value,200)&&value.length>0&&!['__proto__','constructor','prototype'].includes(value);
const cleanLink=value=>typeof value==='string'&&value.length<=2000&&!/[\u0000-\u0020\u007f\\]/.test(value);
function safeInternalLink(value){
 if(!cleanLink(value)||!value||!/^(?:\/(?!\/)|\?|#|\.\/)/.test(value))return false;
 try{return new URL(value,'https://observer.local/').origin==='https://observer.local';}catch{return false;}
}
function safeSourceLink(value){
 if(!cleanLink(value)||!/^https?:\/\//i.test(value))return false;
 try{const parsed=new URL(value);return ['http:','https:'].includes(parsed.protocol)&&Boolean(parsed.hostname)&&!parsed.username&&!parsed.password;}catch{return false;}
}

export function normalizeAlertRule(value){
 if(!object(value)||!safeId(value.id)||!safeId(value.itemId)||!kinds.has(value.kind)||!finite(value.threshold)||typeof value.enabled!=='boolean'||!timestamp(value.createdAt))return null;
 if(['change_up','change_down'].includes(value.kind)&&value.threshold<0)return null;
 if(value.kind.startsWith('consecutive_')&&(!Number.isInteger(value.threshold)||value.threshold<1||value.threshold>24))return null;
 return {id:value.id,itemId:value.itemId,kind:value.kind,threshold:value.threshold,enabled:value.enabled,createdAt:value.createdAt};
}
const ruleSignature=rule=>JSON.stringify([rule.itemId,rule.kind,rule.threshold]);
// A stable, compact identifier for browser-local deduplication, not a security hash.
function fingerprint(value){let a=2166136261,b=2246822507;for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b^value.charCodeAt(i),3266489909);}return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');}
function unit(item){return item?.unit==='%'||item?.unit==='百分点'?'个百分点':item?.unit??'';}
function number(value){return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:6}).format(value);}

export function alertRuleDescription(rule,item){
 const threshold=number(rule.threshold),valueUnit=item?.unit??'',changeUnit=unit(item);
 return ({above:`高于 ${threshold}${valueUnit}`,below:`低于 ${threshold}${valueUnit}`,change_up:`较上期上升至少 ${threshold}${changeUnit}`,change_down:`较上期下降至少 ${threshold}${changeUnit}`,consecutive_up:`连续 ${threshold} 期上升`,consecutive_down:`连续 ${threshold} 期下降`,new_observation:'发布新一期数据'})[rule.kind]??'规则无效';
}
function eligible(item){
 if(item.alertEligible===false)return item.alertReason||'该指标当前暂不参与提醒';
 if(item.warning)return item.alertReason||`来源待确认：${item.status}`;
 if(item.alertEligible===true)return null;
 // Older catalog versions provide localized statuses instead of an explicit flag.
 if(/缓存|失败|延迟|待核验|待接入|未配置|尚无|未发布|等待|不足|授权|过期|超出|缺值|缺少|估算|代理|cached|failed|pending|unconfigured|not_configured|unavailable|not_published|awaiting|stale|warning/i.test(item.status??''))return `来源待确认：${item.status||'状态未知'}`;
 if(!/^(ready|reviewed|已获取|已核验|日频收盘 · 已获取)/.test(item.status??''))return '来源状态尚未确认';
 return null;
}
function orderedPoints(item){
 const byDate=new Map();
 for(const point of item.points??[]){
  if(!date(point?.date))return {reason:'观测日期无效'};
  const normalized={date:point.date,value:finite(point.value)?point.value:null};
  if(byDate.has(point.date)&&byDate.get(point.date).value!==normalized.value)return {reason:'同一期存在不同数值，等待核验'};
  byDate.set(point.date,normalized);
 }
 return {points:[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date))};
}
function continuous(points,item){
 const frequency=item.frequency??'';
 const monthGap=frequency==='monthly'||frequency==='月度'?1:frequency==='quarterly'||frequency==='季度'?3:frequency==='annual'||frequency==='年度'?12:null;
 for(let i=1;i<points.length;i++){
  if(monthGap!==null){const a=points[i-1].date,b=points[i].date,gap=(Number(b.slice(0,4))-Number(a.slice(0,4)))*12+Number(b.slice(5,7))-Number(a.slice(5,7));if(gap!==monthGap)return false;}
  if(['weekly','周度'].includes(frequency)){const gap=(Date.parse(points[i].date)-Date.parse(points[i-1].date))/86400000;if(gap!==7)return false;}
 }
 return true;
}
function validStateRecord(value){return object(value)&&text(value.configFingerprint,500)&&date(value.date)&&finite(value.value)&&Array.isArray(value.seen)&&value.seen.length<=100&&value.seen.every(id=>typeof id==='string'&&/^[a-f0-9]{16}$/.test(id));}

/** Evaluate only published observations. Fetch times are never part of the signal. */
export function evaluateObserverAlerts(rules,items,previousState={},checkedAt=new Date().toISOString()){
 const nextState={},results=[],events=[],catalog=new Map(items.map(item=>[item.id,item]));
 for(const candidate of rules){
  const rule=normalizeAlertRule(candidate);if(!rule)continue;
  const item=catalog.get(rule.itemId),signature=ruleSignature(rule);
  const old=validStateRecord(previousState[rule.id])&&previousState[rule.id].configFingerprint===signature?previousState[rule.id]:null;
  if(old)nextState[rule.id]=old;
  const result={ruleId:rule.id,itemId:rule.itemId,title:item?.title??rule.itemId,href:item?.href??'',sourceUrl:item?.sourceUrl??null,state:'unavailable',reason:'指标尚未加载',date:null,value:null,change:null,unit:item?.unit??'',fingerprint:null,newMatch:false};
  const finish=(state,reason)=>{result.state=state;result.reason=reason;results.push(result);};
  if(!rule.enabled){finish('disabled','提醒已暂停');continue;}
  if(!item){finish('unavailable','指标尚未加载');continue;}
  const unavailable=eligible(item);if(unavailable){finish('unavailable',unavailable);continue;}
  const ordered=orderedPoints(item);if(ordered.reason){finish('unavailable',ordered.reason);continue;}
  const points=ordered.points,last=points.at(-1);
  if(!last||!finite(last.value)){finish('unavailable',last?'最新一期缺值，等待补齐':'尚无已发布观测');continue;}
  result.date=last.date;result.value=last.value;
  if(old&&last.date<old.date){finish('unavailable','当前来源观测早于上次记录，等待恢复');continue;}
  const headlineDate=date(item.period)?item.period:/^\d{4}-\d{2}-\d{2}T/.test(item.period??'')&&timestamp(item.period)?item.period.slice(0,10):null;
  if(headlineDate&&headlineDate!==last.date){finish('unavailable','展示日期与图表最新观测不一致，等待核验');continue;}
  const required=rule.kind.startsWith('consecutive_')?rule.threshold+1:rule.kind.startsWith('change_')?2:1;
  const selected=points.slice(-required);
  if(selected.length<required){finish('unavailable',`需要 ${required} 期有效观测，当前不足`);continue;}
  if(selected.some(point=>!finite(point.value))||!continuous(selected,item)){finish('unavailable','比较区间有缺期，等待连续数据');continue;}
  if(selected.length>1)result.change=last.value-selected.at(-2).value;
  let matched=false,reason='未达到设定条件';
  const description=alertRuleDescription(rule,item);
  if(rule.kind==='above')matched=last.value>rule.threshold;
  else if(rule.kind==='below')matched=last.value<rule.threshold;
  else if(rule.kind==='change_up')matched=result.change>0&&result.change+Number.EPSILON*Math.max(1,Math.abs(last.value))*8>=rule.threshold;
  else if(rule.kind==='change_down')matched=result.change<0&&-result.change+Number.EPSILON*Math.max(1,Math.abs(last.value))*8>=rule.threshold;
  else if(rule.kind.startsWith('consecutive_'))matched=selected.slice(1).every((point,index)=>rule.kind==='consecutive_up'?point.value>selected[index].value:point.value<selected[index].value);
  else if(rule.kind==='new_observation'){
   matched=Boolean(old&&last.date>old.date);
   reason=old?'尚无新一期数据':'已记录当前观测，等待下一期';
  }
  if(matched)reason=`${last.date}：${description}，最新 ${number(last.value)}${item.unit}`;
  else if(rule.kind!=='new_observation')reason=`${last.date}：${description}，当前未达到`;
  // Values matter: a revised observation can legitimately cross a threshold.
  // Retrieval/version timestamps do not matter: polling cannot create an alert.
  result.fingerprint=fingerprint(JSON.stringify([rule.id,signature,selected.map(point=>[point.date,point.value])]));
  const seen=old?.seen??[];
  result.newMatch=matched&&!seen.includes(result.fingerprint);
  nextState[rule.id]={configFingerprint:signature,date:old&&old.date>last.date?old.date:last.date,value:old&&old.date>last.date?old.value:last.value,seen:result.newMatch?[...seen,result.fingerprint].slice(-100):seen};
  finish(matched?'matched':'unmatched',reason);
  if(result.newMatch)events.push({...result,triggeredAt:checkedAt});
 }
 return {results,events,nextState};
}

function normalizeHistory(value){
 if(!object(value)||!safeId(value.id)||!safeId(value.ruleId)||!safeId(value.itemId)||!text(value.title,500)||!text(value.description,1000)||!date(value.date)||!finite(value.value)||!text(value.unit,100)||!timestamp(value.triggeredAt)||typeof value.read!=='boolean'||!safeInternalLink(value.href)||(value.sourceUrl!=null&&!safeSourceLink(value.sourceUrl)))return null;
 return {id:value.id,ruleId:value.ruleId,itemId:value.itemId,title:value.title,description:value.description,date:value.date,value:value.value,unit:value.unit,triggeredAt:value.triggeredAt,read:value.read,href:value.href,sourceUrl:value.sourceUrl??null};
}
export function parseAlertStorage(raw){
 const empty={rules:[],state:{},history:[]};
 if(raw==null||raw==='')return {status:'empty',...empty};
 if(typeof raw!=='string'||raw.length>MAX_BYTES)return {status:'corrupt',...empty};
 try{
  const value=JSON.parse(raw);
  if(!object(value)||value.version!==1||!Array.isArray(value.rules)||value.rules.length>MAX_RULES||!object(value.state)||Object.keys(value.state).length>MAX_RULES||!Array.isArray(value.history??[])||(value.history??[]).length>MAX_HISTORY)throw Error('shape');
  const rules=value.rules.map(normalizeAlertRule),history=(value.history??[]).map(normalizeHistory);
  if(rules.some(rule=>!rule)||new Set(rules.map(rule=>rule.id)).size!==rules.length||history.some(row=>!row)||new Set(history.map(row=>row.id)).size!==history.length)throw Error('rows');
  const state={};
  for(const [id,row] of Object.entries(value.state)){if(!safeId(id)||!validStateRecord(row))throw Error('state');state[id]={configFingerprint:row.configFingerprint,date:row.date,value:row.value,seen:[...row.seen]};}
  return {status:'ready',rules,state,history};
 }catch{return {status:'corrupt',...empty};}
}
export function serializeAlertStorage(rules,state,history=[]){
 const raw=JSON.stringify({version:1,rules,state,history});
 if(parseAlertStorage(raw).status!=='ready')throw new Error('提醒设置格式无效，未保存');
 return raw;
}
