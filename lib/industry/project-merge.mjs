// The project adapter owns current lifecycle/capacity facts. A later-loaded
// baseline registry is context, not a newer disclosure, even if its file is new.
export function mergeProjectRecords(records){
 const groups=new Map();
 for(const record of records??[]){if(!record?.project?.id)continue;const group=groups.get(record.project.id)??[];group.push(record);groups.set(record.project.id,group);}
 return [...groups.values()].map(group=>{
  const ordered=[...group].sort((a,b)=>Number(Boolean(a.authoritative))-Number(Boolean(b.authoritative))||String(a.project.lastVerifiedAt??'').localeCompare(String(b.project.lastVerifiedAt??'')));
  const merged={};const urls=new Set();const events=new Map();const evidence=new Map();const history=new Map();
  for(const {project} of ordered){
   Object.assign(merged,project);
   for(const url of project.sourceUrls??[])urls.add(url);
   for(const event of project.statusHistory??[])events.set(JSON.stringify([event.date,event.status,event.sourceUrl,event.capacityMw,event.capacityKind]),event);
   for(const item of project.capacityEvidence??[])evidence.set(item.id,item);
   for(const item of project.capacityEvidenceHistory??[])history.set(JSON.stringify([item.id,item.version,item.valueMw,item.upperBoundMw,item.asOfDate]),item);
  }
  merged.sourceUrls=[...urls];
  if(events.size)merged.statusHistory=[...events.values()].sort((a,b)=>a.date.localeCompare(b.date));
  if(evidence.size)merged.capacityEvidence=[...evidence.values()];
  if(history.size)merged.capacityEvidenceHistory=[...history.values()];
  return merged;
 });
}
