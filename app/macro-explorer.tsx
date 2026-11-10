"use client";
import {useMemo,type ReactNode} from 'react';
import {type Dataset} from '@/lib/data';
import type {Group} from '@/lib/groups';
import {macroExplorerSummary} from '@/lib/macro-summary';
export {macroExplorerSummary} from '@/lib/macro-summary';
import PanelExplorer,{type PanelExplorerItem} from './panel-explorer';
import ChartCard from './chart-card';

export default function MacroExplorer({data,range,groups,title,storageKey,extras=[]}:{data:Dataset;range:string;groups:Group[];title:string;storageKey:string;extras?:Array<PanelExplorerItem&{content:ReactNode}>}){
 const items=useMemo(()=>[...extras,...groups.map(group=>{const summary=macroExplorerSummary(group,data);return {id:group.id,anchor:group.id,title:group.title,eyebrow:group.frequency,panelKey:'macro:chart:'+group.id,summary:<>{summary.valueText}<small>{summary.unit}</small></>,meta:<>{summary.name} · {summary.date??'暂无观测'}<br/><span className={summary.warning?'warning-text':''}>{summary.status}{summary.note&&<><br/>{summary.note}</>}</span></>};})],[data,groups,extras]);
 return <PanelExplorer storageKey={storageKey} title={title} description="选择要观察的指标，集中查看趋势；解读与来源按需展开。" items={items} renderPanel={id=>extras.find(item=>item.id===id)?.content??<ChartCard key={id} group={groups.find(group=>group.id===id)!} data={data} range={range}/>}/>;
}
