"""Additional official company metrics and BLS price proxy. No estimates fill missing facts."""
import calendar,concurrent.futures,io,json,re
from datetime import date,datetime,timedelta
from urllib.parse import urljoin
from pypdf import PdfReader
from industry_common import DATA,fetch,definition,observation,persist,now
from industry_collect import html_tables,numbers,quarter_dates,row_numbers
from industry_hardware import dates
from collect import parse_csv

class Builder:
 def __init__(self):self.defs={};self.points={};self.errors={}
 def add(self,id,name,family,entity,category,unit,url,stamp,version,end,value,items,*,frequency='quarterly',kind='reported',method='',start=None,fiscal=None,eligible=True):
  d=definition(id,name,name,category,family,entity,entity+' official disclosure',url,unit,kind,method,eligible,frequency)
  d['aggregation']='none' if frequency in ('quarterly','annual') else 'mean';d['sourceAdapter']='extended';self.defs[id]=d
  self.points.setdefault(id,{})[end]=observation(id,end,value,url,stamp,version,start,fiscal,method,items)
 def microsoft(self):
  for fy in [2024,2025,2026]:
   url=f'https://www.microsoft.com/en-us/investor/earnings/fy-{fy}-q4/metrics'
   raw,stamp,version=fetch(url);_,tables=html_tables(raw)
   table=next(t for t in tables if any(r and r[0].startswith('Commercial remaining performance obligation ') for r in t));header=next(r for r in table if r and 'in billions' in r[0])
   row=next(r for r in table if r and r[0].startswith('Commercial remaining performance obligation '))
   for i,label in enumerate(header):
    m=re.fullmatch(r'Q([1-4])(\d\d)',label)
    if not m:continue
    q,year=int(m[1]),2000+int(m[2]);start,end=quarter_dates('MSFT',year,q);value=numbers(row[i])[0]
    self.add('MSFT.backlog','商业剩余履约义务','backlog','MSFT','cloud','亿美元',url,stamp,version,end,value*10,{'reported_billion_usd':value},method='商业RPO包含递延收入和未来将开票确认金额，非Azure单项订单。十亿美元×10；期末存量，不对季度求和。',fiscal=f'FY{year} Q{q}')
 def hpe(self):
  # Latest official PDF also supplies explicitly restated prior-year comparison columns.
  url='https://investors.hpe.com/~/media/Files/H/HP-Enterprise-IR/documents/q3-2026/q3-2026-earnings-press-release.pdf'
  raw,stamp,version=fetch(url);pages=[p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages]
  segment=next(p for p in pages if 'Server' in p and 'Net Revenue:' in p and 'Change (%)' in p)
  header=re.search(r'([A-Z][a-z]+ \d+, 20\d\d)\s+([A-Z][a-z]+ \d+, 20\d\d)\s+([A-Z][a-z]+ \d+, 20\d\d)',segment)
  if not header:raise ValueError('HPE actual quarter header not found')
  ends=[datetime.strptime(v,'%B %d, %Y').date().isoformat() for v in header.groups()]
  server=numbers(re.search(r'^\s*Server\s+([^\n]+)',segment,re.M)[1])[:3]
  margin=next(p for p in pages if re.search(r'^\s*GAAP gross profit margin\s+[\d]',p,re.M))
  margins=numbers(re.search(r'^\s*GAAP gross profit margin\s+([^\n]+)',margin,re.M)[1])[:3]
  for i,end in enumerate(ends):
   self.add('HPE.server_revenue','服务器收入（重述可比口径）','server_revenue','HPE','servers','亿美元',url,stamp,version,end,server[i]/100,{'Server_USD_million':server[i]},method='HPE FY2026组织调整后的Server口径，比较期按公司重述列。含传统与AI服务器，不等于AI服务器销售。百万美元÷100。')
   self.add('HPE.gross_margin','GAAP毛利率','gross_margin','HPE','servers','%',url,stamp,version,end,margins[i],{'reported_percent':margins[i]},method='公司披露GAAP毛利率，比较变化使用百分点。')
 def transformer(self):
  code='PCU335311335311G';url='https://fred.stlouisfed.org/graph/fredgraph.csv?id='+code
  raw,stamp,version=fetch(url)
  for p in parse_csv(raw):
   y,m=map(int,p['date'][:7].split('-'));end=f'{y}-{m:02}-{calendar.monthrange(y,m)[1]}'
   if end>date.today().isoformat():continue
   self.add('POWER.equipment_price','通用变压器生产者价格指数','equipment_price','美国BLS','power','指数（1981-06=100）',url,stamp,version,end,p['value'],{'source_series':code,'source_observation_date':p['date']},frequency='monthly',kind='proxy',method='BLS/FRED商业、机构及工业用通用变压器，各电压等级；未经季调；1981年6月=100。制造商价格代理，非某项目设备合同报价。')
 def dell(self):
  reports=[('2025-05-02','FY2026 Q1','a7fdeb66-9194-4027-afa8-a963c1bc1ce9',r'leaving us with a backlog of \$(\d+(?:\.\d+)?) billion'),('2026-01-30','FY2026 Q4','9e5d4126-0f17-4ceb-b26c-a2563b8bcbc9',r'exited with a record \$(\d+(?:\.\d+)?) billion in AI backlog'),('2026-05-01','FY2027 Q1','b63ffff9-b729-403b-a231-c6af05667759',r'exited the quarter with a record \$(\d+(?:\.\d+)?) billion of AI backlog')]
  for end,fiscal,tail,pattern in reports:
   url='https://investors.delltechnologies.com/static-files/'+tail
   raw,stamp,version=fetch(url);text=' '.join(' '.join(p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages).split())
   m=re.search(pattern,text,re.I)
   if not m:raise ValueError('Dell prepared remarks AI backlog not found')
   value=float(m[1]);self.add('DELL.backlog','AI服务器订单余额','backlog','DELL','servers','亿美元',url,stamp,version,end,value*10,{'reported_billion_usd':value},fiscal=fiscal,method='官方电话会管理层已实现的期末AI服务器backlog。十亿美元×10；不取分析师提问中的估计，不将pipeline或未来指引作为订单。已知报告清单，未来新报告地址需维护。')
 def inventory_days(self):
  stocks={};costs={}
  for fy in [2026,2027]:
   for q,word in [(1,'first'),(2,'second')]:
    url=f'https://investors.delltechnologies.com/news-releases/news-release-details/dell-technologies-delivers-{word}-quarter-fiscal-{fy}-financial'
    raw,stamp,version=fetch(url);_,tables=html_tables(raw)
    pnl=next(t for t in tables if row_numbers(t,'Total net revenue') and 'Three Months Ended' in ' '.join(' '.join(r) for r in t[:6]))
    end=dates(pnl)[0];costs[end]=(row_numbers(pnl,'Total net revenue')[0]-row_numbers(pnl,'Gross margin')[0],url,stamp,version,f'FY{fy} Q{q}')
    balance=next(t for t in tables if row_numbers(t,'Inventories'))
    for end,value in zip(dates(balance)[:2],row_numbers(balance,'Inventories')[:2]):stocks[end]=(value,url)
  for end,(cost,url,stamp,version,fiscal) in costs.items():
   previous=sorted(d for d in stocks if d<end)
   if not previous or end not in stocks:continue
   start=previous[-1];days=(date.fromisoformat(end)-date.fromisoformat(start)).days
   if not 80<=days<=100:continue
   a,b=stocks[start][0],stocks[end][0]
   self.add('DELL.inventory_days','库存周转天数（公司整体）','inventory_days','DELL','servers','天',url,stamp,version,end,(a+b)/2/cost*days,{'begin_inventory_million':a,'end_inventory_million':b,'quarter_cost_million':cost,'quarter_days':days,'begin_date':start,'begin_source_url':stocks[start][1],'end_source_url':stocks[end][1]},kind='calculated',start=(date.fromisoformat(start)+timedelta(days=1)).isoformat(),fiscal=fiscal,method='(期初库存+期末库存)/2 ÷ 当季销售成本 × 财季实际天数。销售成本=GAAP收入−GAAP毛利额；公司整体库存含PC等业务，非AI服务器单项。只计算有相邻季末库存的季度。')
 def tsm(self):
  for year,q in [(2025,2),(2025,3),(2025,4),(2026,1),(2026,2)]:
   index=f'https://investor.tsmc.com/english/quarterly-results/{year}/q{q}'
   raw,_,_=fetch(index);soup,_=html_tables(raw)
   url=next(urljoin(index,a['href']) for a in soup.find_all('a',href=True) if a.get_text(' ',strip=True)=='Earnings Release')
   raw,stamp,version=fetch(url);text=' '.join(' '.join(p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages).split())
   m=re.search(r'Advanced technologies, defined as 7\s*-\s*nanometer and more advanced technologies, accounted for (\d+(?:\.\d+)?)%',text,re.I)
   if not m:raise ValueError('Stable TSMC <=7nm definition not found')
   start,end=quarter_dates('GOOG',year,q);value=float(m[1])
   self.add('TSM.advanced_node_share','7纳米及以下制程晶圆收入占比','advanced_node_share','TSM','semiconductor','%',url,stamp,version,end,value,{'reported_percent':value,'node_definition':'7nm and below'},method='分母为晶圆收入，固定7纳米及以下定义，不是纯AI收入占比；不与更改节点定义的数据拼接。',start=start,fiscal=f'FY{year} Q{q}')
 def run(self):
  jobs={'MSFT':self.microsoft,'HPE':self.hpe,'PPI':self.transformer,'TSM':self.tsm,'DELL':self.dell,'DELL.inventory_days':self.inventory_days}
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
   futures={pool.submit(f):name for name,f in jobs.items()}
   for future in concurrent.futures.as_completed(futures):
    name=futures[future]
    try:future.result();print(name,'OK',flush=True)
    except Exception as e:self.errors[name]=str(e);print(name,str(e),flush=True)
  path=DATA/'extended.json';old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'definitions':[],'series':{}}
  result={'definitions':list(self.defs.values()),'series':{},'projects':[],'events':[],'generatedAt':now()}
  for id,points in self.points.items():
   merged={p['periodEnd']:p for p in old['series'].get(id,{}).get('observations',[])};merged.update(points);obs=sorted(merged.values(),key=lambda p:p['periodEnd'])
   error=self.errors.get(id) or self.errors.get('PPI' if id.startswith('POWER.') else id.split('.')[0]);result['series'][id]={'observations':obs,'status':'cached' if error else 'ready','fetchedAt':obs[-1]['fetchedAt'],'checkedAt':now(),'error':error}
  for d in old['definitions']:
   if d['id'] not in result['series']:result['definitions'].append(d);result['series'][d['id']]={**old['series'][d['id']],'status':'cached','checkedAt':now(),'error':'来源未返回新数据，保留缓存'}
  persist(result,path);print('Extended metrics',len(result['series']),flush=True)
if __name__=='__main__':Builder().run()
