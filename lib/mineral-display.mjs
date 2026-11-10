import {selectRange} from './calculations.mjs';

export const mineralIds = ['COPPER','ALUMINUM','IRON_ORE','NICKEL','GOLD','SILVER'];
export const mineralAnchors = {copper:'COPPER',aluminum:'ALUMINUM','iron-ore':'IRON_ORE',nickel:'NICKEL',gold:'GOLD',silver:'SILVER'};
export const dailyMinerals = {COPPER:'MKT_COPPER',ALUMINUM:'MKT_ALUMINUM',IRON_ORE:'MKT_IRON_ORE',GOLD:'MKT_GOLD',SILVER:'MKT_SILVER'};
const validSelection = selected => mineralIds.filter(id => Array.isArray(selected) && selected.includes(id));
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Explicit frequency always wins, including a daily link to a monthly-only metal. */
export function mineralRoute(href) {
 const url = new URL(href || '/', 'https://local.invalid');
 let anchor = '';
 try { anchor = decodeURIComponent(url.hash.slice(1)); } catch { /* Unknown fragments are ignored. */ }
 const anchorId = mineralAnchors[anchor];
 const requestedSeries = url.searchParams.get('series');
 const dailyId = mineralIds.find(id => dailyMinerals[id] === requestedSeries);
 const monthlyId = mineralIds.includes(requestedSeries) ? requestedSeries : null;
 const list = url.searchParams.has('minerals') ? validSelection(url.searchParams.get('minerals').split(',')) : null;
 const selected = anchorId ? [anchorId] : list ?? (dailyId ? [dailyId] : monthlyId ? [monthlyId] : null);
 const requestedMode = url.searchParams.get('commodityMode');
 const basis = ['market','monthly'].includes(requestedMode) ? requestedMode : dailyId ? 'market' : monthlyId && !anchorId ? 'monthly' : 'market';
 return {basis,selected,explicit:Boolean(anchorId || requestedSeries && (dailyId || monthlyId) || list || ['market','monthly'].includes(requestedMode))};
}

export function mineralSelectionUrl(href, {basis,selected}) {
 const url = new URL(href, 'https://local.invalid'), ids = validSelection(selected);
 url.searchParams.set('commodityMode', basis === 'monthly' ? 'monthly' : 'market');
 url.searchParams.set('minerals', ids.join(','));
 if (ids.length === 1) {
  url.searchParams.set('series', basis === 'monthly' ? ids[0] : dailyMinerals[ids[0]] ?? ids[0]);
  url.hash = Object.keys(mineralAnchors).find(key => mineralAnchors[key] === ids[0]);
 } else { url.searchParams.delete('series'); url.hash = 'mineral-resources'; }
 return url.pathname + url.search + url.hash;
}

/** Record an implicit initial selection before pushing a user change, so Back restores it. */
export function mineralNavigation(href, previous, next) {
 const url = new URL(href, 'https://local.invalid');
 const before = mineralSelectionUrl(href, previous), after = mineralSelectionUrl(href, next);
 if (before === after) return url.pathname + url.search + url.hash === before ? [] : [{method:'replaceState',url:before}];
 const steps = [];
 if (mineralRoute(href).selected === null) steps.push({method:'replaceState',url:before});
 steps.push({method:'pushState',url:after});
 return steps;
}

export function mineralDisplay(series, selected, {basis='market',range='1',view='raw'} = {}) {
 const ids = validSelection(selected);
 const entries = ids.map(id => {
  const seriesId = basis === 'monthly' ? id : dailyMinerals[id] ?? null;
  const source = seriesId ? series?.[seriesId] : undefined;
  const points = (source?.observations ?? []).filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.date)).map(point => ({date:point.date,value:finite(point.value)?point.value:null})).sort((a,b)=>a.date.localeCompare(b.date));
  const valid = points.filter(point => point.value !== null), latest = valid.at(-1) ?? null, previous = valid.at(-2) ?? null;
  return {id,seriesId,points,latest,previous,lastObservation:points.at(-1)??null,change:latest&&previous&&previous.value>0?(latest.value/previous.value-1)*100:null,monthlyOnly:!seriesId};
 });
 const effectiveView = ids.length === 1 && view !== 'normalized' ? 'raw' : 'normalized';
 let rows = [], emptyReason = null;
 if (!ids.length) emptyReason = 'no_selection';
 else if (entries.some(entry=>entry.monthlyOnly)) emptyReason = 'monthly_only';
 else if (entries.some(entry=>!entry.latest)) emptyReason = 'unavailable';
 else if (effectiveView === 'raw') rows = selectRange(entries[0].points,range).map(point=>({date:point.date,s0:point.value}));
 else {
  const maps = entries.map(entry=>new Map(entry.points.map(point=>[point.date,point.value])));
  const common = entries[0].points.filter(point=>maps.every(map=>finite(map.get(point.date)))).map(point=>({date:point.date,...Object.fromEntries(maps.map((map,index)=>['s'+index,map.get(point.date)]))}));
  const visible = selectRange(common,range), first = visible[0];
  if (!first) emptyReason = 'no_common_dates';
  else if (maps.some((_,index)=>first['s'+index]<=0)) emptyReason = 'nonpositive_base';
  else rows = visible.map(row=>({date:row.date,...Object.fromEntries(maps.map((_,index)=>['s'+index,row['s'+index]/first['s'+index]*100]))}));
 }
 const dates = [...new Set(entries.flatMap(entry=>entry.latest?[entry.latest.date]:[]))].sort();
 const common = effectiveView === 'normalized' && ids.length>1;
 return {ids,entries,effectiveView,rows,emptyReason,common,from:rows[0]?.date??null,to:rows.at(-1)?.date??null,latestFrom:dates[0]??null,latestTo:dates.at(-1)??null};
}
