export const observerPinsKey='macro-observatory:workspace:v1';
export const observerPinsEvent='macro-observatory:workspace-change';
export const defaultObserverPins=['macro:ICSA','macro:PCEPILFE:yoy','macro:DGS10','macro:DCOILBRENTEU','industry:MSFT.capex','industry:GOOG.cloud_revenue'];

// Keep unknown IDs: a temporarily unavailable dataset must not erase favorites.
export function parseObserverPins(raw){
 if(raw==null)return [...defaultObserverPins];
 try{const parsed=JSON.parse(raw);if(parsed.version!==1||!Array.isArray(parsed.ids))return [...defaultObserverPins];return [...new Set(parsed.ids.filter(id=>typeof id==='string'&&id.length>0&&id.length<200))].slice(0,100);}catch{return [...defaultObserverPins];}
}
export function updateObserverPins(ids,id,action){
 const result=[...new Set(ids)];const index=result.indexOf(id);
 if(action==='toggle')return index<0?[...result,id]:result.filter(value=>value!==id);
 if(index<0)return result;
 const target=action==='up'?index-1:action==='down'?index+1:index;
 if(target>=0&&target<result.length)[result[index],result[target]]=[result[target],result[index]];
 return result;
}
const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[\s_./:—–-]+/g,'');
export function searchObserverItems(items,query,kind='all'){
 const tokens=String(query??'').trim().toLocaleLowerCase().split(/\s+/).map(normalize).filter(Boolean);
 return items.filter(item=>kind==='all'||item.kind===kind).map((item,index)=>{
  const title=normalize(item.title),subtitle=normalize(item.subtitle),id=normalize(item.id),haystack=normalize(`${item.title} ${item.subtitle} ${item.searchTerms} ${item.id}`);
  if(tokens.some(token=>!haystack.includes(token)))return null;
  const score=tokens.reduce((total,token)=>total+(title===token||id===token?100:title.includes(token)?30:subtitle.includes(token)?10:1),0);
  return {item,index,score};
 }).filter(Boolean).sort((a,b)=>b.score-a.score||a.index-b.index).map(row=>row.item);
}
