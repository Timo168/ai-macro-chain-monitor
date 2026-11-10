export const energyTopics = [
  {id:'mineral-resources',title:'矿产与金属',anchor:'mineral-resources',aliases:['copper','aluminum','iron-ore','nickel','gold','silver'],views:[]},
  {id:'oil-commodities',title:'原油与商品对比',anchor:'brent',aliases:['commodity-comparison','DCOILBRENTEU'],views:[
    {id:'brent',label:'原油价格',groupId:'brent',anchor:'brent',aliases:['DCOILBRENTEU']},
    {id:'commodity-comparison',label:'商品走势对比',anchor:'commodity-comparison',aliases:[]},
  ]},
  {id:'natural-gas',title:'天然气',anchor:'natural-gas-daily',aliases:['natural-gas-us','DHHNGSP','NATGAS_US'],views:[
    {id:'natural-gas-daily',label:'每日现货价',groupId:'natural-gas-daily',anchor:'natural-gas-daily',aliases:['DHHNGSP']},
    {id:'natural-gas-us',label:'月度均价',groupId:'natural-gas-us',anchor:'natural-gas-us',aliases:['NATGAS_US']},
  ]},
  {id:'electricity',title:'电力',anchor:'electricity-us',aliases:['regional-energy','EIA_US_COMMERCIAL','EIA_ERCOT_NORTH_PRICE','EIA_ERCO_DEMAND','EIA_PJM_WEST_PRICE','EIA_PJM_DEMAND'],views:[
    {id:'electricity-us',label:'全国商业电价',groupId:'electricity-us',anchor:'electricity-us',aliases:['EIA_US_COMMERCIAL']},
    {id:'regional-energy',label:'区域电价与负荷',anchor:'regional-energy',aliases:['EIA_ERCOT_NORTH_PRICE','EIA_ERCO_DEMAND','EIA_PJM_WEST_PRICE','EIA_PJM_DEMAND']},
  ]},
  {id:'coal-aus',title:'动力煤',anchor:'coal-aus',aliases:['COAL_AUS'],views:[]},
];
const anchorOf=value=>{const raw=String(value??'').replace(/^#/,'');try{return decodeURIComponent(raw);}catch{return raw;}};
export function resolveEnergyTopic(anchor,regionalIds=[]){
 const id=anchorOf(anchor);
 if(regionalIds.includes(id))return energyTopics.find(topic=>topic.id==='electricity');
 return energyTopics.find(topic=>topic.id===id||topic.anchor===id||topic.aliases.includes(id));
}
export function resolveEnergyView(topicId,anchor,saved='',regionalIds=[]){
 const topic=energyTopics.find(topic=>topic.id===topicId),id=anchorOf(anchor);
 if(!topic?.views.length)return null;
 const view=topic.views.find(view=>view.id===id||view.anchor===id||view.aliases.includes(id)||(view.id==='regional-energy'&&regionalIds.includes(id)));
 return view??topic.views.find(view=>view.id===saved)??topic.views[0];
}
export function energySelectionUrl(href,anchor){
 const url=new URL(href,'https://dashboard.invalid');
 const id=anchorOf(anchor);url.hash=id;
 // A topic switch clears only selection parameters owned by a different topic.
 const topic=resolveEnergyTopic(id);
 if(topic?.id!=='mineral-resources'){url.searchParams.delete('commodityMode');url.searchParams.delete('minerals');}
 if(topic?.id!=='electricity'){url.searchParams.delete('region');url.searchParams.delete('series');}
 else if(resolveEnergyView('electricity',id)?.id==='electricity-us'){url.searchParams.delete('region');url.searchParams.delete('series');}
 return url.pathname+url.search+url.hash;
}
