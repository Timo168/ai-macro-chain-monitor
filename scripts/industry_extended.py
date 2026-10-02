"""Additional official company metrics and BLS price proxy. No estimates fill missing facts."""
import argparse,calendar,concurrent.futures,io,json,re
from datetime import date,datetime,timedelta
from urllib.parse import urljoin,urlparse
from bs4 import BeautifulSoup
from pypdf import PdfReader
from industry_common import DATA,fetch,definition,observation,persist,now
from industry_collect import html_tables,numbers,quarter_dates,row_numbers
from industry_hardware import dates
from collect import parse_csv

HPE_HISTORY=(
 {'entity':'HPE','fiscalYear':2026,'quarter':2,'publishedAt':'2026-06-01','url':'https://investors.hpe.com/~/media/Files/H/HP-Enterprise-IR/documents/q2-2026/q2-2026-earnings-press-release.pdf'},
 {'entity':'HPE','fiscalYear':2026,'quarter':3,'publishedAt':'2026-09-02','url':'https://investors.hpe.com/~/media/Files/H/HP-Enterprise-IR/documents/q3-2026/q3-2026-earnings-press-release.pdf'})
HPE_METHOD='HPE FY2026组织调整后的Server口径，比较期按公司重述列；仅拼接明确披露Cloud & AI和Server的可比口径，未来部门改名或定义变化需重新核验。含传统与AI服务器，不等于AI服务器销售。百万美元÷100。'

def hpe_candidates():
 from industry_releases import candidates
 return candidates('HPE')

def hpe_official_url(url):
 p=urlparse(url)
 return p.scheme=='https' and p.hostname in {'investors.hpe.com','www.hpe.com','hpe.com'} and not p.username

def fetch_hpe_report(url,force=False):
 from industry_releases import fetch_official
 return fetch_official(url,force=force)

def hpe_period(end):
 actual=date.fromisoformat(end)
 if (actual.month,actual.day) not in {(1,31),(4,30),(7,31),(10,31)}:raise ValueError('HPE unexpected actual fiscal-quarter end')
 q={1:1,4:2,7:3,10:4}[actual.month];month=actual.month-2;year=actual.year
 if month<1:month+=12;year-=1
 return f'FY{actual.year} Q{q}',date(year,month,1).isoformat()

def parse_hpe_release(raw,release=None):
 pages=[p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages]
 segment=next((p for p in pages if 'Server' in p and 'Net Revenue:' in p and 'Change (%)' in p),'')
 if 'Cloud & AI' not in segment:raise ValueError('HPE FY2026 restated Cloud & AI segment scope missing')
 header=re.search(r'([A-Z][a-z]+ \d+, 20\d\d)\s+([A-Z][a-z]+ \d+, 20\d\d)\s+([A-Z][a-z]+ \d+, 20\d\d)',segment)
 if not header:raise ValueError('HPE actual quarter header not found')
 ends=[datetime.strptime(v,'%B %d, %Y').date().isoformat() for v in header.groups()]
 server=numbers(re.search(r'^\s*Server\s+([^\n]+)',segment,re.M)[1])
 margin=next((p for p in pages if re.search(r'^\s*GAAP gross profit margin\s+[\d]',p,re.M)),'')
 margin_header=re.search(r'([A-Z][a-z]+ \d+, 20\d\d)\s+([A-Z][a-z]+ \d+, 20\d\d)\s+([A-Z][a-z]+ \d+, 20\d\d)',margin)
 if not margin_header or margin_header.groups()!=header.groups():raise ValueError('HPE margin dates differ from segment dates')
 margins=numbers(re.search(r'^\s*GAAP gross profit margin\s+([^\n]+)',margin,re.M)[1])
 if len(server)<3 or len(margins)<3 or len(set(ends))!=3:raise ValueError('HPE dated quarterly columns incomplete')
 if release:
  current=f"FY{release['fiscalYear']} Q{release['quarter']}"
  if hpe_period(ends[0])[0]!=current:raise ValueError('HPE candidate fiscal identity differs from actual table period')
  if not re.search(r'For the three months ended',margin,re.I):raise ValueError('HPE quarterly gross-margin table required; cumulative margins rejected')
  if not re.search(r'(?:Dollars|In)\s+(?:in\s+)?millions',segment,re.I):raise ValueError('HPE segment revenue unit is not USD millions')
 return [{'periodEnd':end,'periodStart':hpe_period(end)[1],'fiscalPeriod':hpe_period(end)[0],'server_revenue':server[i],'gross_margin':margins[i]} for i,end in enumerate(ends)]

def load_hpe_release(release,force=False):
 url=release['url']
 if not hpe_official_url(url):raise ValueError('HPE report outside official domain')
 raw,stamp,version=fetch_hpe_report(url,force=force)
 if raw.startswith(b'%PDF'):return parse_hpe_release(raw,release),url,stamp,version
 soup=BeautifulSoup(raw,'html.parser');failures=[]
 for a in soup.find_all('a',href=True):
  target=urljoin(url,a['href']);label=a.get_text(' ',strip=True)+' '+target
  if not hpe_official_url(target) or not urlparse(target).path.lower().endswith('.pdf') or not re.search(r'earnings|press.?release|financial.?results',label,re.I):continue
  try:
   pdf,stamp,version=fetch_hpe_report(target,force=force)
   return parse_hpe_release(pdf,release),target,stamp,version
  except Exception as e:failures.append(str(e))
 raise ValueError('HPE official quarterly appendix unavailable or unvalidated'+(': '+'; '.join(failures) if failures else ''))

class Builder:
 def __init__(self,force=False):self.defs={};self.points={};self.errors={};self.ingested=[];self.force=force
 def add(self,id,name,family,entity,category,unit,url,stamp,version,end,value,items,*,frequency='quarterly',kind='reported',method='',start=None,fiscal=None,published=None,eligible=True,estimated=False):
  d=definition(id,name,name,category,family,entity,entity+' official disclosure',url,unit,kind,method,eligible,frequency)
  d['aggregation']='none' if frequency in ('quarterly','annual') else 'mean';d['sourceAdapter']='extended';self.defs[id]=d
  point=observation(id,end,value,url,stamp,version,start,fiscal,method,items,published);point['isEstimated']=estimated
  self.points.setdefault(id,{})[end]=point
 def microsoft(self):
  published_by_fy={2024:'2024-07-30',2025:'2025-07-30',2026:'2026-07-22'}
  for fy in [2024,2025,2026]:
   url=f'https://www.microsoft.com/en-us/investor/earnings/fy-{fy}-q4/metrics'
   raw,stamp,version=fetch(url);_,tables=html_tables(raw)
   table=next(t for t in tables if any(r and r[0].startswith('Commercial remaining performance obligation ') for r in t));header=next(r for r in table if r and 'in billions' in r[0])
   row=next(r for r in table if r and r[0].startswith('Commercial remaining performance obligation '))
   for i,label in enumerate(header):
    m=re.fullmatch(r'Q([1-4])(\d\d)',label)
    if not m:continue
    q,year=int(m[1]),2000+int(m[2]);start,end=quarter_dates('MSFT',year,q);value=numbers(row[i])[0]
    self.add('MSFT.backlog','商业剩余履约义务','backlog','MSFT','cloud','亿美元',url,stamp,version,end,value*10,{'reported_billion_usd':value},method='商业RPO包含递延收入和未来将开票确认金额，非Azure单项订单。十亿美元×10；期末存量，不对季度求和。',fiscal=f'FY{year} Q{q}',published=published_by_fy[fy])
 def hpe(self):
  # Reviewed baseline remains usable; future releases only follow discovered official links.
  failures=[]
  try:discovered=hpe_candidates()
  except Exception as e:discovered=[];failures.append('官方发布发现失败：'+str(e))
  releases=list({(r['fiscalYear'],r['quarter']):r for r in [*HPE_HISTORY,*discovered]}.values())
  for release in sorted(releases,key=lambda r:(r['fiscalYear'],r['quarter'])):
   try:
    rows,url,stamp,version=load_hpe_release(release,force=self.force)
    for row in rows:
     end=row['periodEnd'];fiscal=row['fiscalPeriod'];published=release['publishedAt']
     self.add('HPE.server_revenue','服务器收入（重述可比口径）','server_revenue','HPE','servers','亿美元',url,stamp,version,end,row['server_revenue']/100,{'Server_USD_million':row['server_revenue'],'segmentScope':'FY2026 restated Cloud & AI / Server'},method=HPE_METHOD,start=row['periodStart'],fiscal=fiscal,published=published)
     self.add('HPE.gross_margin','GAAP毛利率','gross_margin','HPE','servers','%',url,stamp,version,end,row['gross_margin'],{'reported_percent':row['gross_margin']},method='公司披露单季GAAP毛利率，比较变化使用百分点；按同一组三个月实际财期与Server表核对。',start=row['periodStart'],fiscal=fiscal,published=published)
    self.ingested.append({**{k:release[k] for k in ('entity','url','fiscalYear','quarter','publishedAt')},'periodEnd':rows[0]['periodEnd'],'parsedAt':stamp,'financialSourceUrl':url})
   except Exception as e:failures.append(f"FY{release['fiscalYear']} Q{release['quarter']}: {e}")
  if failures:raise ValueError('; '.join(failures))
 def transformer(self):
  code='WPU117409';url='https://fred.stlouisfed.org/graph/fredgraph.csv?id='+code
  raw,stamp,version=fetch(url)
  for p in parse_csv(raw):
   y,m=map(int,p['date'][:7].split('-'));end=f'{y}-{m:02}-{calendar.monthrange(y,m)[1]}'
   if end>date.today().isoformat():continue
   self.add('POWER.equipment_price','电力及配电变压器生产者价格指数','equipment_price','美国BLS','power','指数（1999-12=100）',url,stamp,version,end,p['value'],{'source_series':code,'source_observation_date':p['date']},frequency='monthly',kind='proxy',method='BLS/FRED电力及配电变压器（不含零部件）商品PPI；未经季调；1999年12月=100。制造商价格代理，非某项目设备合同报价。')
 def dell(self):
  reports=[('2025-05-02','FY2026 Q1','2025-05-29','a7fdeb66-9194-4027-afa8-a963c1bc1ce9',r'leaving us with a backlog of \$(\d+(?:\.\d+)?) billion'),('2026-01-30','FY2026 Q4','2026-02-26','9e5d4126-0f17-4ceb-b26c-a2563b8bcbc9',r'exited with a record \$(\d+(?:\.\d+)?) billion in AI backlog'),('2026-05-01','FY2027 Q1','2026-05-28','b63ffff9-b729-403b-a231-c6af05667759',r'exited the quarter with a record \$(\d+(?:\.\d+)?) billion of AI backlog')]
  for end,fiscal,published,tail,pattern in reports:
   url='https://investors.delltechnologies.com/static-files/'+tail
   raw,stamp,version=fetch(url);text=' '.join(' '.join(p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages).split())
   m=re.search(pattern,text,re.I)
   if not m:raise ValueError('Dell prepared remarks AI backlog not found')
   value=float(m[1]);self.add('DELL.backlog','AI服务器订单余额','backlog','DELL','servers','亿美元',url,stamp,version,end,value*10,{'reported_billion_usd':value},fiscal=fiscal,published=published,method='官方电话会管理层已实现的期末AI服务器backlog。十亿美元×10；不取分析师提问中的估计，不将pipeline或未来指引作为订单。已知报告清单，未来新报告地址需维护。')
 def vertiv(self):
  reports=[
   ('2025-03-31','FY2025 Q1','2025-04-23','first','https://s205.q4cdn.com/554782763/files/doc_events/2025/04/1/Vertiv-First-Quarter-2025-Results-Presentation.pdf'),
   ('2025-06-30','FY2025 Q2','2025-07-30','second','https://s205.q4cdn.com/554782763/files/doc_financials/2025/q2/Vertiv-Second-Quarter-2025-Results-Presentation.pdf'),
   ('2025-09-30','FY2025 Q3','2025-10-22','third','https://s205.q4cdn.com/554782763/files/doc_financials/2025/q3/Vertiv-Third-Quarter-2025-Results-Presentation.pdf'),
   ('2025-12-31','FY2025 Q4','2026-02-11','fourth','https://s205.q4cdn.com/554782763/files/doc_financials/2025/q4/Vertiv_Fourth-Quarter-2025-Results-Presentation.pdf')]
  method='Vertiv披露的估算合并订单余额：已收到客户采购订单或采购承诺、但尚未交付的产品和服务价值；订单可能被取消、缩减或延期。十亿美元×10换算为亿美元，源值四舍五入至0.1十亿美元。2026年Q1、Q2官方季报及业绩材料未披露新的期末数值，最新观测仍为2025-12-31；不将旧值顺延到未披露季度。'
  failures=[]
  for end,fiscal,published,quarter,url in reports:
   try:
    raw,stamp,version=fetch(url);text=' '.join(' '.join(p.extract_text() or '' for p in PdfReader(io.BytesIO(raw)).pages).split())
    pattern=rf'Strong backlog at end of {quarter} quarter of \$\s*~?([0-9]+(?:\.[0-9]+)?)\s*B'
    m=re.search(pattern,text,re.I)
    if not m:raise ValueError(f'Vertiv {fiscal} backlog anchor not found')
    value=float(m[1])
    self.add('VRT.backlog','估算合并订单余额','backlog','VRT','power','亿美元',url,stamp,version,end,value*10,{'reported_billion_usd':value,'conversion_factor_to_100m_usd':10,'source_precision_billion_usd':0.1,'source_measure':'estimated combined order backlog'},fiscal=fiscal,published=published,method=method,estimated=True)
   except Exception as e:failures.append(f'{fiscal}: {e}')
  if 'VRT.backlog' in self.defs:
   self.defs['VRT.backlog']['latestDisclosureNote']='Vertiv 2026年Q1、Q2官方材料未披露新的期末backlog；2025-12-31为最近已披露观测。'
   self.defs['VRT.backlog']['sourceRounded']=True
  if failures:raise RuntimeError('; '.join(failures))
 def inventory_days(self):
  stocks={};costs={}
  for fy in [2026,2027]:
   for q,word in [(1,'first'),(2,'second')]:
    url=f'https://investors.delltechnologies.com/news-releases/news-release-details/dell-technologies-delivers-{word}-quarter-fiscal-{fy}-financial'
    raw,stamp,version=fetch(url);_,tables=html_tables(raw)
    pnl=next(t for t in tables if row_numbers(t,'Total net revenue') and 'Three Months Ended' in ' '.join(' '.join(r) for r in t[:6]))
    end=dates(pnl)[0];published={(2026,1):'2025-05-29',(2026,2):'2025-08-28',(2027,1):'2026-05-28',(2027,2):'2026-08-27'}[(fy,q)];costs[end]=(row_numbers(pnl,'Total net revenue')[0]-row_numbers(pnl,'Gross margin')[0],url,stamp,version,f'FY{fy} Q{q}',published)
    balance=next(t for t in tables if row_numbers(t,'Inventories'))
    for end,value in zip(dates(balance)[:2],row_numbers(balance,'Inventories')[:2]):stocks[end]=(value,url)
  for end,(cost,url,stamp,version,fiscal,published) in costs.items():
   previous=sorted(d for d in stocks if d<end)
   if not previous or end not in stocks:continue
   start=previous[-1];days=(date.fromisoformat(end)-date.fromisoformat(start)).days
   if not 80<=days<=100:continue
   a,b=stocks[start][0],stocks[end][0]
   self.add('DELL.inventory_days','库存周转天数（公司整体）','inventory_days','DELL','servers','天',url,stamp,version,end,(a+b)/2/cost*days,{'begin_inventory_million':a,'end_inventory_million':b,'quarter_cost_million':cost,'quarter_days':days,'begin_date':start,'begin_source_url':stocks[start][1],'end_source_url':stocks[end][1]},kind='calculated',start=(date.fromisoformat(start)+timedelta(days=1)).isoformat(),fiscal=fiscal,published=published,method='(期初库存+期末库存)/2 ÷ 当季销售成本 × 财季实际天数。销售成本=GAAP收入−GAAP毛利额；公司整体库存含PC等业务，非AI服务器单项。只计算有相邻季末库存的季度。')
 def tsm(self):
  for year,q in [(2025,2),(2025,3),(2025,4),(2026,1),(2026,2)]:
   index=f'https://investor.tsmc.com/english/quarterly-results/{year}/q{q}'
   raw,_,_=fetch(index);soup,_=html_tables(raw)
   url=next(urljoin(index,a['href']) for a in soup.find_all('a',href=True) if a.get_text(' ',strip=True)=='Earnings Release')
   raw,stamp,version=fetch(url);text=' '.join(' '.join(p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages).split())
   m=re.search(r'Advanced technologies, defined as 7\s*-\s*nanometer and more advanced technologies, accounted for (\d+(?:\.\d+)?)%',text,re.I)
   if not m:raise ValueError('Stable TSMC <=7nm definition not found')
   start,end=quarter_dates('GOOG',year,q);value=float(m[1])
   published={(2025,2):'2025-07-17',(2025,3):'2025-10-16',(2025,4):'2026-01-15',(2026,1):'2026-04-16',(2026,2):'2026-07-16'}[(year,q)]
   self.add('TSM.advanced_node_share','7纳米及以下制程晶圆收入占比','advanced_node_share','TSM','semiconductor','%',url,stamp,version,end,value,{'reported_percent':value,'node_definition':'7nm and below'},method='分母为晶圆收入，固定7纳米及以下定义，不是纯AI收入占比；不与更改节点定义的数据拼接。',start=start,fiscal=f'FY{year} Q{q}',published=published)
 def run(self):
  jobs={'MSFT':self.microsoft,'HPE':self.hpe,'PPI':self.transformer,'TSM':self.tsm,'DELL':self.dell,'DELL.inventory_days':self.inventory_days,'VRT':self.vertiv}
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
   futures={pool.submit(f):name for name,f in jobs.items()}
   for future in concurrent.futures.as_completed(futures):
    name=futures[future]
    try:future.result();print(name,'OK',flush=True)
    except Exception as e:self.errors[name]=str(e);print(name,str(e),flush=True)
  path=DATA/'extended.json';old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'definitions':[],'series':{}}
  result={'definitions':list(self.defs.values()),'series':{},'projects':[],'events':[],'generatedAt':now(),'ingestedReleases':list({(r['entity'],r['url'],r['fiscalYear'],r['quarter']):r for r in [*old.get('ingestedReleases',[]),*self.ingested]}.values())}
  for id,points in self.points.items():
   prior=old['series'].get(id,{}).get('observations',[])
   if id=='POWER.equipment_price':prior=[p for p in prior if p.get('originalItems',{}).get('source_series')=='WPU117409']
   merged={p['periodEnd']:p for p in prior};merged.update(points);obs=sorted(merged.values(),key=lambda p:p['periodEnd'])
   job={'DELL.backlog':'DELL','DELL.inventory_days':'DELL.inventory_days','POWER.equipment_price':'PPI','VRT.backlog':'VRT'}.get(id,id.split('.')[0])
   error=self.errors.get(job);series={'observations':obs,'status':'cached' if error else 'ready','fetchedAt':obs[-1]['fetchedAt'],'checkedAt':now(),'error':error}
   if id=='VRT.backlog':series['note']='Vertiv 2026年Q1、Q2官方材料未披露新的期末值；最新真实观测仍是2025年Q4，不向后顺延。'
   result['series'][id]=series
  for d in old['definitions']:
   if d['id'] not in result['series']:result['definitions'].append(d);result['series'][d['id']]={**old['series'][d['id']],'status':'cached','checkedAt':now(),'error':'来源未返回新数据，保留缓存'}
  persist(result,path);print('Extended metrics',len(result['series']),flush=True)
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--force',action='store_true');Builder(force=parser.parse_args().force).run()
