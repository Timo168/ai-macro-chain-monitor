import {type Dataset,makeChart,firstValues,format} from './data';
import type {Group} from './groups';
import {metrics,monthOffset} from './calculations.mjs';
import {seriesHealth} from './data-health.mjs';

// Directory headlines describe the displayed calculation, not the newest raw
// index. A missing base period must remain visible rather than looking stale.
export function macroExplorerSummary(group:Group,data:Dataset,mode='yoy',computed?:ReturnType<typeof makeChart>){
 const chart=computed??makeChart(group,data,mode),stats=metrics(firstValues(chart.rows),group.category===2||group.changeKind==='percent');
 const health=seriesHealth(data.series[chart.ids[0]]);
 const digits=['claims','payrolls'].includes(group.id)?1:group.id==='nfci'?3:2;
 let valueText=format(stats.last?.value,digits),date=stats.last?.date??null,previous=stats.previous,name=chart.names[0],note='',warning=health.warning,status=health.label;
 if(group.id==='policy'){
  const policyRows=chart.rows as Array<{date:string;s0:number|null;s1:number|null}>;
  const completeRows=policyRows.filter(row=>typeof row.s0==='number'&&Number.isFinite(row.s0)&&typeof row.s1==='number'&&Number.isFinite(row.s1)&&row.s1>=row.s0);
  const complete=completeRows.at(-1),prior=completeRows.at(-2);
  previous=complete&&prior?Number(complete.s0)-Number(prior.s0):null;
  const latest=policyRows.at(-1);
  valueText=complete?`${format(Number(complete.s0),2)}–${format(Number(complete.s1),2)}`:'—';date=complete?.date??null;name='目标利率区间';
  if(latest&&latest.date!==date){note=`${latest.date} 区间不完整${complete?'；显示最近完整区间':''}`;warning=true;}
  const upperHealth=seriesHealth(data.series[chart.ids[1]]);
  warning=warning||upperHealth.warning;
  if(upperHealth.label!==health.label)status=`下限：${health.label}；上限：${upperHealth.label}`;
 }else{
  if(group.kind==='inflation')name+=' · '+(mode==='mom'?'环比':'同比');
  const raw=data.series[chart.ids[0]]?.observations??[];
  const latest=raw.reduce<(typeof raw)[number]|null>((last,point)=>!last||point.date>last.date?point:last,null);
  if(latest&&(!date||latest.date>date)){
   warning=true;
   if(latest.value==null)note=`${latest.date} 最新期缺值${date?'；显示最近有效值':''}`;
   else if(group.kind==='inflation'||group.id==='payrolls'){
    const baseDate=monthOffset(latest.date,group.kind==='inflation'&&mode!=='mom'?-12:-1),base=raw.find(point=>point.date===baseDate)?.value;
    const calculation=group.kind==='inflation'?(mode==='mom'?'环比':'同比'):'月增量';
    note=`原值截至 ${latest.date.slice(0,7)}；${calculation}${base===0&&group.kind==='inflation'?'基期为零':`缺少 ${baseDate.slice(0,7)} 基期`}`;
    if(date)name=chart.names[0]+' · 最近有效'+calculation;
   }else note=`${latest.date} 最新值暂不可用`;
  }
 }
 return {valueText,unit:group.unit,date,previous,name,note,warning,status};
}
