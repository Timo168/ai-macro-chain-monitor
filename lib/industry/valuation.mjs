import {buildValuationHistory,disclosedDilutedEps} from './valuation-history.mjs';
const numeric=value=>typeof value==='number'&&Number.isFinite(value);
const elapsed=(date,asOf)=>(Date.parse(asOf)-Date.parse(date))/86400000;
const latest=rows=>[...(rows??[])].sort((a,b)=>String(a.periodEnd??a.date).localeCompare(String(b.periodEnd??b.date))).at(-1);
const median=values=>{const rows=values.filter(numeric).sort((a,b)=>a-b);return rows.length?rows.length%2?rows[(rows.length-1)/2]:(rows[rows.length/2-1]+rows[rows.length/2])/2:null;};
const groups={MSFT:'云平台',GOOG:'云平台',AMZN:'云平台',ORCL:'云平台',META:'广告平台',NVDA:'半导体',AMD:'半导体',MU:'半导体',TSM:'半导体',DELL:'服务器',HPE:'服务器',ETN:'电力与机房设备',VRT:'电力与机房设备',AMKR:'封装与测试',ENTG:'半导体材料'};
export function officialTtm(industry,entity,family,asOf){
 const definition=(industry.definitions??[]).find(d=>d.entity===entity&&(d.family===family||family==='revenue'&&d.family==='company_revenue')&&d.currency==='USD'&&d.unit==='亿美元');
 const series=industry.series?.[definition?.id];
 if(!definition||!['ready','reviewed','cached'].includes(series?.status))return null;
 const rows=(series.observations??[]).filter(p=>numeric(p.value)&&!p.isEstimated&&p.periodEnd<=asOf&&p.publishedAt&&p.publishedAt.slice(0,10)<=asOf).sort((a,b)=>a.periodEnd.localeCompare(b.periodEnd)).slice(-4);
 if(rows.length!==4||rows.some((p,i)=>i>0&&(elapsed(rows[i-1].periodEnd,p.periodEnd)<70||elapsed(rows[i-1].periodEnd,p.periodEnd)>105)))return null;
 if(elapsed(rows[0].periodEnd,rows[3].periodEnd)<260||elapsed(rows[0].periodEnd,rows[3].periodEnd)>320)return null;
 return {value:rows.reduce((sum,p)=>sum+p.value*1e8,0),periodEnd:rows.at(-1).periodEnd,currency:'USD',unit:'USD',basis:'official_quarter_sum',sourceUrl:rows.at(-1).sourceUrl,publishedAt:rows.map(p=>p.publishedAt).sort().at(-1),fetchedAt:series.lastSuccessfulAt??series.fetchedAt??null,version:rows.map(p=>p.version).join('|'),inputs:rows.map(p=>({periodEnd:p.periodEnd,value:p.value,version:p.version,sourceUrl:p.sourceUrl}))};
}
export function valueCompany(industry,market,entity,{asOf=new Date().toISOString().slice(0,10),manualPrice=null,manualMarketCap=null}={}){
 const priceSeries=market?.prices?.[entity]??{};const quote=latest((priceSeries.observations??[]).filter(p=>p.date<=asOf));
 const finance=market?.finance?.[entity]??{};const fields={...(finance.fields??{})};
 for(const [key,family] of [['revenue','revenue'],['operatingCashFlow','operating_cash_flow'],['capex','capex']]){const own=officialTtm(industry,entity,family,asOf);if(own&&(!fields[key]||own.periodEnd>=fields[key].periodEnd))fields[key]=own;}
 const price=numeric(manualPrice)&&manualPrice>0?manualPrice:quote?.close??null;
 const isManual=numeric(manualPrice)&&manualPrice>0||numeric(manualMarketCap)&&manualMarketCap>0;
 const reasons=[];const valid=key=>{const point=fields[key];if(!point||!numeric(point.value)||point.periodEnd>asOf||elapsed(point.periodEnd,asOf)>200||point.publishedAt&&point.publishedAt.slice(0,10)>asOf||key!=='shares'&&point.currency!=='USD')return null;return point;};
 const shares=valid('shares');
 const splitConflict=shares&&(priceSeries.splits??[]).some(split=>split.date>shares.periodEnd&&split.date<=asOf);
 const priceFresh=isManual||quote&&elapsed(quote.date,asOf)<=7&&['ready','cached'].includes(priceSeries.status);
 const marketCap=numeric(manualMarketCap)&&manualMarketCap>0?manualMarketCap:priceFresh&&numeric(price)&&shares?.value>0&&!splitConflict?price*shares.value:null;
 if(!priceFresh)reasons.push('没有七天内的完整收盘报价，请更新行情或使用本机试算。');
 if(!shares&&!numeric(manualMarketCap))reasons.push('缺少最近披露的普通股股数，无法估算市值。');
 if(splitConflict)reasons.push('股数披露后发生拆股，尚未核验股数复权口径；不自动推算市值。');
 const revenue=valid('revenue'),income=valid('netIncome'),ocf=valid('operatingCashFlow'),capex=valid('capex'),cash=valid('cash'),debt=valid('debt');
 const align=(a,b)=>a&&b&&a.periodEnd===b.periodEnd;
 const fcf=align(ocf,capex)?ocf.value-capex.value:null;
 const comparableCash=cash?.scope!=='cash_only';
 const ev=marketCap!=null&&align(cash,debt)&&comparableCash?marketCap+debt.value-cash.value:null;
 const dilutedEps=disclosedDilutedEps(market,entity,asOf,{afterPublicationDay:true});
 const pe=dilutedEps?.value>0&&priceFresh&&price>0?price/dilutedEps.value:marketCap!=null&&income?.value>0?marketCap/income.value:null;
 const ps=marketCap!=null&&revenue?.value>0?marketCap/revenue.value:null;
 const fcfYield=marketCap>0&&numeric(fcf)?fcf/marketCap*100:null;
 const netDebt=align(cash,debt)&&comparableCash?debt.value-cash.value:null;
 if(cash?.scope==='cash_only')reasons.push('官方现金字段未包含短期投资，保留原口径，不混算净债务或企业价值。');
 if(income?.value<=0)reasons.push('TTM净利润为零或亏损，市盈率不适用。');
 if(dilutedEps)reasons.push('P/E使用最近四季正式披露的GAAP稀释每股收益之和；季度加权股数与四舍五入会使其不同于市值/净利润口径。');
 if(!align(ocf,capex))reasons.push('营业现金流与资本开支的TTM期末不一致或缺项，不计算自由现金流收益率。');
 if(entity==='TSM')reasons.push('美股为ADR；财务币种及每份ADR对应股数必须核验，未核验时不与普通股市值混算。');
 if(entity==='TSM'&&!numeric(manualMarketCap))return {entity,peerGroup:groups[entity],status:'scope_mismatch',price,priceAt:quote?.date??null,marketCap:null,pe:null,ps:null,fcfYield:null,ev:null,netDebt:null,fields,reasons,isManual,sourceUrl:priceSeries.sourceUrl};
 const revenueDef=(industry.definitions??[]).find(d=>d.entity===entity&&['revenue','company_revenue'].includes(d.family));const history=(industry.series?.[revenueDef?.id]?.observations??[]).filter(p=>numeric(p.value)&&!p.isEstimated&&p.publishedAt&&p.publishedAt.slice(0,10)<=asOf&&p.periodEnd<=asOf).sort((a,b)=>a.periodEnd.localeCompare(b.periodEnd));
 const current=history.at(-1),prior=history.findLast(p=>current&&Math.abs(elapsed(p.periodEnd,current.periodEnd)-365)<=14);
 const revenueGrowth=current&&prior?.value>0?(current.value/prior.value-1)*100:null;
 return {entity,peerGroup:groups[entity],status:pe!=null||ps!=null||fcfYield!=null?'available':'partial',price,priceAt:isManual?asOf:quote?.date??null,marketCap,marketCapBasis:isManual?'本机输入试算':'当前价格 × 最近披露普通股股数（估算）',pe,peBasis:dilutedEps?'price_over_reported_diluted_eps':'market_cap_over_ttm_income',dilutedEps,ps,fcfYield,freeCashFlow:fcf,ev,netDebt,revenueGrowth,revenueQuarter:current?.periodEnd??null,netIncome:income?.value??null,revenue:revenue?.value??null,cash:cash?.value??null,cashScope:cash?.scope??'cash_and_short_term_investments',debt:debt?.value??null,ttmEnd:revenue?.periodEnd??income?.periodEnd??null,fields,reasons,isManual,sourceUrl:priceSeries.sourceUrl,priceStatus:priceSeries.status??'not_configured',priceVersion:priceSeries.version??null,priceFetchedAt:priceSeries.fetchedAt??null,financeStatus:finance.status??'not_configured',sourceError:[finance.error,finance.officialSourceError,finance.vendorSourceError,finance.epsHistory?.error].filter(Boolean).join('；')||null};
}
export function buildValuations(industry,market,{asOf=new Date().toISOString().slice(0,10),previous=null,recordedAt=null}={}){
 const companies=Object.keys(groups).map(entity=>valueCompany(industry,market,entity,{asOf}));
 for(const company of companies){
  const peers=companies.filter(p=>p.peerGroup===company.peerGroup&&p.ps!=null);const middle=median(peers.map(p=>p.ps));
  company.peerCount=peers.length;company.peerMedianPs=peers.length>=3?middle:null;
  company.peerComparison=company.ps==null?'市值或TTM收入缺项':peers.length<3?'同组有效样本少于三家，不做便宜/昂贵排序':company.ps<middle?'市销率低于当前同组中位数':company.ps>middle?'市销率高于当前同组中位数':'市销率接近当前同组中位数';
  company.summary=[company.revenueGrowth==null?'季度收入同比待核验':`最近季度收入同比 ${company.revenueGrowth.toFixed(1)}%`,company.ps==null?'市销率待补齐':`TTM市销率 ${company.ps.toFixed(2)} 倍`,company.fcfYield==null?'自由现金流收益率待核验':`自由现金流收益率 ${company.fcfYield.toFixed(2)}%`].join('；')+'。估值比较还需结合增长持续性、利润率和业务结构。';
  company.history=buildValuationHistory(company,market,{asOf,recordedAt,previous:previous?.companies?.find(p=>p.entity===company.entity)?.history});
 }
 return {schemaVersion:'2',asOf,companies,method:'TTM为最近连续四个实际财季；市值按最新完整收盘价和最近披露普通股股数估算。正式季度EPS可核验时P/E=价格/TTM稀释EPS之和，否则P/E=市值/TTM净利润；P/S=市值/TTM收入；FCF收益率=(TTM营业现金流−现金购置固定资产)/市值。不同来源和期末逐项展示。',note:'公司层面的估值研究不改变产业评分；相对倍数不是合理价值、目标价或收益保证。'};
}

export function valuationScenario(company,{revenueGrowthPct=0,netMarginPct=null,fcfMarginPct=null}={}){
 const revenue=company.revenue;const cap=company.marketCap;
 const alignedIncome=company.fields?.netIncome?.periodEnd===company.fields?.revenue?.periodEnd;
 const alignedFcf=company.fields?.operatingCashFlow?.periodEnd===company.fields?.revenue?.periodEnd&&company.fields?.capex?.periodEnd===company.fields?.revenue?.periodEnd;
 const baseline={marketCap:cap,revenue,netIncome:company.netIncome,freeCashFlow:company.freeCashFlow,netMarginPct:alignedIncome&&revenue>0&&numeric(company.netIncome)?100*company.netIncome/revenue:null,fcfMarginPct:alignedFcf&&revenue>0&&numeric(company.freeCashFlow)?100*company.freeCashFlow/revenue:null,pe:cap>0&&company.netIncome>0?cap/company.netIncome:null,ps:company.ps,fcfYield:company.fcfYield};
 const assumptions={revenueGrowthPct,netMarginPct:netMarginPct??baseline.netMarginPct,fcfMarginPct:fcfMarginPct??baseline.fcfMarginPct};
 const invalid=!numeric(revenueGrowthPct)||revenueGrowthPct<=-100||revenueGrowthPct>1000||[netMarginPct,fcfMarginPct].some(v=>v!==null&&(!numeric(v)||v< -100||v>100));
 if(invalid||!(cap>0&&revenue>0)||company.status==='scope_mismatch')return {status:invalid?'invalid_input':'insufficient_data',baseline,assumptions,scenario:null,reason:invalid?'增长或利润率假设超出可计算范围。':'需要已核验币种、公司股数和TTM收入，才能进行固定市值试算。'};
 const futureRevenue=revenue*(1+revenueGrowthPct/100);const income=numeric(assumptions.netMarginPct)?futureRevenue*assumptions.netMarginPct/100:null;const fcf=numeric(assumptions.fcfMarginPct)?futureRevenue*assumptions.fcfMarginPct/100:null;
 const scenario={marketCap:cap,revenue:futureRevenue,netIncome:income,freeCashFlow:fcf,pe:income>0?cap/income:null,ps:cap/futureRevenue,fcfYield:numeric(fcf)?100*fcf/cap:null};
 return {status:'available',baseline,assumptions,scenario,changes:{pe:numeric(baseline.pe)&&numeric(scenario.pe)?scenario.pe-baseline.pe:null,ps:numeric(baseline.ps)?scenario.ps-baseline.ps:null,fcfYield:numeric(baseline.fcfYield)&&numeric(scenario.fcfYield)?scenario.fcfYield-baseline.fcfYield:null},method:'固定当前估算市值，将TTM收入乘以增长假设，再按假设净利率与自由现金流率计算。基线和情景的P/E统一使用市值/净利润。仅为经营假设敏感度，不是盈利预测、目标价或买卖指令。'};
}
