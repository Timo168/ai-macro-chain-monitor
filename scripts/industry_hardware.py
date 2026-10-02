"""Official Dell/AMD fiscal tables and TSMC monthly reporting, preserving reporting currencies."""
import argparse,calendar,hashlib,json,re,sys
from datetime import date,datetime,timedelta
from bs4 import BeautifulSoup
from industry_common import DATA,now,definition,observation,persist
from industry_releases import fetch_official as fetch
from industry_collect import html_tables,row_numbers,dynamic_sources,validate_fiscal_end,merge_ingested,source_publication
FORCE='--force' in sys.argv
DATE=re.compile(r'([A-Z][a-z]+ \d{1,2}\s*,?\s*20\d\d)')
def dates(rows):
 for row in rows[:8]:
  matches=DATE.findall(' '.join(row))
  if len(matches)>=2:return [datetime.strptime(re.sub(r'\s*,\s*',', ',m),'%B %d, %Y').date().isoformat() for m in matches]
 return []

AMD_RELEASES=(
 ('https://ir.amd.com/news-events/press-releases/detail/1284/amd-reports-first-quarter-2026-financial-results','2026-05-05'),
 ('https://ir.amd.com/financial-information/sec-filings/content/0000002488-26-000121/q22026991.htm','2026-08-04'),
)

def parse_dell_release(raw,year,q):
 soup,tables=html_tables(raw);text=' '.join(soup.get_text(' ',strip=True).split());word={1:'first',2:'second',3:'third',4:'fourth'}[q]
 if not re.search(r'Dell Technologies (?:Delivers|Announces) '+word+r'[- ]Quarter(?: and Full[- ]Year)? Fiscal '+str(year),text,re.I):raise ValueError('Dell公告财年/季度不一致')
 pnl=next(t for t in tables if row_numbers(t,'Total net revenue') and 'Three Months Ended' in ' '.join(' '.join(r) for r in t[:6]))
 periods=dates(pnl)[:2];revenue=row_numbers(pnl,'Total net revenue');gross=row_numbers(pnl,'Gross margin')
 segment=next(t for t in tables if row_numbers(t,'AI-optimized servers'))
 if len(periods)!=2 or periods!=dates(segment)[:2] or 'millions' not in ' '.join(' '.join(r) for r in pnl[:6]).lower() or 'Three Months Ended' not in ' '.join(' '.join(r) for r in segment[:6]):raise ValueError('Dell季度收入与分部日期/百万美元单位不一致')
 validate_fiscal_end('DELL',year,q,periods[0]);validate_fiscal_end('DELL',year-1,q,periods[1])
 values={'revenue':revenue,'gross_profit':gross}
 for family,label in [('ai_server_revenue','AI-optimized servers'),('server_revenue','Traditional servers and networking'),('storage_revenue','Storage')]:values[family]=row_numbers(segment,label)
 if any(len(v)<2 for v in values.values()) or any(v<=0 for v in revenue[:2]):raise ValueError('Dell季度收入/分部数值不足')
 balance=next((t for t in tables if row_numbers(t,'Inventories')),None);inventory=[]
 if balance:
  balance_values=row_numbers(balance,'Inventories');balance_dates=dates(balance)
  if len(balance_values)<len(balance_dates[:2]):raise ValueError('Dell库存列与日期不一致')
  inventory=[{'periodEnd':end,'value':balance_values[i]} for i,end in enumerate(balance_dates[:2])]
 return {'periods':periods,'values':{key:value[:2] for key,value in values.items()},'inventory':inventory}

def hardware_sources(entity):
 if entity=='DELL':
  bootstrap=[{'entity':'DELL','year':2027,'q':q,'url':f'https://investors.delltechnologies.com/news-releases/news-release-details/dell-technologies-delivers-{word}-quarter-fiscal-2027-financial'} for q,word in [(1,'first'),(2,'second')]]
 elif entity=='AMD':bootstrap=[{'entity':'AMD','year':2026,'q':q,'url':url,'publishedAt':published} for q,(url,published) in enumerate(AMD_RELEASES,1)]
 else:raise ValueError('Unsupported dynamic hardware entity')
 return dynamic_sources(entity,bootstrap)

def targeted_sources(entity,selected):
 items=hardware_sources(entity) if entity in selected else []
 latest=max(((item['year'],item['q']) for item in items),default=None)
 return [dict(item,_force=FORCE and (item['year'],item['q'])==latest) for item in items]

def parse_amd_release(raw):
 _,tables=html_tables(raw)
 table=next(t for t in tables if row_numbers(t,'Data Center Segment') and any('Net Revenue:' in ' '.join(r) for r in t))
 periods=dates(table)[:3]
 revenue=row_numbers(table,'Total net revenue');center=row_numbers(table,'Data Center Segment');profit=row_numbers(table,'Data Center Segment',1)
 pnl=next(t for t in tables if row_numbers(t,'Net revenue') and row_numbers(t,'Gross margin'))
 margin=row_numbers(pnl,'Gross margin')
 if len(periods)!=3 or dates(pnl)[:3]!=periods or any(len(values)<3 for values in [revenue,center,profit,margin]):
  raise ValueError('AMD dated three-quarter segment and GAAP columns do not agree')
 return [{'periodEnd':end,'fiscalPeriod':f'FY{end[:4]} Q{(int(end[5:7])+2)//3}','datacenter_revenue':center[i],'revenue':revenue[i],'datacenter_profit':profit[i],'gross_margin':margin[i]} for i,end in enumerate(periods)]
def run(entities=None):
 selected=set(entities or ('DELL','AMD','TSM'))
 path=DATA/'hardware.json';old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {};defs={};points={};errors={};stamps={};records=[]
 def add(id,name,family,entity,unit,value_type,url,end,value,stamp,version,items,fiscal=None,start=None,published=None):
  category='servers' if entity=='DELL' else 'semiconductor';d=definition(id,name,name,category,family,entity,entity+' Investor Relations',url,unit,value_type,'公司正式表格；财季期末按源表日期，期初仅在相邻财季已知时补充。保留原币种，AI服务器与传统服务器分开，不拼接口径。',frequency='monthly' if entity=='TSM' else 'quarterly');d['currency']='TWD' if entity=='TSM' else 'USD';d['aggregation']='sum' if entity=='TSM' else 'none';defs[id]=d
  points.setdefault(id,{})[end]=observation(id,end,value,url,stamp,version,start,fiscal,formula='原始百万币种 / 100 = 亿币种' if unit!='%' else '毛利额 / 收入 * 100' if value_type=='calculated' else '源表直接披露百分比',items=items,published=published);stamps[id]=stamp
 for item in targeted_sources('DELL',selected):
  url=item['url'];year=item['year'];q=item['q'];published=item.get('publishedAt')
  try:
   raw,stamp,version=fetch(url,force=item['_force']);parsed=parse_dell_release(raw,year,q);periods=parsed['periods'];revenue=parsed['values']['revenue'];gross=parsed['values']['gross_profit']
   published=published or source_publication(item,raw,periods[0])
   for i,end in enumerate(periods):
    fiscal=f'FY{year-i} Q{q}';add('DELL.revenue','营业收入','revenue','DELL','亿美元','reported',url,end,revenue[i]/100,stamp,version,{'Total net revenue USD million':revenue[i]},fiscal,published=published)
    add('DELL.gross_margin','GAAP毛利率','gross_margin','DELL','%','calculated',url,end,gross[i]/revenue[i]*100,stamp,version,{'Gross profit USD million':gross[i],'Revenue USD million':revenue[i]},fiscal,published=published)
   for family,name,label in [('ai_server_revenue','AI优化服务器收入','AI-optimized servers'),('server_revenue','传统服务器与网络收入','Traditional servers and networking'),('storage_revenue','存储设备收入','Storage')]:
    values=parsed['values'][family]
    for i,end in enumerate(periods):add('DELL.'+family,name,'server_revenue' if family=='ai_server_revenue' else family,'DELL','亿美元','reported',url,end,values[i]/100,stamp,version,{label+' USD million':values[i]},f'FY{year-i} Q{q}',published=published)
   for row in parsed['inventory']:add('DELL.inventory','期末库存','inventory','DELL','亿美元','reported',url,row['periodEnd'],row['value']/100,stamp,version,{'Inventories USD million':row['value']},published=published)
   records.append({**item,'publishedAt':published,'end':periods[0],'values':parsed['values'],'fetchedAt':stamp,'parsedAt':now(),'version':version,'status':'ready','checkedAt':now()})
   errors.pop('DELL',None)
  except Exception as e:errors['DELL']=str(e);records.append({**item,'values':{},'status':'fetch_failed','checkedAt':now(),'error':str(e)})
 # Older releases first, then newer restated/comparative columns take priority.
 for item in targeted_sources('AMD',selected):
  url=item['url'];published=item.get('publishedAt')
  try:
   raw,stamp,version=fetch(url,force=item['_force'])
   rows=parse_amd_release(raw);validate_fiscal_end('AMD',item['year'],item['q'],rows[0]['periodEnd'])
   published=published or source_publication(item,raw,rows[0]['periodEnd'])
   if not re.search(r'in\s+millions',BeautifulSoup(raw,'html.parser').get_text(' ',strip=True),re.I):raise ValueError('AMD原始百万美元单位未确认')
   for row in rows:
    end=row['periodEnd'];fiscal=row['fiscalPeriod']
    for id,name,family in [('AMD.datacenter_revenue','数据中心业务收入','datacenter_revenue'),('AMD.revenue','营业收入','revenue'),('AMD.datacenter_profit','数据中心营业利润','datacenter_profit')]:
     value=row[family];add(id,name,family,'AMD','亿美元','reported',url,end,value/100,stamp,version,{name+' USD million':value},fiscal,published=published)
    add('AMD.gross_margin','GAAP毛利率','gross_margin','AMD','%','reported',url,end,row['gross_margin'],stamp,version,{'GAAP gross margin percent':row['gross_margin']},fiscal,published=published)
   records.append({**item,'publishedAt':published,'end':rows[0]['periodEnd'],'values':rows[0],'fetchedAt':stamp,'parsedAt':now(),'version':version,'status':'ready','checkedAt':now()})
   errors.pop('AMD',None)
  except Exception as e:errors['AMD']=str(e);records.append({**item,'values':{},'status':'fetch_failed','checkedAt':now(),'error':str(e)})
 for year in range(2021,date.today().year+1) if 'TSM' in selected else []:
  url=f'https://investor.tsmc.com/english/monthly-revenue/{year}'
  try:
   raw,stamp,version=fetch(url,force=FORCE and year==date.today().year);soup,tables=html_tables(raw);table=next(t for t in tables if any('Net Revenue' in ' '.join(r) for r in t));text=soup.get_text(' ',strip=True)
   if not ('NT$' in text or 'New Taiwan Dollars' in text) or 'million' not in text.lower():raise ValueError('TSMC original currency/unit not found')
   for row in table:
    if not row or not row[0].strip().rstrip('.').lower()[:3] in [x.lower()[:3] for x in calendar.month_name[1:]]:continue
    m=next(i for i,x in enumerate(calendar.month_name) if i and x.lower()[:3]==row[0].strip().rstrip('.').lower()[:3]);values=row_numbers([row],re.escape(row[0]));end=f'{year}-{m:02}-{calendar.monthrange(year,m)[1]}'
    if not values or end>date.today().isoformat():continue
    add('TSM.revenue','晶圆代工营业收入','revenue','TSM','亿新台币','reported',url,end,values[0]/100,stamp,version,{'Net Revenue NT$ million':values[0]},start=f'{year}-{m:02}-01')
  except Exception as e:errors['TSM']=str(e)
 result={'schemaVersion':'1','generatedAt':now(),'definitions':list(defs.values()),'series':{},'projects':[],'events':[]}
 for id,p in points.items():
  prior={v['periodEnd']:v for v in old.get('series',{}).get(id,{}).get('observations',[])};prior.update(p)
  observations=sorted(prior.values(),key=lambda p:p['periodEnd'])
  if not id.startswith('TSM.'):
   for i,obs in enumerate(observations):
    if i and 75<=(date.fromisoformat(obs['periodEnd'])-date.fromisoformat(observations[i-1]['periodEnd'])).days<=105:obs['periodStart']=(date.fromisoformat(observations[i-1]['periodEnd'])+timedelta(days=1)).isoformat()
  result['series'][id]={'observations':observations,'status':'cached' if id.split('.')[0] in errors else 'ready','fetchedAt':observations[-1]['fetchedAt'],'checkedAt':now(),'error':errors.get(id.split('.')[0])}
 for d in old.get('definitions',[]):
  if d['id'] not in result['series']:result['definitions'].append(d);result['series'][d['id']]=old['series'][d['id']] if d.get('entity') not in selected else {**old['series'][d['id']],'status':'cached','checkedAt':now(),'error':errors.get(d.get('entity'),'来源未返回可解析数据')}
 result['ingestedReleases']=merge_ingested(old.get('ingestedReleases',[]),records)
 result['sourceRuns']=[r for r in old.get('sourceRuns',[]) if r.get('entity') not in selected]+[{key:r.get(key) for key in ('entity','year','q','url','publishedAt','status','checkedAt','error')} for r in records]
 persist(result,path);print('Hardware metrics',len(result['series']),'errors',errors)
if __name__=='__main__':
 cli=argparse.ArgumentParser();cli.add_argument('--force',action='store_true');cli.add_argument('--entity',action='append',choices=('DELL','AMD','TSM'));args=cli.parse_args();run(args.entity)
