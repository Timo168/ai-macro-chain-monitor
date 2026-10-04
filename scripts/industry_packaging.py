"""Amkor operating sample, from actual issuer-discovered quarterly releases.

Advanced products include memory/mobile/test services, not pure AI or CoWoS.
Company profitability and material cost share remain company-wide observations.
Cash PPE is a quarterly flow: Q2--Q4 require adjacent same-year YTD reports.
"""
import calendar,hashlib,json,re
from concurrent.futures import ThreadPoolExecutor
from datetime import date,datetime,timedelta
from urllib.parse import urljoin,urlparse
import requests
from industry_common import DATA,atomic,definition,now,observation,persist
from industry_collect import html_tables,numbers
from industry_releases import parse_date
from industry_bootstrap import restore_bootstrap

INDEX='https://ir.amkor.com/taxonomy/term/3896'
VERSION='packaging-operating-1.0.1'
METRICS={
 'advanced_products_revenue':('先进产品封装与测试收入（含非AI）','亿美元','advanced_products'),
 'company_revenue':('封装与测试公司总收入','亿美元','company_total'),
 'gross_margin':('封装与测试公司GAAP毛利率','%','company_total'),
 'materials_cost_share':('材料成本占公司销售比例','%','company_total'),
 'capex':('公司现金购置固定资产','亿美元','company_total')}

def allowed(url):
 p=urlparse(url)
 try:return p.scheme=='https' and p.hostname=='ir.amkor.com' and not p.username and not p.password and p.port in (None,443) and (p.path.startswith('/news-releases/') or p.path=='/taxonomy/term/3896')
 except ValueError:return False

def fetch_source(url,force=False):
 if not allowed(url):raise ValueError('非Amkor官方披露链接')
 folder=DATA/'raw';folder.mkdir(exist_ok=True);meta=folder/(hashlib.sha256(url.encode()).hexdigest()+'.meta.json')
 prior=json.loads(meta.read_text(encoding='utf-8')) if meta.exists() else {}
 if prior and not force and datetime.fromisoformat(now())-datetime.fromisoformat(prior['fetchedAt'])<timedelta(hours=24):
  filename=prior['file']
  if not re.fullmatch(r'[a-f0-9]{64}\.html',filename):raise ValueError('缓存文件名不合法')
  raw=(folder/filename).read_bytes()
  if hashlib.sha256(raw).hexdigest()!=prior['hash']:raise ValueError('缓存原始来源校验失败')
  return raw,prior['fetchedAt'],prior['hash']
 with requests.Session() as session:
  session.trust_env=False;response=session.get(url,timeout=25);response.raise_for_status()
  if not allowed(response.url):raise ValueError('官方来源重定向到未允许的链接')
  raw=response.content
 if len(raw)<100:raise ValueError('来源响应为空')
 digest=hashlib.sha256(raw).hexdigest();filename=digest+'.html';stamp=now();(folder/filename).write_bytes(raw);atomic(meta,{'url':url,'file':filename,'hash':digest,'fetchedAt':stamp});return raw,stamp,digest

def release_candidates(raw):
 soup,_=html_tables(raw);found={}
 for link in soup.find_all('a',href=True):
  text=link.get_text(' ',strip=True)
  match=re.search(r'Amkor Technology Reports (?:Record )?Financial Results for (?:the )?(First|Second|Third|Fourth) Quarter(?: and Full Year)? (20\d\d)',text,re.I)
  if not match:continue
  year=int(match[2]);quarter=['first','second','third','fourth'].index(match[1].lower())+1
  end=date(year,quarter*3,calendar.monthrange(year,quarter*3)[1]).isoformat();url=urljoin(INDEX,link['href'])
  if year>=2024 and end<=date.today().isoformat() and allowed(url):found[(year,quarter)]={'year':year,'quarter':quarter,'url':url,'end':end}
 return [found[k] for k in sorted(found)]

def row_values(table,label):
 rows=[r for r in table if r and re.fullmatch(label,r[0],re.I)]
 if len(rows)!=1:raise ValueError('无法唯一确认行：'+label)
 # The source uses separate currency/bracket cells. Stop at the first actual
 # column, including a missing-value marker, before inspecting any prior year.
 cells=rows[0][1:];sign=1
 if not cells:raise ValueError('当期列没有数值：'+label)
 # Actual issuer tables reserve one leading currency/spacer cell. Do not
 # skip additional empty cells: those may be the missing current value.
 currency_column=any(len(row)>2 and (row[1].strip()=='$' or row[1].strip()=='' and row[2].strip().startswith('$')) for row in table)
 cursor=1 if currency_column else 0
 if cursor<len(cells) and cells[cursor].strip()=='(':sign=-1;cursor+=1
 if cursor>=len(cells) or cells[cursor].strip() in ('','—','–','-','N/A','NA'):raise ValueError('当期列缺失：'+label)
 parsed=numbers(cells[cursor])
 if len(parsed)!=1:raise ValueError('当期数值列无法唯一识别：'+label)
 return [sign*parsed[0]]

def parse_release(raw,job):
 soup,tables=html_tables(raw);text=' '.join(soup.get_text(' ',strip=True).split());title=' '.join(h.get_text(' ',strip=True) for h in soup.find_all(['title','h1','h2']))
 word=['first','second','third','fourth'][job['quarter']-1]
 if not re.search(r'Amkor Technology Reports.*'+word+r' Quarter(?: and Full Year)? '+str(job['year']),title,re.I):raise ValueError('公司主体与实际季度标题不一致')
 dateline=re.search(r'TEMPE,?\s*Ariz\..{0,90}?([A-Z][a-z]+\.?\s+\d{1,2},\s+20\d\d)',text)
 published=parse_date(dateline[1]) if dateline else None
 period=re.search(r'quarter(?: and full year)? ended ([A-Z][a-z]+ \d{1,2}, 20\d\d)',text[:4500],re.I)
 if not period or datetime.strptime(period[1],'%B %d, %Y').date().isoformat()!=job['end']:raise ValueError('实际财季期末未核验')
 if not published or published[:10]<job['end'] or published[:10]>date.today().isoformat():raise ValueError('官方实际发布日期未核验')
 candidates=[t for t in tables if any(r and re.fullmatch(r'Advanced products\s*\(1\)',r[0],re.I) for r in t)]
 if len(candidates)!=1:raise ValueError('先进产品实际经营表不能唯一确认')
 table=candidates[0];table_text=' '.join(' '.join(row) for row in table)
 headers=re.findall(r'Q([1-4])\s+(20\d\d)',table_text)
 if not headers or headers[0]!=(str(job['quarter']),str(job['year'])) or not re.search(r'Net sales \(in millions\)',table_text,re.I):raise ValueError('实际季度首列或百万美元单位不一致')
 if not re.search(r'Advanced products include flip chip, memory and wafer-level processing and related test services',text,re.I):raise ValueError('先进产品技术范围发生变化，需核验新口径')
 values={
  'advanced_products_revenue':row_values(table,r'Advanced products\s*\(1\)')[0],
  'company_revenue':row_values(table,r'Total net sales')[0],
  'gross_margin':row_values(table,r'Gross margin')[0],
  'materials_cost_share':row_values(table,r'Materials')[0]}
 mainstream=row_values(table,r'Mainstream products\s*\(2\)')[0]
 if abs(values['advanced_products_revenue']+mainstream-values['company_revenue'])>1:raise ValueError('先进与传统产品合计不匹配')
 if any(not 0<=values[k]<=100 for k in ['gross_margin','materials_cost_share']):raise ValueError('公司比例超出边界')
 cash=[t for t in tables if any(r and r[0]=='Payments for property, plant and equipment' for r in t) and 'In thousands' in ' '.join(' '.join(r) for r in t)]
 if len(cash)!=1:raise ValueError('现金购置固定资产千美元现金流表不唯一')
 cash_text=' '.join(' '.join(r) for r in cash[0]);expected=['Three','Six','Nine','Twelve'][job['quarter']-1]
 if job['quarter']==4:
  match=re.search(r'For the (?:Years|Year) Ended',cash_text,re.I)
 else:match=re.search(r'For (?:the )?'+expected+r' Months Ended',cash_text,re.I)
 header_years=re.findall(r'\b20\d\d\b',cash_text[:800])
 if not match or not header_years or int(header_years[0])!=job['year']:raise ValueError('现金流表累计期间或当年首列未核验')
 cash_ppe=row_values(cash[0],r'Payments for property, plant and equipment')[0]
 if cash_ppe>0:raise ValueError('现金购置支出符号异常')
 values['capex_ytd']=-cash_ppe
 return {**job,'values':values,'publishedAt':published,'start':f"{job['year']}-{job['quarter']*3-2:02d}-01"}

def run(force=False):
 path=DATA/'packaging-evidence.json';prior=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {};checked=now();failures=[];records=[];sources=[];definition_list=[]
 for family,(name,unit,scope) in METRICS.items():
  d=definition('AMKR.'+family,name,name,'semiconductor',family,'AMKR','Amkor Investor Relations',INDEX,unit,value_type='calculated' if family=='capex' else 'reported',eligible=family not in ['company_revenue','materials_cost_share'])
  d.update({'sourceAdapter':'packaging-operating','reportingScope':scope,'directness':'company_disclosure','researchTargets':['packaging_operations'],'methodology':'Amkor公司经营样本；先进产品包括flip chip、memory、wafer-level processing及相关测试，含非AI终端。毛利率、材料成本比例和现金投资均为公司整体，非先进产品单项。现金投资Q2至Q4由同年相邻已公布累计值做差。'})
  definition_list.append(d)
 try:
  raw,stamp,version=fetch_source(INDEX,force);jobs=release_candidates(raw)
  if not jobs:raise ValueError('官方索引无可核验的实际季度链接')
  sources.append({'id':'AMKR-index','name':'Amkor实际季度公告索引','url':INDEX,'status':'ready','checkedAt':checked,'fetchedAt':stamp})
 except Exception as error:
  jobs=[];failures.append(str(error));sources.append({'id':'AMKR-index','name':'Amkor实际季度公告索引','url':INDEX,'status':'fetch_failed','checkedAt':checked,'error':str(error)})
 def read(job):
  try:
   raw,stamp,version=fetch_source(job['url'],force);record={**parse_release(raw,job),'fetchedAt':stamp,'version':version};return record,None
  except Exception as error:return None,{'url':job['url'],'periodEnd':job['end'],'error':str(error)}
 with ThreadPoolExecutor(max_workers=3) as pool:
  for record,error in pool.map(read,jobs):
   if record:records.append(record)
   else:failures.append(error['error']);sources.append({'id':'AMKR-'+error['periodEnd'],'name':'Amkor实际季度公告','url':error['url'],'status':'fetch_failed','checkedAt':checked,'error':error['error']})
 by_quarter={(r['year'],r['quarter']):r for r in records};points={d['id']:{} for d in definition_list}
 for record in records:
  for family in METRICS:
   key='AMKR.'+family;formula=None;inputs={'parserVersion':VERSION,'scope':METRICS[family][2]};version=record['version']
   if family=='capex':
    base=by_quarter.get((record['year'],record['quarter']-1))
    if record['quarter']>1 and not base:continue
    value=record['values']['capex_ytd']-(base['values']['capex_ytd'] if base else 0)
    if value<0:failures.append('现金购置累计差分为负，保留缺失期');continue
    inputs.update({'currentYtdThousandUsd':record['values']['capex_ytd'],'baseYtdThousandUsd':base['values']['capex_ytd'] if base else 0,'baseUrl':base['url'] if base else None,'baseVersion':base['version'] if base else None,'basePublishedAt':base['publishedAt'] if base else None})
    formula='(current fiscal YTD cash PPE - previous fiscal YTD cash PPE) / 100000'
    version=hashlib.sha256(json.dumps([record['version'],inputs],sort_keys=True).encode()).hexdigest();unit='USD thousand';display=value/100000
   else:
    value=record['values'][family];unit='%' if METRICS[family][1]=='%' else 'USD million';display=value if unit=='%' else value/100;formula='reported percentage' if unit=='%' else 'USD million / 100'
   p=observation(key,record['end'],display,record['url'],record['fetchedAt'],version,record['start'],f"FY{record['year']} Q{record['quarter']}",formula,inputs,record['publishedAt']);p.update({'originalValue':value,'originalUnit':unit,'sourceDocumentVersion':record['version'],'reportingScope':METRICS[family][2]});points[key][record['end']]=p
  sources.append({'id':'AMKR-'+record['end'],'name':'Amkor实际季度公告','url':record['url'],'status':'ready','checkedAt':checked,'fetchedAt':record['fetchedAt']})
 result={'schemaVersion':'1','generatedAt':checked,'definitions':definition_list,'series':{},'projects':[],'events':[],'sources':sources,'ingestedReleases':[{'entity':'AMKR','url':r['url'],'fiscalYear':r['year'],'quarter':r['quarter'],'publishedAt':r['publishedAt'],'periodEnd':r['end'],'parsedAt':checked,'metricIds':['AMKR.'+f for f in METRICS]} for r in records]}
 for d in definition_list:
  key=d['id'];old={p['periodEnd']:p for p in prior.get('series',{}).get(key,{}).get('observations',[])};old.update(points[key]);observations=sorted(old.values(),key=lambda p:p['periodEnd'])
  latest_report=max((r['end'] for r in records),default=None)
  waiting=bool(latest_report and latest_report not in points[key])
  error='; '.join(failures[:3]) or ('最新已发布财季缺少有效计算基期，保留最近成功观测。' if waiting else None)
  status='cached' if (failures or waiting) and observations else 'fetch_failed' if failures else 'ready' if observations else 'no_observation'
  result['series'][key]={'observations':observations,'status':status,'checkedAt':checked,'fetchedAt':max((p['fetchedAt'] for p in observations),default=None),'error':error}
 if (DATA/'bootstrap'/'packaging-evidence.json').exists() and DATA.resolve()==(__import__('pathlib').Path(__file__).resolve().parents[1]/'data'/'industry').resolve():result=restore_bootstrap('packaging-evidence.json',result,backfill_history=True)
 persist(result,path);print(json.dumps({'observations':{k:len(v['observations']) for k,v in result['series'].items()},'errors':failures[:3]}));return result

if __name__=='__main__':run('--force' in __import__('sys').argv)
