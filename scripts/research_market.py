"""Daily reference prices and separate valuation facts; no trading or credentials in UI."""
import argparse, hashlib, json, math, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo
from collect import download_market
from industry_common import DATA, atomic, now
from industry_sector_financials import fetch_source, quarterly_flows, tagged_facts

PATH=DATA/'research-market.json'
SYMBOLS=['MSFT','GOOG','META','AMZN','ORCL','NVDA','DELL','AMD','HPE','MU','ETN','VRT','TSM','QQQ']
CIKS={'MSFT':'0000789019','GOOG':'0001652044','META':'0001326801','AMZN':'0001018724','ORCL':'0001341439','NVDA':'0001045810','DELL':'0001571996','AMD':'0000002488','HPE':'0001645590','MU':'0000723125','ETN':'0001551182','VRT':'0001674101'}
TYPES={'revenue':'trailingTotalRevenue','netIncome':'trailingNetIncomeCommonStockholders','operatingCashFlow':'trailingOperatingCashFlow','capex':'trailingCapitalExpenditure','shares':'quarterlyOrdinarySharesNumber','cash':'quarterlyCashCashEquivalentsAndShortTermInvestments','debt':'quarterlyTotalDebt'}

def numeric(value):return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)
def archive(symbol,kind,raw):
    version=hashlib.sha256(raw).hexdigest();folder=DATA/'research-market-versions'/symbol;folder.mkdir(parents=True,exist_ok=True)
    (folder/(kind+'-'+version+'.json')).write_bytes(raw)
    return version

def parse_prices(raw,symbol,current=None):
    current=current or datetime.now(timezone.utc)
    payload=json.loads(raw);results=payload.get('chart',{}).get('result') or []
    if payload.get('chart',{}).get('error') or len(results)!=1:raise ValueError('行情响应缺少唯一有效序列')
    result=results[0];meta=result.get('meta',{})
    if meta.get('symbol')!=symbol:raise ValueError('行情代码不匹配')
    if meta.get('currency')!='USD':raise ValueError('样本行情必须为美元，不自动换汇')
    zone=ZoneInfo(meta.get('exchangeTimezoneName','America/New_York'));today=current.astimezone(zone).date().isoformat()
    stamps=result.get('timestamp',[]);indicators=result.get('indicators',{});closes=(indicators.get('quote') or [{}])[0].get('close',[]);adjusted=(indicators.get('adjclose') or [{}])[0].get('adjclose',[])
    if not stamps or len(stamps)!=len(closes) or len(stamps)!=len(adjusted):raise ValueError('缺少完整原始与复权收盘序列')
    session_end=meta.get('currentTradingPeriod',{}).get('regular',{}).get('end')
    points=[]
    for stamp,close,adj in zip(stamps,closes,adjusted):
        day=datetime.fromtimestamp(stamp,zone).date().isoformat()
        if day>today or (day==today and (not numeric(session_end) or current.timestamp()<session_end+900)):continue
        if not numeric(close) or not numeric(adj) or close<=0 or adj<=0:continue
        points.append({'date':day,'close':float(close),'adjustedClose':float(adj)})
    if len(points)<20:raise ValueError('有效完整交易日少于20天')
    splits=[{'date':datetime.fromtimestamp(int(key),zone).date().isoformat(),'numerator':row.get('numerator'),'denominator':row.get('denominator')} for key,row in result.get('events',{}).get('splits',{}).items()]
    return {'currency':'USD','observations':sorted(points,key=lambda p:p['date']),'splits':splits,'adjustment':'provider_split_dividend_adjusted','delayNote':'完整交易日日频收盘参考，可能有延迟；不是实时成交报价。'}

def parse_vendor_facts(raw,symbol,as_of):
    payload=json.loads(raw);root=payload.get('timeseries',{})
    if root.get('error') or not root.get('result'):raise ValueError('财务转录响应不可用')
    result={}
    for key,tag in TYPES.items():
        groups=[group for group in root['result'] if group.get('meta',{}).get('symbol')==[symbol] and group.get('meta',{}).get('type')==[tag]]
        points=[point for group in groups for point in group.get(tag,[]) if point.get('asOfDate','9999')<=as_of and numeric(point.get('reportedValue',{}).get('raw')) and point.get('periodType')==('TTM' if tag.startswith('trailing') else '3M')]
        if not points:continue
        point=max(points,key=lambda p:p['asOfDate']);value=point['reportedValue']['raw']
        if key=='capex':value=-value if value<=0 else value
        result[key]={'value':value,'periodEnd':point['asOfDate'],'currency':point.get('currencyCode'),'unit':'shares' if key=='shares' else point.get('currencyCode'),'sourceTag':tag,'publishedAt':None,'basis':'third_party_transcription','periodType':point['periodType']}
    if not result:raise ValueError('未发现可核验口径的财务字段')
    return result

def parse_sec_facts(raw,entity,as_of):
    payload=json.loads(raw)
    if str(payload.get('cik','')).zfill(10)!=CIKS[entity]:raise ValueError('SEC CIK不匹配')
    tags={'revenue':('RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet'),'netIncome':('NetIncomeLoss','ProfitLoss'),'operatingCashFlow':('NetCashProvidedByUsedInOperatingActivities',),'capex':('PaymentsToAcquirePropertyPlantAndEquipment',)}
    result={};gaap=payload.get('facts',{}).get('us-gaap',{})
    for key,names in tags.items():
        quarters=quarterly_flows(tagged_facts(payload,names,as_of),as_of)
        rows=quarters[-4:]
        if len(rows)!=4 or any((datetime.fromisoformat(b['start'])-datetime.fromisoformat(a['end'])).days not in (1,2,3) for a,b in zip(rows,rows[1:])):continue
        result[key]={'value':sum(row['value'] for row in rows),'periodEnd':rows[-1]['end'],'currency':'USD','unit':'USD','publishedAt':max(row['publishedAt'] for row in rows),'sourceTag':rows[-1]['inputs'][0].get('tag'),'basis':'official_quarter_sum','periodType':'TTM','inputs':[item for row in rows for item in row['inputs']]}
    instant={'shares':('CommonStockSharesOutstanding',),'cash':('CashCashEquivalentsAndShortTermInvestments','CashAndCashEquivalentsAtCarryingValue'),'debt':('LongTermDebtCurrent','LongTermDebtNoncurrent')}
    for key,names in instant.items():
        rows=[]
        for tag in names:
            unit='shares' if key=='shares' else 'USD'
            valid=[dict(point,tag=tag) for point in gaap.get(tag,{}).get('units',{}).get(unit,[]) if point.get('end','9999')<=as_of and point.get('filed','9999')<=as_of and numeric(point.get('val')) and not point.get('start')]
            if valid:rows.append(max(valid,key=lambda p:(p['end'],p['filed'])))
            if key!='debt' and valid:break
        if not rows or (key=='debt' and (len(rows)!=2 or rows[0]['end']!=rows[1]['end'])):continue
        # Long-term borrowing only; never label it total debt or derive EV from it.
        target='longTermDebt' if key=='debt' else key
        result[target]={'value':sum(row['val'] for row in rows),'periodEnd':rows[0]['end'],'currency':'USD','unit':'shares' if key=='shares' else 'USD','publishedAt':max(row['filed'] for row in rows),'sourceTag':'+'.join(row['tag'] for row in rows),'basis':'official_balance','periodType':'instant','inputs':rows}
        if key=='cash':result[target]['scope']='cash_only' if rows[0]['tag']=='CashAndCashEquivalentsAtCarryingValue' else 'cash_and_short_term_investments'
    if not result:raise ValueError('SEC未返回可组成TTM或同日资产负债的字段')
    return result

def retained(previous,error,stamp):
    return {**previous,'status':'cached' if previous.get('observations') or previous.get('fields') else 'fetch_failed','checkedAt':stamp,'error':str(error)[:240]}

def run(force=False,path=PATH,symbols=None):
    old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if not force and old.get('checkedAt') and datetime.now(timezone.utc)-datetime.fromisoformat(old['checkedAt'])<timedelta(hours=20):return old
    stamp=now();as_of=stamp[:10];previous_prices=old.get('prices',{});previous_finance=old.get('finance',{})
    def job(symbol):
        price=previous_prices.get(symbol,{});finance=previous_finance.get(symbol,{})
        url=f'https://query2.finance.yahoo.com/v8/finance/chart/{quote(symbol)}?range=2y&interval=1d&events=div%2Csplits'
        try:
            raw=download_market(url);parsed=parse_prices(raw,symbol);version=archive(symbol,'prices',raw)
            merged={p['date']:p for p in price.get('observations',[])};merged.update({p['date']:p for p in parsed['observations']})
            price={**parsed,'observations':[merged[d] for d in sorted(merged)],'sourceUrl':f'https://finance.yahoo.com/quote/{symbol}/history/','provider':'Yahoo Finance','version':version,'status':'ready','checkedAt':stamp,'fetchedAt':stamp,'lastSuccessfulAt':stamp,'exportAllowed':False,'error':None}
        except Exception as error:price=retained(price,error,stamp)
        if symbol!='QQQ':
            try:
                fields={};sec_error=None;vendor_error=None;sec_url=None
                if symbol in CIKS:
                    sec_url=f'https://data.sec.gov/api/xbrl/companyfacts/CIK{CIKS[symbol]}.json'
                    try:
                        raw,fetched,version=fetch_source(sec_url,force=force);fields=parse_sec_facts(raw,symbol,as_of)
                        for field in fields.values():field.update({'sourceUrl':sec_url,'fetchedAt':fetched,'version':version})
                    except Exception as error:sec_error=str(error)[:180]
                url='https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/'+symbol+'?type='+','.join(TYPES.values())+'&period1=1704067200&period2='+str(int(time.time()))
                try:
                    raw=download_market(url);version=archive(symbol,'finance',raw)
                    for key,field in parse_vendor_facts(raw,symbol,as_of).items():
                        if key not in fields or field['periodEnd']>fields[key]['periodEnd']:fields[key]={**field,'sourceUrl':f'https://finance.yahoo.com/quote/{symbol}/financials/','fetchedAt':stamp,'version':version}
                except Exception as error:
                    vendor_error=str(error)[:180]
                    if not fields:raise
                for key,field in finance.get('fields',{}).items():
                    if key not in fields:fields[key]={**field,'sourceStatus':'cached','sourceError':vendor_error or sec_error}
                finance={'fields':fields,'status':'ready','checkedAt':stamp,'fetchedAt':stamp,'lastSuccessfulAt':stamp,'officialSourceError':sec_error,'vendorSourceError':vendor_error,'sourceUrl':sec_url,'note':'同报告期优先SEC正式财务；缺项或较新报告期使用Yahoo第三方转录，逐字段标明来源，不补入正式产业因子评分。','error':None}
            except Exception as error:finance=retained(finance,error,stamp)
        return symbol,price,finance
    prices=dict(previous_prices);finance=dict(previous_finance)
    with ThreadPoolExecutor(max_workers=3) as pool:
        for symbol,price,facts in pool.map(job,symbols or SYMBOLS):prices[symbol]=price;finance[symbol]=facts
    result={'schemaVersion':'1','generatedAt':stamp,'checkedAt':stamp,'prices':prices,'finance':finance,'exportAllowed':False,'usageNote':'公开日频市场参考，仅用于本站研究对照；不开放行情CSV，也不宣称交易所实时或专业授权行情。'}
    atomic(path,result);print(f'Research market: {sum(p.get("status")=="ready" for p in prices.values())}/{len(prices)} price series; {sum(p.get("status")=="ready" for p in finance.values())} valuation fact sets.')
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--force',action='store_true');args=parser.parse_args();run(args.force)
