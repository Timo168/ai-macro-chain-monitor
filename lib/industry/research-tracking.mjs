export const TRACKING_VERSION='paper-followup-1.0.0';
export const baskets={cloud:['MSFT','GOOG','AMZN','ORCL'],data_centers:['VRT','ETN','DELL'],power:['ETN','VRT'],servers:['DELL','HPE'],accelerators:['NVDA','AMD'],foundry:['TSM'],memory:['MU'],overall:['MSFT','GOOG','AMZN','ORCL','NVDA','AMD','MU','TSM','DELL','HPE','ETN','VRT']};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const day=value=>String(value??'').slice(0,10);
const pct=value=>Math.round(value*10000)/100;
export function addMonths(date,months){const [year,month,d]=date.split('-').map(Number);const first=new Date(Date.UTC(year,month-1+months,1));const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();first.setUTCDate(Math.min(d,last));return first.toISOString().slice(0,10);}
function validPrices(series,asOf){return (series?.observations??[]).filter(p=>p.date<=asOf&&finite(p.adjustedClose)&&p.adjustedClose>0&&series.currency==='USD').sort((a,b)=>a.date.localeCompare(b.date));}
const gap=(a,b)=>(Date.parse(b)-Date.parse(a))/86400000;
function evaluate(cohort,market,asOf,months,costBps){
 const names=[...cohort.symbols,cohort.benchmark];
 const rows=names.map(symbol=>validPrices(market?.prices?.[symbol],asOf));
 if(rows.some(prices=>!prices.length))return {months,status:'missing_prices',reason:'样本或基准缺少同币种复权收盘行情。'};
 const maps=rows.map(prices=>new Map(prices.map(p=>[p.date,p.adjustedClose])));
 const dates=rows[0].map(p=>p.date).filter(date=>maps.every(map=>map.has(date)));
 // Always wait until a completed session AFTER the archived signal's UTC day.
 const entry=dates.find(date=>date>day(cohort.recordedAt));
 if(!entry)return {months,status:'awaiting_entry',reason:'等待结论记录日之后的首个共同完整交易日。'};
 if(gap(day(cohort.recordedAt),entry)>7)return {months,status:'price_gap',reason:'记录之后七天内缺少共同入场行情，不能把很晚的价格当成入场价。'};
 const maturity=addMonths(entry,months);
 if(asOf<maturity)return {months,status:'pending',entryAt:entry,maturityAt:maturity,reason:'跟踪期限尚未届满，暂不显示该期限收益。'};
 const exit=dates.find(date=>date>=maturity);
 if(!exit||gap(maturity,exit)>7)return {months,status:'price_gap',entryAt:entry,maturityAt:maturity,reason:'期末共同完整行情尚不可用，或中间存在过长缺口。'};
 const path=dates.filter(date=>date>=entry&&date<=exit);
 if(path.some((date,i)=>i>0&&gap(path[i-1],date)>7))return {months,status:'price_gap',reason:'共同价格序列有超过七天的空档，收益与回撤暂停计算。'};
 const cost=costBps/10000;
 const equity=path.map(date=>cohort.symbols.reduce((sum,_,i)=>sum+maps[i].get(date)/maps[i].get(entry),0)/cohort.symbols.length);
 const benchmark=maps.at(-1).get(exit)/maps.at(-1).get(entry);
 let peak=1,drawdown=0;
 equity.forEach((nav,i)=>{const afterCost=nav*(1-cost)*(i===equity.length-1?1-cost:1);peak=Math.max(peak,afterCost);drawdown=Math.min(drawdown,afterCost/peak-1);});
 const gross=equity.at(-1)-1,net=equity.at(-1)*(1-cost)**2-1,benchmarkNet=benchmark*(1-cost)**2-1;
 return {months,status:'matured',entryAt:entry,maturityAt:maturity,exitAt:exit,grossReturn:pct(gross),netReturn:pct(net),benchmarkReturn:pct(benchmark-1),benchmarkNetReturn:pct(benchmarkNet),excessReturn:pct(net-benchmarkNet),maxDrawdown:pct(drawdown),observationCount:path.length};
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
   cohort.windows=[1,3,6].map(months=>{
    const archived=saved?.windows?.find(window=>window.months===months);
    if(archived?.status==='matured')return archived;
    const window=evaluate(cohort,market,asOf,months,cohort.costBpsPerSide??costBps);
    return {...window,evaluatedAt:asOf,priceVersions:Object.fromEntries([...cohort.symbols,cohort.benchmark].map(symbol=>[symbol,{version:market?.prices?.[symbol]?.version??null,fetchedAt:market?.prices?.[symbol]?.fetchedAt??null,status:market?.prices?.[symbol]?.status??'not_configured'}]))};
   });cohorts.push(cohort);
  }
 }
 const byHorizon=[1,3,6].map(months=>{const windows=cohorts.map(c=>c.windows.find(w=>w.months===months)).filter(w=>w?.status==='matured');return {months,maturedCount:windows.length,meanNetReturn:windows.length?pct(windows.reduce((sum,w)=>sum+w.netReturn/100,0)/windows.length):null,meanExcessReturn:windows.length?pct(windows.reduce((sum,w)=>sum+w.excessReturn/100,0)/windows.length):null};});
 return {version:TRACKING_VERSION,asOf,costBpsPerSide:costBps,status:cohorts.length?'tracking':'waiting_for_signal',cohorts,byHorizon,method:'记录之后的首个共同完整交易日入场；固定等权买入并持有样本篮子，不再平衡；按分红与拆股复权收盘价跟踪，QQQ为同口径基准；每侧默认10基点成本。',limitations:['这是假设样本篮子的结论后表现，尚未验证可交易策略，也没有执行真实交易。','正式分与先行分分别标记；负向信号同样观察篮子走势，不把收益取反冒充做空表现。','篮子及成本在开始跟踪时固定，是研究代表样本，不能等同于整个产业或当前持仓。','只使用实际留存快照，不用当前修订数据制造过去的结论；重叠期限样本不是独立观测，历史表现不代表未来。','期满结果与计算时行情版本留存，后续来源修订不会静默改写已报告表现。']};
}
