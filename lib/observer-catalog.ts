import type {ObserverInputs,ObservationItem} from './observer-types';
import {groups} from './groups';
import {format,makeChart,metadata,sourceLink,type Point} from './data';
import {seriesHealth} from './data-health.mjs';
import {metricStats} from './industry/engine.mjs';
import {appBase} from './runtime';

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const latest=(points:Point[])=>points.filter(point=>finite(point.value)).sort((a,b)=>a.date.localeCompare(b.date)).at(-1);
const pages:Record<number,string>={1:'economy',2:'materials',3:'financing'};
const frequency:Record<string,string>={daily:'日度',weekly:'周度',monthly:'月度',quarterly:'季度',annual:'年度',event:'事件'};
const companies:Record<string,string>={MSFT:'微软 Microsoft Azure',GOOG:'谷歌 Google Alphabet',AMZN:'亚马逊 Amazon AWS',META:'Meta Facebook 脸书',ORCL:'甲骨文 Oracle',NVDA:'英伟达 NVIDIA',AMD:'超威 AMD',MU:'美光 Micron',TSM:'台积电 TSMC',DELL:'戴尔 Dell',HPE:'慧与 Hewlett Packard Enterprise',ETN:'伊顿 Eaton',VRT:'维谛 Vertiv',AMKR:'安靠 Amkor',ENTG:'英特格 Entegris',EQIX:'易昆尼克斯 Equinix',DLR:'数字地产 Digital Realty'};
const macroAliases:Record<string,string>={ICSA:'初请 失业金 就业 initial claims',UNRATE:'失业 unemployment',PAYEMS:'非农 新增就业 payroll employment',PCEPILFE:'核心PCE 通胀 core personal consumption expenditure inflation',PCEPI:'总体PCE 通胀 personal consumption expenditure inflation',CPIAUCNS:'物价 消费者物价 inflation consumer price',CPILFENS:'核心CPI 通胀 core inflation',DGS10:'美债 国债 利率 nominal treasury yield 10Y',DFII10:'美债 实际利率 real treasury yield TIPS 10Y',DCOILBRENTEU:'原油 油价 brent oil',NFCI:'融资 金融条件 financial conditions',GOLD:'金价 gold',SILVER:'银价 silver',COPPER:'铜价 copper',ALUMINUM:'铝价 aluminium aluminum',NICKEL:'镍价 nickel',IRON_ORE:'铁矿 iron ore',EIA_US_COMMERCIAL:'电费 电价 electricity power',NATGAS_US:'天然气 gas Henry Hub',COAL_AUS:'动力煤 coal'};
const minerals=new Set(['copper','aluminum','iron-ore','nickel','gold','silver']);
const href=(query:string,anchor?:string)=>`${appBase()}?${query}${anchor?'#'+encodeURIComponent(anchor):''}`;
const industryLabels:Record<string,string>={ready:'已获取',reviewed:'已核验',cached:'使用缓存',fetch_failed:'获取失败',pending:'等待发布 / 核验',authorization_required:'需要数据授权',not_configured:'来源未配置',no_observation:'尚无已发布观测'};

type ValuationCompany={entity:string;peerGroup?:string;price?:number|null;priceAt?:string|null;priceStatus?:string;priceFetchedAt?:string|null;priceVersion?:string|null;sourceUrl?:string|null;status?:string;pe?:number|null;ps?:number|null;ttmEnd?:string|null;history?:{observations?:{date:string;price?:number|null}[]}};

export function buildObserverCatalog(inputs:ObserverInputs):ObservationItem[]{
 const items:ObservationItem[]=[];const {macro,industry,research,policyRates,policyDecisions}=inputs;
 // An unloaded data file is not evidence that every source is unconfigured.
 if(macro.generatedAt||Object.keys(macro.series).length){
  for(const group of groups){
   const modes=group.kind==='inflation'?['yoy','mom']:['value'];
   for(const mode of modes){
    const chart=makeChart(group,macro,mode==='value'?'yoy':mode);
    for(const [index,id] of chart.ids.entries()){
     const points=chart.rows.map(row=>({date:String(row.date),value:(row as Record<string,unknown>)['s'+index] as number|null}));
     const point=latest(points),series=macro.series[id],health=seriesHealth(series);
     const transformed=group.kind==='inflation';
     const title=group.id==='claims'?group.title:group.id==='payrolls'?group.title:chart.names[index]??group.title;
     const seriesTitle=transformed?`${title} · ${mode==='yoy'?'同比':'环比'}`:title;
     const query=`page=${pages[group.category]}&series=${encodeURIComponent(id)}${transformed?'&chartMode='+mode:''}${minerals.has(group.id)?'&commodityMode=monthly':''}`;
     items.push({id:`macro:${id}${transformed?':'+mode:''}`,title:seriesTitle,subtitle:`${group.frequency} · ${transformed?(mode==='yoy'?'较上年同月变化率':'较上月变化率'):group.id==='payrolls'?'就业总量月度差分':metadata[id]?.seasonal??group.title} · ${metadata[id]?.source??''}`,kind:'macro',href:href(query,group.id),anchorId:minerals.has(group.id)?'mineral-resources':group.id,panelKey:minerals.has(group.id)?'macro:mineral-resources':`macro:chart:${group.id}`,searchTerms:`${id} ${group.title} ${macroAliases[id]??''} ${group.sectors.join(' ')}`,value:format(point?.value,group.id==='claims'?1:2),unit:group.unit,period:point?.date??'尚无可用观测',status:!point&&health.state==='ready'?'计算基期不足':health.label,warning:health.warning||(!point&&health.state==='ready'),checkedAt:series?.checkedAt??series?.fetchedAt,nextExpectedAt:series?.publication?.nextReleaseAt,sourceUrl:series?.sourceUrl||sourceLink(id),sourceVersion:series?.revision,points});
    }
   }
  }
  for(const [id,meta] of Object.entries(metadata).filter(([id])=>id.startsWith('MKT_'))){
   const series=macro.series[id],points=series?.observations??[],point=latest(points),health=seriesHealth(series);const anchor=groups.find(group=>group.series.includes(id.slice(4)))?.id??'mineral-resources';
   items.push({id:`macro:${id}`,title:meta.name,subtitle:`日频收盘 · ${meta.source} · 非月均现货`,kind:'macro',href:href(`page=materials&commodityMode=market&series=${id}`,anchor),anchorId:'mineral-resources',panelKey:'macro:mineral-resources',searchTerms:`${id} ${macroAliases[id.slice(4)]??''} 日频 行情 期货`,value:format(point?.value),unit:meta.unit,period:point?.date??'尚无可用观测',status:health.label,warning:health.warning,checkedAt:series?.checkedAt??series?.fetchedAt,sourceUrl:series?.sourceUrl||sourceLink(id),sourceVersion:series?.revision,points});
  }
 }
 if(industry){
  for(const definition of industry.definitions){
   const series=industry.series[definition.id],observations=[...(series?.observations??[])].sort((a,b)=>a.periodEnd.localeCompare(b.periodEnd));
   const observation=observations.filter(point=>finite(point.value)).at(-1),stats=metricStats(definition,observations);
   const state=series?.status??'not_configured';const stale=stats.freshness==='stale';const estimated=observation?.isEstimated||['guidance','proxy','demo','third_party'].includes(definition.valueType);
   const label=industryLabels[state]??state;
   items.push({id:`industry:${definition.id}`,title:`${definition.entity??''} ${definition.nameZh}`.trim(),subtitle:`${frequency[definition.frequency]??definition.frequency} · ${definition.sourceName}${estimated?' · 估算／代理口径':''}${observation?.fiscalPeriod?' · '+observation.fiscalPeriod:''}`,kind:'industry',href:href(`page=impact&industry=metrics&category=${encodeURIComponent(definition.category)}`,definition.id),anchorId:definition.id,panelKey:`industry:metric:${definition.id}`,searchTerms:`${definition.id} ${definition.nameEn} ${companies[definition.entity??'']??''} ${definition.aiChainStage.join(' ')} ${definition.family}`,value:format(observation?.value),unit:definition.unit,period:observation?.periodEnd??'尚无可用观测',status:`${label}${state==='fetch_failed'&&observation?' · 保留缓存':''}${stale?' · 超出更新周期':''}${observations.at(-1)?.value==null&&observation?' · 最新期缺值':''}`,warning:['cached','fetch_failed'].includes(state)||stale,checkedAt:series?.checkedAt??series?.fetchedAt,nextExpectedAt:definition.sourceNextExpectedAt,sourceUrl:observation?.sourceUrl??definition.sourceUrl,sourceVersion:observation?.version,points:observations.map(point=>({date:point.periodEnd,value:point.value}))});
  }
 }
 const valuation=(research as (typeof research&{valuation?:{companies?:ValuationCompany[]}}))?.valuation;
 for(const company of valuation?.companies??[]){
  const available=finite(company.price),cached=company.priceStatus==='cached';
  items.push({id:`valuation:${company.entity}`,title:`${company.entity} · 公司估值`,subtitle:`${companies[company.entity]??company.entity} · 股价 USD${finite(company.pe)?` · TTM P/E ${format(company.pe)} 倍`:' · P/E 待核验'}${company.ttmEnd?' · 财务期末 '+company.ttmEnd:''}`,kind:'valuation',href:href(`page=impact&industry=conclusions&research=valuation&company=${encodeURIComponent(company.entity)}`,'research-progress'),anchorId:'research-progress',panelKey:'research:progress',searchTerms:`${company.entity} ${companies[company.entity]??''} ${company.peerGroup??''} 估值 股价 市盈率 市销率 市值 price valuation P/E P/S`,value:format(company.price),unit:'美元／股',period:company.priceAt??'尚无行情日期',status:!available?'缺少有效行情':company.priceStatus==='ready'?(company.status==='available'?'日频收盘 · 已获取':'日频收盘 · 估值字段待核验'):cached?'日频收盘 · 使用缓存':'行情状态待核验',warning:!available||cached||company.priceStatus!=='ready',checkedAt:company.priceFetchedAt,sourceUrl:company.sourceUrl,sourceVersion:company.priceVersion,points:(company.history?.observations??[]).map(point=>({date:point.date,value:finite(point.price)?point.price:null}))});
 }
 const bankIds=[...new Set([...(policyRates?.series??[]).map(series=>series.id),...(policyDecisions?.decisions??[]).map(decision=>decision.bankId)])];
 for(const bankId of bankIds){
  const series=policyRates?.series.find(row=>row.id===bankId),point=latest(series?.observations??[]);
  const decision=policyDecisions?.decisions.filter(row=>row.bankId===bankId&&finite(row.lower)&&finite(row.upper)).sort((a,b)=>a.announcementDate.localeCompare(b.announcementDate)).at(-1);
  // Keep an announced future-effective decision separate in its wording; do not
  // create synthetic daily history from a monthly policy-rate observation.
  const useDecision=Boolean(decision&&(!point||(decision.effectiveDate??decision.announcementDate).slice(0,7)>point.date.slice(0,7)));
  const bank=series?.name??decision?.bank??bankId;const country=series?.country??decision?.country??'';
  const check=policyDecisions?.checks?.find(row=>row.bankId===bankId),failed=useDecision?(check?.status==='fetch_failed'||policyDecisions?.status==='fetch_failed'||policyDecisions?.status==='cached'):(series?.status==='cached'||policyRates?.status==='cached');
  const value=useDecision&&decision?(decision.lower===decision.upper?format(decision.lower):`${format(decision.lower)}–${format(decision.upper)}`):format(point?.value);
  items.push({id:`policy:${bankId}`,title:`${country} · ${bank}`,subtitle:useDecision&&decision?`最新官方决议 · ${decision.effectiveDate?'生效 '+decision.effectiveDate:'生效日未提供'}`:`月末政策利率 · ${series?.sourceTitle??''}${bankId==='fed'?' · 目标区间中点':''}`,kind:'policy',href:href(`page=policy-calendar&bank=${encodeURIComponent(bankId)}`,'policy-rates'),anchorId:'policy-rates',panelKey:'policy:rates',searchTerms:`${bankId} ${country} ${bank} ${series?.shortName??''} 央行 加息 降息 议息 interest central bank`,value,unit:'%',period:useDecision&&decision?decision.announcementDate:point?.date??'尚无可用观测',status:failed?'获取失败 · 保留缓存':useDecision?'已核验官方决议':point?'已获取月末数据':'尚无已发布观测',warning:failed,checkedAt:useDecision?check?.checkedAt??policyDecisions?.checkedAt:policyRates?.checkedAt,sourceUrl:useDecision?decision?.statementUrl:series?.sourceUrl,sourceVersion:useDecision?policyDecisions?.generatedAt:policyRates?.generatedAt,points:series?.observations??[]});
 }
 return items;
}
