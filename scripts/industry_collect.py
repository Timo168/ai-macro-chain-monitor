"""Company IR adapters. Quarter columns are validated; cumulative cash flow is never a quarter.

SEC is optional; official IR files are primary here because some networks block SEC.
New calendar quarters are probed using known official URL patterns; redesigns need maintenance.
"""
import argparse,calendar,concurrent.futures,hashlib,io,json,re,time
from datetime import date,datetime,timedelta,timezone
from bs4 import BeautifulSoup
from pypdf import PdfReader
from industry_common import ROOT,DATA,now,fetch,definition,observation,persist,atomic
NUM=re.compile(r'(?<![A-Za-z\d])\(?-?\d[\d,]*(?:\.\d+)?\)?(?![A-Za-z])')
NAMES={'capex':('现金资本开支','Cash purchases of property and equipment'),'revenue':('营业收入','Revenue'),'operating_cash_flow':('营业现金流','Operating cash flow'),'free_cash_flow':('自由现金流（现金购置口径）','Operating cash flow less cash PPE purchases'),'capex_ratio':('资本开支占收入比例','Cash capex / revenue'),'cloud_revenue':('云业务收入','Cloud segment revenue'),'cloud_profit':('云业务营业利润','Cloud segment operating income'),'cloud_margin':('云业务营业利润率','Cloud segment operating margin'),'cloud_growth':('Azure及其他云服务收入增速','Azure and other cloud services revenue growth'),'gross_margin':('GAAP毛利率','GAAP gross margin'),'datacenter_revenue':('数据中心业务收入','Data Center revenue'),'inventory':('期末库存','Inventories'),'advertising_revenue':('广告业务收入','Advertising revenue'),'finance_lease_payments':('融资租赁本金支付','Principal payments on finance leases')}
IR={'MSFT':'https://www.microsoft.com/en-us/investor/earnings/','GOOG':'https://abc.xyz/investor/earnings/','AMZN':'https://ir.aboutamazon.com/quarterly-results/default.aspx','META':'https://investor.atmeta.com/financials/','ORCL':'https://investor.oracle.com/financials/default.aspx','NVDA':'https://investor.nvidia.com/financial-info/financial-reports/default.aspx'}
def numbers(text):return [float(v.replace(',','').replace('(','-').replace(')','')) for v in NUM.findall(text)]
def row_numbers(rows,label,occurrence=0):
 matches=[r for r in rows if r and re.fullmatch(label,r[0],re.I)]
 if len(matches)<=occurrence:return []
 return numbers(' '.join(matches[occurrence][1:]))
def quarter_dates(entity,year,q):
 if entity=='MSFT':m={1:9,2:12,3:3,4:6}[q];y=year-1 if q<3 else year
 elif entity=='ORCL':m={1:8,2:11,3:2,4:5}[q];y=year-1 if q<3 else year
 else:y=year;m=q*3
 end=date(y,m,calendar.monthrange(y,m)[1]);start_month=m-2;start_year=y
 if start_month<1:start_month+=12;start_year-=1
 return date(start_year,start_month,1).isoformat(),end.isoformat()
def html_tables(raw):
 soup=BeautifulSoup(raw,'html.parser');tables=[]
 for t in soup.find_all('table'):
  rows=[[' '.join(c.get_text(' ',strip=True).split()) for c in r.find_all(['td','th'],recursive=False)] for r in t.find_all('tr') if not r.find('table')]
  tables.append(rows)
 return soup,tables
def extract_microsoft(raw,year,q):
 soup,tables=html_tables(raw);result={}
 for family,label in [('revenue','Total revenue'),('capex','Additions to property and equipment'),('operating_cash_flow','Net cash from operations')]:
  table=next((r for r in tables if any(re.fullmatch(label,x[0],re.I) for x in r if x) and 'Three Months Ended' in ' '.join(' '.join(x) for x in r[:6])),None)
  if table is None:continue
  values=row_numbers(table,label)
  if len(values)>=2:result[family]=values[:2]
 segment=next((r for r in reversed(tables) if any(x and x[0]=='Intelligent Cloud' for x in r)),None)
 if segment:
  i=next(i for i,r in enumerate(segment) if r and r[0]=='Intelligent Cloud');subset=segment[i+1:i+7]
  for family,label in [('cloud_revenue','Revenue'),('cloud_profit','Operating income')]:
   values=row_numbers(subset,label)
   if len(values)>=2:result[family]=values[:2]
 text=' '.join(soup.get_text(' ',strip=True).split());match=re.search(r'Azure and other cloud services revenue (?:increased|grew) (\d+(?:\.\d+)?)%',text,re.I)
 if match:result['cloud_growth']=[float(match.group(1))]
 return result
def extract_pdf(raw,entity,year,q):
 text='\n'.join(p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages);lines=[' '.join(s.split()) for s in text.splitlines()];result={};reverse=entity in ('GOOG','AMZN')
 patterns={'revenue':r'Total net sales' if entity=='AMZN' else r'Revenues' if entity=='GOOG' else r'Revenue','capex':r'Purchases of property and equipment','operating_cash_flow':r'Net cash provided by (?:\(used in\) )?operating activities','finance_lease_payments':r'Principal payments on finance leases'}
 for family,pattern in patterns.items():
  line=next((line for line in lines if re.match('^'+pattern+r'\s+[$(\d]',line)),None)
  if not line:continue
  # GOOG Q4 cash-flow statement is annual. Refuse those columns (Q1-Q3 are quarterly).
  if q==4 and family in ('capex','operating_cash_flow','finance_lease_payments'):
   start=text.lower().find('consolidated statements of cash flows');chunk=text[start:start+1600].lower()
   if 'three months' not in chunk:continue
  values=numbers(re.sub('^'+pattern,'',line))
  if len(values)>=2:result[family]=list(reversed(values[:2])) if reverse else values[:2]
 if entity=='GOOG':
  cloud=[numbers(re.sub(r'^Google Cloud\s*','',line)) for line in lines if re.match(r'^Google Cloud\s+[$(\d]',line)]
  if len(cloud)>=2:result['cloud_revenue']=list(reversed(cloud[0][:2]));result['cloud_profit']=list(reversed(cloud[1][:2]))
 if entity=='AMZN':
  # Segment statement repeats Net sales/Operating income in North America, International, AWS order.
  segment=text.find('SEGMENT INFORMATION');segment=text[segment:] if segment>=0 else text
  match=re.search(r'\bAWS\s*\n',segment)
  if match:
   aws=segment[match.end():match.end()+1300]
   for family,label in [('cloud_revenue','Net sales'),('cloud_profit','Operating income')]:
    m=re.search(r'^\s*'+label+r'\s+([^\n]+)',aws,re.M)
    if m:result[family]=list(reversed(numbers(m.group(1))[:2]))
 if entity=='META':
  line=next((x for x in lines if re.match(r'^Advertising\s+[$\d]',x)),None)
  if line:result['advertising_revenue']=numbers(re.sub(r'^Advertising','',line))[:2]
 return result
def extract_nvidia(raw,year,q):
 soup,tables=html_tables(raw);table=next((r for r in tables if r and r[0] and r[0][0]=='GAAP'),None)
 if not table:raise ValueError('NVIDIA GAAP summary not found')
 result={}
 for f,label in [('revenue','Revenue'),('gross_margin','Gross margin')]:
  vals=row_numbers(table,label)
  if len(vals)>=3:result[f]=[vals[0],vals[2]]
 text=' '.join(soup.get_text(' ',strip=True).split());m=re.search(r'Data Center revenue(?: of| was)? \$(\d+(?:\.\d+)?) billion',text,re.I)
 if m:result['datacenter_revenue']=[float(m.group(1))*1000]
 # Fiscal dates are explicitly disclosed, not calendar quarter ends.
 m=re.search(r'(?:quarter|fiscal 20\d\d)[^.!]{0,100}?ended ([A-Z][a-z]+ \d{1,2},? 20\d\d)',text)
 end=datetime.strptime(m.group(1).replace(',',''),'%B %d %Y').date().isoformat() if m else None
 if not end:raise ValueError('NVIDIA actual fiscal end not found')
 return result,end
def sources():
 items=[]
 # Historical manifests are explicit and new calendar releases are probed up to today's year.
 today=date.today();lastyear=today.year
 for fy in range(2024,lastyear+2):
  for q in range(1,5):
   start,end=quarter_dates('MSFT',fy,q)
   if end>today.isoformat():continue
   items.append({'entity':'MSFT','year':fy,'q':q,'url':f'https://www.microsoft.com/en-us/investor/earnings/fy-{fy}-q{q}/press-release-webcast'})
 for y in range(2025,lastyear+1):
  for q in range(1,5):
   if quarter_dates('GOOG',y,q)[1]>today.isoformat():continue
   items.append({'entity':'GOOG','year':y,'q':q,'url':f'https://s206.q4cdn.com/479360582/files/doc_financials/{y}/q{q}/{y}q{q}-alphabet-earnings-release.pdf'})
   items.append({'entity':'AMZN','year':y,'q':q,'url':f'https://s2.q4cdn.com/299287126/files/doc_earnings/{y}/q{q}/earnings-result/AMZN-Q{q}-{y}-Earnings-Release.pdf'})
   word={1:'First',2:'Second',3:'Third',4:'Fourth'}[q]
   items.append({'entity':'META','year':y,'q':q,'url':f'https://s21.q4cdn.com/399680738/files/doc_news/Meta-Reports-{word}-Quarter-{y}-Results-{y}.pdf'})
 for fy,q in [(2026,1),(2026,2),(2026,3),(2026,4),(2027,1),(2027,2)]:
  word={1:'first',2:'second',3:'third',4:'fourth'}[q];items.append({'entity':'NVDA','year':fy,'q':q,'url':f'https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-{word}-quarter-fiscal-{fy}'})
 return items
def load_one(item):
 entity,year,q,url=[item[k] for k in ('entity','year','q','url')];key=hashlib.sha256(url.encode()).hexdigest();cache=DATA/'parsed';cache.mkdir(exist_ok=True);path=cache/(key+'.json')
 old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
 # Recheck latest and comparative releases daily; older history weekly for revisions.
 age=1 if year>=date.today().year else 7
 if old and datetime.now(timezone.utc)-datetime.fromisoformat(old['checkedAt'])<timedelta(days=age) and old.get('parserVersion')=='2':return old
 try:
  raw,stamp,version=fetch(url);start,end=quarter_dates(entity,year,q)
  if entity=='MSFT':values=extract_microsoft(raw,year,q)
  elif entity=='NVDA':values,end=extract_nvidia(raw,year,q);start=None
  else:values=extract_pdf(raw,entity,year,q)
  if not values.get('revenue'):raise ValueError('季度收入解析校验失败')
  result={**item,'parserVersion':'2','values':values,'start':start,'end':end,'fetchedAt':stamp,'checkedAt':now(),'version':version,'status':'ready'};atomic(path,result);return result
 except Exception as e:
  if old:result={**old,'checkedAt':now(),'status':'cached','error':str(e)}
  else:result={**item,'values':{},'checkedAt':now(),'status':'fetch_failed','error':str(e)}
  atomic(path,result);return result
def run():
 path=DATA/'companies.json';old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'series':{}};result={'schemaVersion':'1','generatedAt':now(),'definitions':[],'series':{},'projects':[],'events':[]};records=[]
 with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
  for record in pool.map(load_one,sources()):records.append(record);print(record['entity'],record['year'],record['q'],record['status'],flush=True)
 samples={}
 for record in sorted(records,key=lambda r:(r.get('end',''),r.get('fetchedAt',''))):
  if not record['values']:continue
  entity=record['entity'];year=record['year'];q=record['q']
  for family,values in record['values'].items():
   id=entity+'.'+family
   for i,v in enumerate(values[:2]):
    start,end=quarter_dates(entity,year-i,q)
    if entity=='NVDA':
     if i>0:continue # prior fiscal date must be independently fetched, never guess 52/53-week dates
     start,end=record['start'],record['end']
     previous=[r for r in records if r['entity']=='NVDA' and r.get('end') and r['end']<end and r.get('values')]
     if previous:
      previous_end=max(r['end'] for r in previous)
      if 75<=(date.fromisoformat(end)-date.fromisoformat(previous_end)).days<=105:start=(date.fromisoformat(previous_end)+timedelta(days=1)).isoformat()
    if i==0 and entity!='NVDA':start,end=record['start'],record['end']
    rawv=v;v=abs(v) if family in ('capex','finance_lease_payments') else v;scale=1 if family in ('gross_margin','cloud_growth') else 100
    p=observation(id,end,v/scale,record['url'],record['fetchedAt'],record['version'],start,f'FY{year-i} Q{q}',formula='原始百万美元 / 100 = 亿美元'+('；现金流出取正值展示' if family in ('capex','finance_lease_payments') else '') if scale==100 else '公司直接披露百分比',items={NAMES[family][1]:rawv,'original_unit':'USD million' if scale==100 else '%','column':'current quarter' if i==0 else 'prior-year comparable quarter'});p['originalValue']=rawv;p['originalUnit']='USD million' if scale==100 else '%';p['originalCurrency']='USD';samples.setdefault(id,{})[end]=p
 for id,bydate in samples.items():
  entity,family=id.split('.');category='semiconductor' if entity=='NVDA' else 'cloud' if family.startswith('cloud') or family=='advertising_revenue' else 'capex'
  name,en=NAMES[family]
  if family=='cloud_revenue':name={'MSFT':'Intelligent Cloud收入（非Azure单项）','GOOG':'Google Cloud收入','AMZN':'AWS收入'}.get(entity,name)
  if family=='cloud_profit':name={'MSFT':'Intelligent Cloud营业利润','GOOG':'Google Cloud营业利润','AMZN':'AWS营业利润'}.get(entity,name)
  method='季度直接披露值，保留实际财季日期。现金资本开支不含非现金融资租赁购置，不等于纯AI投入。' if family=='capex' else '公司正式财报季度数值；百万美元转换为亿美元。业务分部口径单独核对。'
  if entity=='NVDA':method+=' NVIDIA按52/53周财年，期末采用公告日历日期，期初仅在前一财季期末已知时确定，缺失则留空；不与自然季度等同。'
  d=definition(id,name,en,category,family,entity,entity+' Investor Relations',IR[entity],'%' if family in ('gross_margin','cloud_growth') else '亿美元',method=method);result['definitions'].append(d)
  prior={p['periodEnd']:p for p in old.get('series',{}).get(id,{}).get('observations',[])};prior.update(bydate)
  observations=sorted(prior.values(),key=lambda p:p['periodEnd']);latest=observations[-1]
  failed=any(r['url']==latest['sourceUrl'] and r['status']!='ready' for r in records)
  result['series'][id]={'observations':observations,'status':'cached' if failed else 'ready','fetchedAt':latest['fetchedAt'],'checkedAt':now(),'error':'最新观测来源刷新失败，保留成功版本' if failed else None}
 # Derived values use exactly matching actual quarter dates and preserve both raw operands.
 for entity in ['MSFT','GOOG','AMZN','META','ORCL']:
  for family,a,b,ratio in [('capex_ratio','capex','revenue',True),('free_cash_flow','operating_cash_flow','capex',False),('cloud_margin','cloud_profit','cloud_revenue',True)]:
   left=result['series'].get(entity+'.'+a,{}).get('observations',[]);right={p['periodEnd']:p for p in result['series'].get(entity+'.'+b,{}).get('observations',[])};pts=[]
   for p in left:
    other=right.get(p['periodEnd'])
    if not other or other['periodStart']!=p['periodStart'] or (ratio and other['value']<=0):continue
    value=p['value']/other['value']*100 if ratio else p['value']-other['value'];id=entity+'.'+family;formula=f'{a} / {b} * 100' if ratio else f'{a} - {b}'
    pts.append(dict(observation(id,p['periodEnd'],value,p['sourceUrl'],max(p['fetchedAt'],other['fetchedAt']),hashlib.sha256((p['version']+other['version']+family).encode()).hexdigest(),p['periodStart'],p['fiscalPeriod'],formula,{a:p['value'],b:other['value'],'input_unit':'亿美元','right_source':other['sourceUrl']}),originalUnit='%' if ratio else '亿美元'))
   if pts:
    d=definition(id,*NAMES[family],'cloud' if family=='cloud_margin' else 'capex',family,entity,entity+' Investor Relations',IR[entity],'%' if ratio else '亿美元','calculated',formula+'；所有输入必须为相同实际报告区间。自由现金流口径不扣融资租赁本金，可能不同于公司非GAAP定义。');result['definitions'].append(d);result['series'][id]={'observations':pts,'status':'ready','fetchedAt':pts[-1]['fetchedAt'],'checkedAt':now()}
 # Preserve last successful values even when every current fetch fails.
 for d in old.get('definitions',[]):
  if d['id'] not in result['series']:
   result['definitions'].append(d);result['series'][d['id']]={**old['series'][d['id']],'status':'cached','checkedAt':now(),'error':'未能刷新该指标，保留最后成功观测。'}
 result['sourceRuns']=[{k:r.get(k) for k in ('entity','year','q','url','status','checkedAt','error')} for r in records]
 persist(result,path);print('industry company metrics:',len(result['series']),flush=True)
if __name__=='__main__':run()
