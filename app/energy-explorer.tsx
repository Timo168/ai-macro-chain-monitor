"use client";
import {lazy,Suspense,useEffect,useState} from 'react';
import {type Dataset} from '@/lib/data';
import {groups} from '@/lib/groups';
import {macroExplorerSummary} from '@/lib/macro-summary';
import {energyTopics,resolveEnergyTopic,resolveEnergyView,energySelectionUrl,type EnergyTopic} from '@/lib/energy-panels.mjs';
import {rememberReadingView} from '@/lib/reading-view.mjs';
import PanelExplorer,{type PanelExplorerItem} from './panel-explorer';
import ChartCard from './chart-card';
import {MineralResourceChart,CommodityComparison} from './commodity-charts';
import {useObserver} from './observer-context';
import {useSavedView,textPreference} from './use-saved-view';
import {revealPanel} from './panel-disclosure';
import './energy-explorer.css';

const RegionalEnergy=lazy(()=>import('./regional-energy'));
const groupFor=(id:string)=>groups.find(group=>group.id===id)!;
function useEnergyAnchor(){
 const [hash,setHash]=useState(()=>typeof location==='undefined'?'':location.hash);
 useEffect(()=>{const read=()=>setHash(location.hash);read();window.addEventListener('hashchange',read);window.addEventListener('popstate',read);return()=>{window.removeEventListener('hashchange',read);window.removeEventListener('popstate',read);};},[]);
 return hash;
}
function EnergyTopicPanel({topic,data,range,regionalIds,legacySelection}:{topic:EnergyTopic;data:Dataset;range:string;regionalIds:string[];legacySelection:string}){
 const hash=useEnergyAnchor();
 const [saved,setSaved]=useSavedView('energy:view:'+topic.id,'',textPreference);
 const legacyView=resolveEnergyView(topic.id,legacySelection,'',regionalIds);
 const active=resolveEnergyView(topic.id,hash,saved||legacyView?.id,regionalIds)!;
 useEffect(()=>{revealPanel(active.groupId?'macro:chart:'+active.groupId:'macro:'+active.id);},[active.id]);
 function select(id:string){const view=topic.views.find(view=>view.id===id);if(!view)return;setSaved(id);history.replaceState(history.state,'',energySelectionUrl(location.href,view.anchor));rememberReadingView();window.dispatchEvent(new Event('hashchange'));}
 return <div className="energy-topic-frame">
  <div className="energy-topic-tabs" role="tablist" aria-label={topic.title+'查看方式'}>{topic.views.map(view=>{
   const headline=view.groupId?macroExplorerSummary(groupFor(view.groupId),data):null;
   return <button type="button" role="tab" key={view.id} id={'energy-tab-'+view.id} aria-selected={active.id===view.id} aria-controls={'energy-detail-'+topic.id} onClick={()=>select(view.id)}><strong>{view.label}</strong><span>{headline?<>{headline.valueText} {headline.unit} · {headline.date??'暂无观测'}</>:view.id==='commodity-comparison'?'起点＝100 · 比较涨跌幅':'按地区切换 · 电价 / 负荷'}</span></button>;
  })}</div>
  <div id={'energy-detail-'+topic.id} role="tabpanel" aria-labelledby={'energy-tab-'+active.id}>
   {active.groupId?<ChartCard key={active.id} group={groupFor(active.groupId)} data={data} range={range}/>:active.id==='commodity-comparison'?<CommodityComparison data={data} range={range}/>:<Suspense fallback={<div className="loading">正在读取区域电力数据…</div>}><RegionalEnergy/></Suspense>}
  </div>
 </div>;
}
export default function EnergyExplorer({data,range}:{data:Dataset;range:string}){
 const hash=useEnergyAnchor(),{inputs}=useObserver();
 const regionalIds=(inputs.regionalEnergy?.regions??[]).flatMap(region=>region.series.map(series=>series.id));
 // Migrate old chart selections to their new topic without discarding reading preferences.
 const [saved,setSaved]=useSavedView('panel-explorer:macro:category:2','mineral-resources',textPreference);
 const topic=resolveEnergyTopic(hash,regionalIds)??resolveEnergyTopic(saved,regionalIds)??energyTopics[0];
 const headlines:Record<string,string>={'oil-commodities':'brent','natural-gas':'natural-gas-daily',electricity:'electricity-us','coal-aus':'coal-aus'};
 const items:PanelExplorerItem[]=energyTopics.map(item=>{
  const headline=headlines[item.id]?macroExplorerSummary(groupFor(headlines[item.id]),data):null;
  return {...item,aliases:[...item.aliases,...(item.id==='electricity'?regionalIds:[])],eyebrow:item.id==='mineral-resources'?'金属价格':item.id==='electricity'?'用电成本与需求':'能源价格',summary:headline?<>{headline.valueText}<small>{headline.unit}</small></>:'日线 / 月均',meta:item.id==='mineral-resources'?'铜 · 铝 · 铁矿石 · 镍 · 金 · 银':<>{headline?.name} · {headline?.date??'暂无观测'}<br/>{item.id==='oil-commodities'?'原油价格与商品对比':item.id==='natural-gas'?'日线与月均价在框内切换':item.id==='electricity'?'全国电价与区域市场在框内切换':headline?.status}</>};
 });
 function selectTopic(id:string){const next=energyTopics.find(item=>item.id===id);if(!next)return;setSaved(id);history.replaceState(history.state,'',energySelectionUrl(location.href,next.anchor));rememberReadingView();window.dispatchEvent(new Event('hashchange'));}
 return <PanelExplorer storageKey="energy:topics" title="能源与材料速览" description="按品种归为五个主题，在同一个框内切换价格、趋势与地区。" selectedId={topic.id} onSelect={selectTopic} items={items} renderPanel={id=>id==='mineral-resources'?<MineralResourceChart data={data} range={range}/>:id==='coal-aus'?<ChartCard group={groupFor(id)} data={data} range={range}/>:<EnergyTopicPanel key={id} topic={energyTopics.find(item=>item.id===id)!} data={data} range={range} regionalIds={regionalIds} legacySelection={saved}/>}/>;
}
