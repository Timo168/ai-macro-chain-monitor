export const WATCHLIST_STORAGE_KEY='ai-macro-research-attention-v1';
export function normalizeWatchPreferences(value,defaultTargetIds=[]){
 const strings=items=>Array.isArray(items)?[...new Set(items.filter(x=>typeof x==='string'&&x.length<800))].slice(-1000):[];
 return {targetIds:Array.isArray(value?.targetIds)?strings(value.targetIds):defaultTargetIds,entities:strings(value?.entities),readIds:strings(value?.readIds)};
}
export function filterResearchWatchlist(events,{targetIds=[],entities=[],readIds=[],unreadOnly=false}={}){
 const selected=new Set(targetIds),companies=new Set(entities),read=new Set(readIds);
 return (events??[]).filter(event=>(event.targetIds??[]).some(id=>selected.has(id))||(event.entities??[]).some(id=>companies.has(id))).map(event=>({...event,read:read.has(event.id)})).filter(event=>!unreadOnly||!event.read);
}
