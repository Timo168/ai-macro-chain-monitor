export const TRACKING_VERSION='paper-followup-1.1.1';
export const baskets={cloud:['MSFT','GOOG','AMZN','ORCL'],data_centers:['VRT','ETN','DELL'],power:['ETN','VRT'],servers:['DELL','HPE'],accelerators:['NVDA','AMD'],foundry:['TSM'],memory:['MU'],overall:['MSFT','GOOG','AMZN','ORCL','NVDA','AMD','MU','TSM','DELL','HPE','ETN','VRT']};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const day=value=>String(value??'').slice(0,10);
const pct=value=>Math.round(value*10000)/100;
export function addMonths(date,months){const [year,month,d]=date.split('-').map(Number);const first=new Date(Date.UTC(year,month-1+months,1));const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();first.setUTCDate(Math.min(d,last));return first.toISOString().slice(0,10);}
const usablePriceStatus=status=>['ready','cached'].includes(status);
function validPrices(series,asOf){return !usablePriceStatus(series?.status)?[]:(series?.observations??[]).filter(p=>p.date<=asOf&&finite(p.adjustedClose)&&p.adjustedClose>0&&series.currency==='USD').sort((a,b)=>a.date.localeCompare(b.date));}
function priceVersions(names,market){return Object.fromEntries(names.map(symbol=>{const series=market?.prices?.[symbol];return [symbol,{version:series?.version??null,fetchedAt:series?.fetchedAt??null,lastSuccessfulAt:series?.lastSuccessfulAt??series?.fetchedAt??null,checkedAt:series?.checkedAt??null,status:series?.status??'not_configured'}];}));}
function unavailableReason(symbol,status){const labels={fetch_failed:'获取失败，未标记可用缓存',not_configured:'来源未配置',no_observation:'暂无已发布行情',not_published:'尚未发布',unpublished:'尚未发布',unknown:'来源状态不明'};return `${symbol}：${labels[status]??`来源状态 ${status} 不可用于收益计算`}`;}
function cachedReason(versions){const rows=Object.entries(versions).filter(([,source])=>source.status==='cached');if(!rows.length)return null;const sources=rows.slice(0,4).map(([symbol,source])=>`${symbol}（最近成功 ${source.lastSuccessfulAt?day(source.lastSuccessfulAt):'来源未提供时间'}）`).join('、');return `使用缓存行情：${sources}${rows.length>4?` 等 ${rows.length} 个来源`:''}`;}
const gap=(a,b)=>(Date.parse(b)-Date.parse(a))/86400000;
function pricesFor(cohort,market,asOf){
 const names=[...cohort.symbols,cohort.benchmark];
 const versions=priceVersions(names,market);
 const unavailableSources=Object.entries(versions).filter(([,source])=>!usablePriceStatus(source.status)).map(([symbol,source])=>({symbol,...source}));
 if(unavailableSources.length)return {status:'missing_prices',entryAt:cohort.entry?.date??null,priceVersions:versions,unavailableSources,reason:unavailableSources.map(source=>unavailableReason(source.symbol,source.status)).join('；')+'。保留已存档入场日期与期满结果，暂停新的收益计算。'};
 const rows=names.map(symbol=>validPrices(market?.prices?.[symbol],asOf));
 if(rows.some(prices=>!prices.length))return {status:'missing_prices',entryAt:cohort.entry?.date??null,priceVersions:versions,reason:'样本或基准缺少同币种复权收盘行情。'};
 const maps=rows.map(prices=>new Map(prices.map(p=>[p.date,p.adjustedClose])));
 const dates=rows[0].map(p=>p.date).filter(date=>maps.every(map=>map.has(date)));
 // Always wait until a completed session AFTER the archived signal's UTC day.
 // Pin the date once observed. Migrate the original windows without moving entry.
 const entry=cohort.entry?.date??cohort.windows?.find(w=>w.entryAt)?.entryAt??dates.find(date=>date>day(cohort.recordedAt));
 if(!entry)return {status:'awaiting_entry',reason:'等待结论记录日之后的首个共同完整交易日。'};
 if(gap(day(cohort.recordedAt),entry)<=0||gap(day(cohort.recordedAt),entry)>7)return {status:'price_gap',reason:'记录之后七天内缺少共同入场行情，不能把很晚的价格当成入场价。'};
 if(!dates.includes(entry))return {status:'price_gap',entryAt:entry,reason:'已固定的入场日期缺少完整行情，保留原日期，不改用后来的价格。'};
 if(!cohort.entry)cohort.entry={date:entry,lockedAt:asOf,referencePrices:Object.fromEntries(names.map((symbol,i)=>[symbol,{...rows[i].find(p=>p.date===entry),...versions[symbol]}])),basis:'入场日期与首次行情版本固定；后续收益用同一行情版本的期末/入场复权价比值，避免分红或拆股调整混用。'};
 return {entry,maps,dates,versions};
}
function performance(cohort,context,exit,costBps,closed){
 const {entry,maps,dates}=context,path=dates.filter(date=>date>=entry&&date<=exit);
 if(path.some((date,i)=>i>0&&gap(path[i-1],date)>7))return {status:'price_gap',entryAt:entry,reason:'共同价格序列有超过七天的空档，收益与回撤暂停计算。'};
 const cost=costBps/10000;let peak=1,drawdown=0;
 const observations=path.map((date,index)=>{
  const nav=cohort.symbols.reduce((sum,_,i)=>sum+maps[i].get(date)/maps[i].get(entry),0)/cohort.symbols.length;
  const benchmark=maps.at(-1).get(date)/maps.at(-1).get(entry);
  const fees=(1-cost)*(closed&&index===path.length-1?1-cost:1);
  const equity=nav*fees,benchmarkNet=benchmark*fees;peak=Math.max(peak,equity);drawdown=Math.min(drawdown,equity/peak-1);
  return {date,grossReturn:pct(nav-1),netReturn:pct(equity-1),benchmarkReturn:pct(benchmark-1),benchmarkNetReturn:pct(benchmarkNet-1),excessReturn:pct(equity-benchmarkNet),maxDrawdown:pct(drawdown)};
 });
 return {...observations.at(-1),entryAt:entry,exitAt:closed?exit:null,observedAt:exit,observationCount:path.length,observations};
}
function evaluate(cohort,context,asOf,months,costBps){
 if(context.status)return {months,...context};
 const {entry,dates}=context;
 const maturity=addMonths(entry,months);
 if(asOf<maturity)return {months,status:'pending',entryAt:entry,maturityAt:maturity,reason:'跟踪期限尚未届满，暂不显示该期限收益。'};
 const exit=dates.find(date=>date>=maturity);
 if(!exit||gap(maturity,exit)>7)return {months,status:'price_gap',entryAt:entry,maturityAt:maturity,reason:'期末共同完整行情尚不可用，或中间存在过长缺口。'};
 const calculated=performance(cohort,context,exit,costBps,true);
 const {observations,...summary}=calculated;
 return {months,status:'matured',maturityAt:maturity,...summary};
}
function ongoing(cohort,context,asOf,costBps){
 if(context.status)return {...context,evaluatedAt:asOf};
 const final=cohort.windows.find(window=>window.months===6&&window.status==='matured');
 if(final&&final.evaluatedAt!==asOf)return {...final,status:'completed',observedAt:final.exitAt,observations:[],feesApplied:'both_sides',reason:'沿用已经保存的六个月期满结果；原版本未保存每日曲线，不用后来修订行情重绘。'};
 const exit=final?.exitAt??context.dates.at(-1);
 const result=performance(cohort,context,exit,costBps,Boolean(final));
 if(result.status)return {...result,evaluatedAt:asOf,priceVersions:context.versions};
 const stale=!final&&gap(exit,asOf)>7,cacheNote=cachedReason(context.versions),cached=Boolean(cacheNote);
 const validUntil=new Date(Date.parse(exit)+7*86400000).toISOString().slice(0,10);
 const boundary=`共同收盘行情截至 ${exit}，正常跟踪有效至 ${validUntil}。`;
 return {status:final?'completed':stale?'stale_prices':cached?'cached':'ongoing',...result,evaluatedAt:asOf,priceVersions:context.versions,priceValidity:{observedAt:exit,validUntil,maxCalendarGapDays:7,cached,expired:stale},feesApplied:final?'both_sides':'entry_only',reason:stale?`${boundary}已超过七天更新窗口，下列表现只截至该观测日。${cacheNote?cacheNote+'。':''}`:cached?`${cacheNote}。${boundary}`:null};
}
export function buildTracking(ledger,market,{asOf=new Date().toISOString().slice(0,10),costBps=10,prior=null}={}){
 if(!finite(costBps)||costBps<0||costBps>500)throw Error('Invalid transaction cost assumption');
 const cohorts=[];const previous=new Map();
 const retained=new Map((prior?.cohorts??[]).map(cohort=>[cohort.id,cohort]));
 for(const checkpoint of ledger??[]){
  if(checkpoint.origin!=='live_archive'||!checkpoint.recordedAt||!checkpoint.inputHash)continue;
  for(const signal of checkpoint.signals??[]){
   const symbols=baskets[signal.targetId];if(!symbols?.length)continue;
   const key=JSON.stringify([signal.tier,signal.score,signal.stance,signal.factorModelVersion]);
   if(previous.get(signal.targetId)===key)continue;
   previous.set(signal.targetId,key);
   if(signal.tier==='unavailable')continue;
   const id=`${checkpoint.recordId??checkpoint.id+':'+checkpoint.recordedAt}:${signal.targetId}`,saved=retained.get(id);
   const cohort=saved?{...saved}:{id,checkpointId:checkpoint.recordId??checkpoint.id,inputHash:checkpoint.inputHash,recordedAt:checkpoint.recordedAt,targetId:signal.targetId,targetName:signal.targetName,tier:signal.tier,score:signal.score,stance:signal.stance,symbols:[...symbols],benchmark:'QQQ',basketVersion:TRACKING_VERSION,costBpsPerSide:costBps};
   const context=pricesFor(cohort,market,asOf);
   cohort.windows=[1,3,6].map(months=>{
    const archived=saved?.windows?.find(window=>window.months===months);
    if(archived?.status==='matured')return archived;
    const window=evaluate(cohort,context,asOf,months,cohort.costBpsPerSide??costBps);
    return {...window,evaluatedAt:asOf,priceVersions:priceVersions([...cohort.symbols,cohort.benchmark],market)};
   });
   // The final six-month path is immutable just like the completed horizon.
   cohort.progress=saved?.progress?.status==='completed'?saved.progress:ongoing(cohort,context,asOf,cohort.costBpsPerSide??costBps);
   cohorts.push(cohort);
  }
 }
 const byHorizon=[1,3,6].map(months=>{const windows=cohorts.map(c=>c.windows.find(w=>w.months===months)).filter(w=>w?.status==='matured');return {months,maturedCount:windows.length,meanNetReturn:windows.length?pct(windows.reduce((sum,w)=>sum+w.netReturn/100,0)/windows.length):null,meanExcessReturn:windows.length?pct(windows.reduce((sum,w)=>sum+w.excessReturn/100,0)/windows.length):null};});
 return {version:TRACKING_VERSION,asOf,costBpsPerSide:costBps,status:cohorts.length?'tracking':'waiting_for_signal',cohorts,byHorizon,method:'记录之后的首个共同完整交易日入场，入场日期固定；初始等权买入持有，不再平衡；用同一版本的分红与拆股复权价比值，与QQQ同口径比较。跟踪至今只扣买入费用，期满再扣卖出费用；每侧默认10基点。',limitations:['这是假设样本篮子的结论后表现，尚未验证可交易策略，也没有执行真实交易。','正式分与先行分分别标记；负向信号同样观察篮子走势，不把收益取反冒充做空表现。','篮子及成本在开始跟踪时固定，是研究代表样本，不能等同于整个产业或当前持仓。','只使用实际留存快照，不用当前修订数据制造过去的结论；重叠期限样本不是独立观测，历史表现不代表未来。','期满结果与计算时行情版本留存，后续来源修订不会静默改写已报告表现。','跟踪至今是未期满的观察，不能代替1、3、6个月验证；曲线允许来源按分红或拆股重述复权基数，但不移动入场日期，也不混用新旧复权价。']};
}
