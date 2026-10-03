// Legacy events without capacityKind can coexist with their enriched copy.
// Collapse only unambiguous duplicates; distinct capacity bases remain visible.
export function uniqueProjectEvents(events){
 const groups=new Map();
 for(const event of events){
  const key=JSON.stringify([event.projectId,event.date,event.status,event.sourceUrl,event.capacityMw??null]);
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(event);
 }
 return [...groups].flatMap(([group,rows])=>{
  const typed=rows.filter(row=>row.capacityKind),kinds=new Set(typed.map(row=>row.capacityKind));
  const candidates=kinds.size===1?typed:rows,unique=new Map();
  for(const row of candidates){const key=group+':'+(row.capacityKind??'unknown');if(!unique.has(key))unique.set(key,{...row,eventKey:key});}
  return [...unique.values()];
 }).sort((a,b)=>b.date.localeCompare(a.date));
}
