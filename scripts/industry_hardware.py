"""Official Dell/AMD fiscal tables and TSMC monthly reporting, preserving reporting currencies."""
import calendar,hashlib,json,re
from datetime import date,datetime,timedelta
from bs4 import BeautifulSoup
from industry_common import DATA,now,fetch,definition,observation,persist
from industry_collect import html_tables,row_numbers
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
def run():
 path=DATA/'hardware.json';old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {};defs={};points={};errors={};stamps={}
 def add(id,name,family,entity,unit,value_type,url,end,value,stamp,version,items,fiscal=None,start=None,published=None):
  category='servers' if entity=='DELL' else 'semiconductor';d=definition(id,name,name,category,family,entity,entity+' Investor Relations',url,unit,value_type,'公司正式表格；财季期末按源表日期，期初仅在相邻财季已知时补充。保留原币种，AI服务器与传统服务器分开，不拼接口径。',frequency='monthly' if entity=='TSM' else 'quarterly');d['currency']='TWD' if entity=='TSM' else 'USD';d['aggregation']='sum' if entity=='TSM' else 'none';defs[id]=d
  points.setdefault(id,{})[end]=observation(id,end,value,url,stamp,version,start,fiscal,formula='原始百万币种 / 100 = 亿币种' if unit!='%' else '毛利额 / 收入 * 100' if value_type=='calculated' else '源表直接披露百分比',items=items,published=published);stamps[id]=stamp
 for q,word in [(1,'first'),(2,'second')]:
  url=f'https://investors.delltechnologies.com/news-releases/news-release-details/dell-technologies-delivers-{word}-quarter-fiscal-2027-financial'
  try:
   raw,stamp,version=fetch(url);soup,tables=html_tables(raw);pnl=next(t for t in tables if row_numbers(t,'Total net revenue') and 'Three Months Ended' in ' '.join(' '.join(r) for r in t[:6]));periods=dates(pnl)[:2];revenue=row_numbers(pnl,'Total net revenue');gross=row_numbers(pnl,'Gross margin')
   for i,end in enumerate(periods):
    fiscal=f'FY{2027-i} Q{q}';add('DELL.revenue','营业收入','revenue','DELL','亿美元','reported',url,end,revenue[i]/100,stamp,version,{'Total net revenue USD million':revenue[i]},fiscal)
    add('DELL.gross_margin','GAAP毛利率','gross_margin','DELL','%','calculated',url,end,gross[i]/revenue[i]*100,stamp,version,{'Gross profit USD million':gross[i],'Revenue USD million':revenue[i]},fiscal)
   segment=next(t for t in tables if row_numbers(t,'AI-optimized servers'))
   for family,name,label in [('ai_server_revenue','AI优化服务器收入','AI-optimized servers'),('server_revenue','传统服务器与网络收入','Traditional servers and networking'),('storage_revenue','存储设备收入','Storage')]:
    values=row_numbers(segment,label)
    for i,end in enumerate(periods):add('DELL.'+family,name,'server_revenue' if family=='ai_server_revenue' else family,'DELL','亿美元','reported',url,end,values[i]/100,stamp,version,{label+' USD million':values[i]},f'FY{2027-i} Q{q}')
   balance=next(t for t in tables if row_numbers(t,'Inventories'));values=row_numbers(balance,'Inventories');ends=dates(balance)
   for i,end in enumerate(ends[:2]):add('DELL.inventory','期末库存','inventory','DELL','亿美元','reported',url,end,values[i]/100,stamp,version,{'Inventories USD million':values[i]})
  except Exception as e:errors['DELL']=str(e)
 # Older releases first, then newer restated/comparative columns take priority.
 for url,published in AMD_RELEASES:
  try:
   raw,stamp,version=fetch(url)
   for row in parse_amd_release(raw):
    end=row['periodEnd'];fiscal=row['fiscalPeriod']
    for id,name,family in [('AMD.datacenter_revenue','数据中心业务收入','datacenter_revenue'),('AMD.revenue','营业收入','revenue'),('AMD.datacenter_profit','数据中心营业利润','datacenter_profit')]:
     value=row[family];add(id,name,family,'AMD','亿美元','reported',url,end,value/100,stamp,version,{name+' USD million':value},fiscal,published=published)
    add('AMD.gross_margin','GAAP毛利率','gross_margin','AMD','%','reported',url,end,row['gross_margin'],stamp,version,{'GAAP gross margin percent':row['gross_margin']},fiscal,published=published)
  except Exception as e:errors['AMD']=str(e)
 for year in range(2021,date.today().year+1):
  url=f'https://investor.tsmc.com/english/monthly-revenue/{year}'
  try:
   raw,stamp,version=fetch(url);soup,tables=html_tables(raw);table=next(t for t in tables if any('Net Revenue' in ' '.join(r) for r in t));text=soup.get_text(' ',strip=True)
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
  if d['id'] not in result['series']:result['definitions'].append(d);result['series'][d['id']]={**old['series'][d['id']],'status':'cached','checkedAt':now(),'error':errors.get(d.get('entity'),'来源未返回可解析数据')}
 persist(result,path);print('Hardware metrics',len(result['series']),'errors',errors)
if __name__=='__main__':run()
