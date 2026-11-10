/** Keep cached values readable while preventing unreadable feeds from creating alerts. */
export function applyObserverReadFailures(items,errors=[],macroError=false){
 const failed=prefix=>errors.some(error=>error.startsWith(prefix));
 return items.map(item=>{
  const blocked=item.id.startsWith('regional:')?failed('区域电力'):
   item.kind==='macro'?macroError:
   item.kind==='industry'?failed('产业数据'):
   item.kind==='valuation'?failed('研究与估值'):
   item.kind==='policy'?(failed('央行月末利率')||failed('央行最新决议')):false;
  if(!blocked)return item;
  const hasData=item.points?.some(point=>Number.isFinite(point.value));
  return {...item,status:hasData?'读取失败 · 保留缓存':'读取失败 · 暂无数据',warning:true,
   alertEligible:false,alertReason:'暂时无法读取新数据，等待恢复'};
 });
}
