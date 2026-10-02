"""Company IR adapters. Quarter columns are validated; cumulative cash flow is never a quarter.

SEC is optional; official IR files are primary here because some networks block SEC.
New quarters use links discovered on the official release index; dated historical URLs
remain a bootstrap only. Source redesigns fail closed and preserve the previous data.
"""
import argparse,calendar,concurrent.futures,hashlib,io,json,re,time,sys
from datetime import date,datetime,timedelta,timezone
from urllib.parse import urljoin,urlparse
from bs4 import BeautifulSoup
from pypdf import PdfReader
from industry_common import ROOT,DATA,now,definition,observation,persist,atomic
from industry_releases import fetch_official as fetch,validate_release,publication_date,parse_date,DATE_WORD
FORCE='--force' in sys.argv
NUM=re.compile(r'(?<![A-Za-z\d])\(?-?\d[\d,]*(?:\.\d+)?\)?(?![A-Za-z])')
NAMES={'capex':('现金资本开支','Cash purchases of property and equipment'),'revenue':('营业收入','Revenue'),'operating_cash_flow':('营业现金流','Operating cash flow'),'free_cash_flow':('自由现金流（现金购置口径）','Operating cash flow less cash PPE purchases'),'capex_ratio':('资本开支占收入比例','Cash capex / revenue'),'cloud_revenue':('云业务收入','Cloud segment revenue'),'cloud_profit':('云业务营业利润','Cloud segment operating income'),'cloud_margin':('云业务营业利润率','Cloud segment operating margin'),'cloud_growth':('Azure及其他云服务收入增速','Azure and other cloud services revenue growth'),'gross_margin':('GAAP毛利率','GAAP gross margin'),'datacenter_revenue':('数据中心业务收入','Data Center revenue'),'inventory':('期末库存','Inventories'),'advertising_revenue':('广告业务收入','Advertising revenue'),'finance_lease_payments':('融资租赁本金支付','Principal payments on finance leases')}
IR={'MSFT':'https://www.microsoft.com/en-us/investor/earnings/','GOOG':'https://abc.xyz/investor/earnings/','AMZN':'https://ir.aboutamazon.com/quarterly-results/default.aspx','META':'https://investor.atmeta.com/financials/','ORCL':'https://investor.oracle.com/financials/default.aspx','NVDA':'https://investor.nvidia.com/financial-info/financial-reports/default.aspx'}
OFFICIAL_HOSTS={'MSFT':{'www.microsoft.com'},'GOOG':{'abc.xyz','s206.q4cdn.com'},'AMZN':{'ir.aboutamazon.com','s2.q4cdn.com'},'META':{'investor.atmeta.com','s21.q4cdn.com'},'NVDA':{'nvidianews.nvidia.com','investor.nvidia.com'},'DELL':{'investors.delltechnologies.com'},'AMD':{'ir.amd.com'}}

def discovered_candidates(entity):
 # Index requests run once in the discovery job, never once per chart/adapter.
 from industry_releases import candidates
 return candidates(entity)

def valid_candidate(item,entity):
 try:
  if isinstance(item.get('fiscalYear'),bool) or isinstance(item.get('quarter'),bool):return False
  fiscal_year=int(item['fiscalYear']);quarter=int(item['quarter']);parsed=urlparse(item['url'])
  if item.get('entity')!=entity or not 2000<=fiscal_year<=2100 or quarter not in (1,2,3,4):return False
  if parsed.scheme!='https' or parsed.hostname not in OFFICIAL_HOSTS.get(entity,set()) or parsed.username or parsed.password or parsed.port not in (None,443):return False
  for host,prefix in {'s206.q4cdn.com':'/479360582/','s2.q4cdn.com':'/299287126/','s21.q4cdn.com':'/399680738/'}.items():
   if parsed.hostname==host and not parsed.path.startswith(prefix):return False
  published=item.get('publishedAt')
  if not published or datetime.fromisoformat(published.replace('Z','+00:00')).date()>datetime.now(timezone.utc).date():return False
  return True
 except (KeyError,TypeError,ValueError,AttributeError):return False

def dynamic_sources(entity,bootstrap):
 # A confirmed release wins over its historical URL template; later fiscal years
 # need no code edit. Nothing is fetched at an invented future URL.
 items={(row['year'],row['q']):dict(row) for row in bootstrap}
 for item in discovered_candidates(entity):
  if valid_candidate(item,entity):
   items[(int(item['fiscalYear']),int(item['quarter']))]={**item,'entity':entity,'year':int(item['fiscalYear']),'q':int(item['quarter'])}
 return [items[key] for key in sorted(items)]

def validate_fiscal_end(entity,year,q,end):
 actual=date.fromisoformat(end)
 if actual>datetime.now(timezone.utc).date():raise ValueError('财报期末尚未发生')
 if entity in ('NVDA','DELL'):
  month={1:4,2:7,3:10,4:1}[q];calendar_year=year-1 if q<4 else year
  expected=date(calendar_year,month,calendar.monthrange(calendar_year,month)[1])
 else:
  month=q*3;expected=date(year,month,calendar.monthrange(year,month)[1])
 if abs((actual-expected).days)>14:raise ValueError('实际财季期末与公告财年/季度不一致')

def ingested_release(record):
 return {'entity':record['entity'],'url':record['url'],'fiscalYear':record['year'],'quarter':record['q'],'publishedAt':record.get('publishedAt'),'periodEnd':record['end'],'parsedAt':record.get('parsedAt') or record.get('fetchedAt'),'version':record.get('version')}

def merge_ingested(previous,records):
 latest={r['entity']:r for r in previous}
 for r in records:
  if not r.get('values') or not r.get('end'):continue
  candidate=ingested_release(r);current=latest.get(r['entity'])
  if not current or (candidate['fiscalYear'],candidate['quarter'],candidate.get('publishedAt') or '')>=(current['fiscalYear'],current['quarter'],current.get('publishedAt') or ''):latest[r['entity']]=candidate
 return sorted(latest.values(),key=lambda r:r['entity'])

def source_publication(item,raw,end):
 """Backfill old metadata only from an explicit date or issuer dateline.

 A quarter-end mentioned in financial prose is not a release date. The
 discovery validator and this narrower dateline check must agree.
 """
 try:
  verified=validate_release({'entity':item['entity'],'fiscalYear':item['year'],'quarter':item['q'],'url':item['url'],'title':item.get('title') or '','kind':'release','publishedAt':None},raw).get('publishedAt')
  if not verified:return None
  if raw.startswith(b'%PDF'):
   text=' '.join('\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(raw)).pages[:2]).split());explicit=None
  else:
   soup=BeautifulSoup(raw,'html.parser');explicit=publication_date(soup);text=' '.join(soup.get_text(' ',strip=True).split())
  if not explicit:
   dateline=re.search(r'\b(?:REDMOND|MOUNTAIN VIEW|SEATTLE|MENLO PARK|SANTA CLARA|ROUND ROCK)\b',text,re.I)
   window=text[dateline.start():dateline.start()+260] if dateline else '';date_match=re.search(DATE_WORD,window,re.I)
   prefix=window[:date_match.start()] if date_match else ''
   explicit=parse_date(date_match.group(0)) if date_match and len(prefix)<=120 and not re.search(r'quarter|ended|ending|forecast|guidance|revenue',prefix,re.I) else None
  if not explicit or explicit[:10]!=verified[:10] or verified[:10]<end:return None
  return verified
 except Exception:return None

def cached_publication(item,record):
 version=record.get('version','')
 if not re.fullmatch(r'[a-f0-9]{64}',version):return None
 for suffix in ('.html','.pdf'):
  path=DATA/'raw'/(version+suffix)
  if path.exists():
   try:raw=path.read_bytes()
   except OSError:continue
   if hashlib.sha256(raw).hexdigest()==version:return source_publication(item,raw,record['end'])
 return None

def release_pdf(raw,entity,url,force=None):
 if raw.startswith(b'%PDF'):return raw,url,None,None
 # Follow an explicit release PDF attachment only, using the company's exact
 # CDN host and path namespace. A generic annual report is never substituted.
 soup=BeautifulSoup(raw,'html.parser');attachments=[]
 for a in soup.find_all('a',href=True):
  target=urljoin(url,a['href']);parsed=urlparse(target);label=' '.join(a.get_text(' ',strip=True).split())
  if parsed.scheme!='https' or parsed.hostname not in OFFICIAL_HOSTS.get(entity,set()) or not parsed.path.lower().endswith('.pdf'):continue
  if not re.search(r'earnings|financial.results|press.release|results.release',label+' '+parsed.path,re.I):continue
  if entity=='GOOG' and parsed.hostname=='s206.q4cdn.com' and not parsed.path.startswith('/479360582/'):continue
  if entity=='AMZN' and parsed.hostname=='s2.q4cdn.com' and not parsed.path.startswith('/299287126/'):continue
  if entity=='META' and parsed.hostname=='s21.q4cdn.com' and not parsed.path.startswith('/399680738/'):continue
  attachments.append(target)
 attachments=list(dict.fromkeys(attachments))
 if len(attachments)!=1:raise ValueError('正式季度财报 PDF 附件未能唯一确认')
 payload,stamp,version=fetch(attachments[0],force=FORCE if force is None else force);return payload,attachments[0],stamp,version
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
 text=' '.join(soup.get_text(' ',strip=True).split())
 if not re.search(r'FY\s*'+str(year)[-2:]+r'\s+Q'+str(q)+r'\b',text[:2200],re.I):raise ValueError('Microsoft财年/季度标题不一致')
 expected=quarter_dates('MSFT',year,q)[1]
 match=re.search(r'quarter ended ([A-Z][a-z]+ \d{1,2},? 20\d\d)',text,re.I)
 if not match or datetime.strptime(match.group(1).replace(',',''),'%B %d %Y').date().isoformat()!=expected:raise ValueError('Microsoft实际财季期末不一致')
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
 intro=' '.join(text[:2400].split());word={1:'first',2:'second',3:'third',4:'fourth'}[q]
 company_name={'GOOG':r'Alphabet','AMZN':r'Amazon(?:\.com)?','META':r'Meta (?:Reports|Platforms)'}[entity]
 if not re.search(company_name,intro,re.I):raise ValueError('季度财报公司主体不一致')
 match=re.search(r'quarter ended ([A-Z][a-z]+ \d{1,2},? 20\d\d)',intro,re.I)
 if not re.search(word+r'\s+quarter',intro,re.I) or not match or datetime.strptime(match.group(1).replace(',',''),'%B %d %Y').date().isoformat()!=quarter_dates(entity,year,q)[1]:raise ValueError('季度财报标题或实际期末不一致')
 if not re.search(r'in\s+millions',text,re.I):raise ValueError('季度财报原始金额单位未确认')
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
 header=' '.join(table[1]) if len(table)>1 else ''
 if not re.search(r'\$\s*in\s+millions',header,re.I) or not re.search(r'Q'+str(q)+r'\s+FY\s*'+str(year)[-2:]+r'\b',header,re.I):raise ValueError('NVIDIA GAAP单位或财季标题不一致')
 titles=' '.join(x.get_text(' ',strip=True) for x in soup.find_all(['h1','title']))
 word={1:'first',2:'second',3:'third',4:'fourth'}[q]
 if not re.search(word+r'\s+quarter\s+(?:and\s+)?fiscal\s+'+str(year),titles,re.I):raise ValueError('NVIDIA公告财年/季度不一致')
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
 validate_fiscal_end('NVDA',year,q,end)
 return result,end
def sources():
 items=[]
 # This bootstrap ends at the last reviewed 2026 releases. All subsequent
 # quarters must come from actual official index links.
 for fy in range(2024,2027):
  for q in range(1,5):
   start,end=quarter_dates('MSFT',fy,q)
   items.append({'entity':'MSFT','year':fy,'q':q,'url':f'https://www.microsoft.com/en-us/investor/earnings/fy-{fy}-q{q}/press-release-webcast'})
 for y in (2025,2026):
  for q in range(1,5):
   if y==2026 and q>2:continue
   items.append({'entity':'GOOG','year':y,'q':q,'url':f'https://s206.q4cdn.com/479360582/files/doc_financials/{y}/q{q}/{y}q{q}-alphabet-earnings-release.pdf'})
   items.append({'entity':'AMZN','year':y,'q':q,'url':f'https://s2.q4cdn.com/299287126/files/doc_earnings/{y}/q{q}/earnings-result/AMZN-Q{q}-{y}-Earnings-Release.pdf'})
   word={1:'First',2:'Second',3:'Third',4:'Fourth'}[q]
   items.append({'entity':'META','year':y,'q':q,'url':f'https://s21.q4cdn.com/399680738/files/doc_news/Meta-Reports-{word}-Quarter-{y}-Results-{y}.pdf'})
 for fy,q in [(2026,1),(2026,2),(2026,3),(2026,4),(2027,1),(2027,2)]:
  word={1:'first',2:'second',3:'third',4:'fourth'}[q];suffix=f'{word}-quarter-'+('and-' if q==4 else '')+f'fiscal-{fy}';items.append({'entity':'NVDA','year':fy,'q':q,'url':f'https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-{suffix}'})
 return [item for entity in ('MSFT','GOOG','AMZN','META','NVDA') for item in dynamic_sources(entity,[r for r in items if r['entity']==entity])]
def load_one(item):
 entity,year,q,url=[item[k] for k in ('entity','year','q','url')];key=hashlib.sha256(url.encode()).hexdigest();cache=DATA/'parsed';cache.mkdir(exist_ok=True);path=cache/(key+'.json')
 force=item.get('_force',FORCE)
 old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
 # Recheck latest and comparative releases daily; older history weekly for revisions.
 age=1 if year>=date.today().year else 7
 if not force and old and datetime.now(timezone.utc)-datetime.fromisoformat(old['checkedAt'])<timedelta(days=age) and old.get('parserVersion')=='3':
  record={**old,**item}
  if not record.get('publishedAt'):
   publication=cached_publication(item,record)
   if publication:record['publishedAt']=publication;atomic(path,record)
  return record
 try:
  raw,stamp,version=fetch(url,force=force);start,end=quarter_dates(entity,year,q)
  if entity=='MSFT':values=extract_microsoft(raw,year,q)
  elif entity=='NVDA':values,end=extract_nvidia(raw,year,q);start=None
  else:
   raw,document_url,document_stamp,document_version=release_pdf(raw,entity,url,force=force)
   if document_stamp:stamp,version=document_stamp,document_version
   values=extract_pdf(raw,entity,year,q)
  if not values.get('revenue'):raise ValueError('季度收入解析校验失败')
  published=item.get('publishedAt') or source_publication(item,raw,end)
  result={**item,'publishedAt':published,'parserVersion':'3','values':values,'start':start,'end':end,'fetchedAt':stamp,'checkedAt':now(),'parsedAt':now(),'version':version,'status':'ready','documentUrl':document_url if entity not in ('MSFT','NVDA') else url};atomic(path,result);return result
 except Exception as e:
  if old:result={**old,**item,'checkedAt':now(),'status':'cached','error':str(e)}
  else:result={**item,'values':{},'checkedAt':now(),'status':'fetch_failed','error':str(e)}
  atomic(path,result);return result
def run(entities=None):
 selected=set(entities or ('MSFT','GOOG','AMZN','META','NVDA'))
 path=DATA/'companies.json';old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'series':{}};result={'schemaVersion':'1','generatedAt':now(),'definitions':[],'series':{},'projects':[],'events':[]};records=[]
 items=[item for item in sources() if item['entity'] in selected];latest_fiscal={entity:max(((r['year'],r['q']) for r in items if r['entity']==entity),default=None) for entity in selected}
 items=[dict(item,_force=FORCE and (item['year'],item['q'])==latest_fiscal[item['entity']]) for item in items]
 with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
  for record in pool.map(load_one,items):records.append(record);print(record['entity'],record['year'],record['q'],record['status'],flush=True)
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
    p=observation(id,end,v/scale,record.get('documentUrl') or record['url'],record['fetchedAt'],record['version'],start,f'FY{year-i} Q{q}',formula='原始百万美元 / 100 = 亿美元'+('；现金流出取正值展示' if family in ('capex','finance_lease_payments') else '') if scale==100 else '公司直接披露百分比',items={NAMES[family][1]:rawv,'original_unit':'USD million' if scale==100 else '%','column':'current quarter' if i==0 else 'prior-year comparable quarter'},published=record.get('publishedAt'));p['originalValue']=rawv;p['originalUnit']='USD million' if scale==100 else '%';p['originalCurrency']='USD';samples.setdefault(id,{})[end]=p
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
  entity_records=[r for r in records if r['entity']==entity];latest_fiscal=max(((r['year'],r['q']) for r in entity_records),default=None)
  failed=any(r['status']!='ready' and (r['url']==latest['sourceUrl'] or r.get('documentUrl')==latest['sourceUrl'] or (r['entity']==entity and (r['year'],r['q'])==latest_fiscal)) for r in records)
  result['series'][id]={'observations':observations,'status':'cached' if failed else 'ready','fetchedAt':latest['fetchedAt'],'checkedAt':now(),'error':'最新观测来源刷新失败，保留成功版本' if failed else None}
 # Derived values use exactly matching actual quarter dates and preserve both raw operands.
 for entity in ['MSFT','GOOG','AMZN','META','ORCL']:
  if entity not in selected:continue
  for family,a,b,ratio in [('capex_ratio','capex','revenue',True),('free_cash_flow','operating_cash_flow','capex',False),('cloud_margin','cloud_profit','cloud_revenue',True)]:
   left=result['series'].get(entity+'.'+a,{}).get('observations',[]);right={p['periodEnd']:p for p in result['series'].get(entity+'.'+b,{}).get('observations',[])};pts=[]
   for p in left:
    other=right.get(p['periodEnd'])
    if not other or other['periodStart']!=p['periodStart'] or (ratio and other['value']<=0):continue
    value=p['value']/other['value']*100 if ratio else p['value']-other['value'];id=entity+'.'+family;formula=f'{a} / {b} * 100' if ratio else f'{a} - {b}'
    pts.append(dict(observation(id,p['periodEnd'],value,p['sourceUrl'],max(p['fetchedAt'],other['fetchedAt']),hashlib.sha256((p['version']+other['version']+family).encode()).hexdigest(),p['periodStart'],p['fiscalPeriod'],formula,{a:p['value'],b:other['value'],'input_unit':'亿美元','right_source':other['sourceUrl']},published=p.get('publishedAt')),originalUnit='%' if ratio else '亿美元'))
   if pts:
    cached=any(result['series'].get(entity+'.'+operand,{}).get('status')=='cached' for operand in (a,b))
    d=definition(id,*NAMES[family],'cloud' if family=='cloud_margin' else 'capex',family,entity,entity+' Investor Relations',IR[entity],'%' if ratio else '亿美元','calculated',formula+'；所有输入必须为相同实际报告区间。自由现金流口径不扣融资租赁本金，可能不同于公司非GAAP定义。');result['definitions'].append(d);result['series'][id]={'observations':pts,'status':'cached' if cached else 'ready','fetchedAt':pts[-1]['fetchedAt'],'checkedAt':now(),'error':'计算输入展示最后成功缓存' if cached else None}
 # Preserve last successful values even when every current fetch fails.
 for d in old.get('definitions',[]):
  if d['id'] not in result['series']:
   result['definitions'].append(d);result['series'][d['id']]=old['series'][d['id']] if d.get('entity') not in selected else {**old['series'][d['id']],'status':'cached','checkedAt':now(),'error':'未能刷新该指标，保留最后成功观测。'}
 result['sourceRuns']=[r for r in old.get('sourceRuns',[]) if r.get('entity') not in selected]+[{k:r.get(k) for k in ('entity','year','q','url','status','checkedAt','error','publishedAt')} for r in records]
 result['ingestedReleases']=merge_ingested(old.get('ingestedReleases',[]),records)
 persist(result,path);print('industry company metrics:',len(result['series']),flush=True)
if __name__=='__main__':
 cli=argparse.ArgumentParser();cli.add_argument('--force',action='store_true');cli.add_argument('--entity',action='append',choices=('MSFT','GOOG','AMZN','META','NVDA'));args=cli.parse_args();run(args.entity)
