import {metricStats} from './engine.mjs';
const day=x=>String(x??'').slice(0,10);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export function buildCrossCompanyComparison(industry,{asOf=new Date().toISOString().slice(0,10)}={}){
 const definitions=industry.definitions??[];
 const company=(entity,revenueIds,profitIds,scope)=>{
  const metric=ids=>{
   const d=ids.map(id=>definitions.find(def=>def.id===id)).find(Boolean);if(!d)return null;
   const series=industry.series?.[d.id];
   const rows=(series?.observations??[]).filter(p=>finite(p.value)&&day(p.periodEnd)<=asOf&&(!p.publishedAt||day(p.publishedAt)<=asOf)).sort((a,b)=>a.periodEnd.localeCompare(b.periodEnd));
   const latest=rows.at(-1),stats=metricStats(d,rows);
   const fresh=latest&&(Date.parse(asOf)-Date.parse(latest.periodEnd))/86400000<=210;
   const eligible=['ready','cached'].includes(series?.status)&&fresh;
   return {id:d.id,name:d.nameZh,unit:d.unit,status:series?.status??'not_configured',value:latest?.value??null,yoy:eligible?stats.yoy:null,periodStart:latest?.periodStart??null,periodEnd:latest?.periodEnd??null,publishedAt:latest?.publishedAt??null,fetchedAt:series?.fetchedAt??null,version:latest?.version??null,sourceUrl:latest?.sourceUrl??d.sourceUrl,basis:latest?.basis??d.methodology,eligible:Boolean(eligible),reason:!latest?'尚无实际观测':!fresh?'观测已超出交叉比较窗口':!eligible?'来源状态需核验':null};
  };
  return {entity,scope,revenue:metric(revenueIds),profit:metric(profitIds)};
 };
 const groups=[
  {id:'packaging',name:'封装与测试经营样本',companies:[company('AMKR',['AMKR.advanced_products_revenue','AMKR.company_revenue'],['AMKR.gross_margin'],'先进产品含非 AI 终端；毛利率为公司整体。'),company('ASE',['ASE.atm_revenue','ASE.company_revenue'],['ASE.atm_margin','ASE.operating_margin'],'封装测试与电子制造须区分，来源通过采集校验后才参与比较。')],boundary:'目前可用范围取决于实际接通的公司；不能外推为全球先进封装产能或 CoWoS 供需。'},
  {id:'materials',name:'半导体材料经营样本',companies:[company('ENTG',['ENTG.company_revenue'],['ENTG.gross_margin'],'公司整体材料、过滤与处理业务，含业务组合变化。'),company('FUJIMI',['FUJIMI.cmp_revenue','FUJIMI.company_revenue'],['FUJIMI.operating_margin','FUJIMI.operating_income'],'CMP 抛光材料收入与公司整体盈利；日元口径，不是铜铝资源。')],boundary:'各公司业务构成和利润定义不同。分别看自身同比，不加总不同币种金额，不直接比较毛利率与营业利润率。'}
 ];
 for(const g of groups){
  const available=g.companies.filter(c=>c.revenue?.eligible&&finite(c.revenue.yoy));
  g.availableCompanyCount=available.length;
  const dates=available.map(c=>Date.parse(c.revenue.periodEnd));
  g.periodsComparable=available.length>=2&&Math.max(...dates)-Math.min(...dates)<=32*86400000;
  g.summary=available.length<2?'尚未凑齐两个可比较的公司样本。':!g.periodsComparable?'已有多个公司样本，但最新报告期不同，分别观察。':available.every(c=>c.revenue.yoy>0)?'可比较报告期内，已接入样本的收入同比均增长。':available.every(c=>c.revenue.yoy<0)?'可比较报告期内，已接入样本的收入同比均下降。':'可比较报告期内，已接入样本的收入方向存在分歧。';
 }
 return {asOf,groups,method:'从实际公开财报核对多公司方向；范围和时间不匹配时保留差异，不自动抬高产业评分。'};
}
