"""Issuer business history and xScale operating capacity, with explicit scope.

An operator's portfolio is direct evidence of that portfolio, never a global AI
capacity estimate. Development includes planned phases and cannot become a
construction statistic. ASE milestones use its own official press-room pages.
"""
import argparse,calendar,hashlib,io,json,re
from datetime import date,datetime
from urllib.parse import urljoin,urlparse,unquote
from concurrent.futures import ThreadPoolExecutor
import requests
from bs4 import BeautifulSoup
from pypdf import PdfReader
from industry_common import DATA,atomic,definition,observation,persist,now
from industry_releases import candidates
from industry_bootstrap import restore_bootstrap

VERSION='supply-evidence-1.0.0'
EQIX_INDEX='https://investor.equinix.com/financial-information/financial-results'
ANET_BASE='https://investors.arista.com/Communications/Press-Releases-and-Events/Press-Release-Detail/'
ASE_EVENTS=['https://www.aseglobal.com/press-room/k18b-groundbreaking-ceremony','https://www.aseglobal.com/press-room/310x310']
ANET_RELEASES=[ANET_BASE+x for x in (
 '2024/Arista-Networks-Inc.-Reports-Third-Quarter-2024-Financial-Results/default.aspx',
 '2025/Arista-Networks-Inc.-Reports-Fourth-Quarter-and-Year-End-2024-Financial-Results/default.aspx',
 '2025/Arista-Networks-Inc--Reports-First-Quarter-2025-Financial-Results/default.aspx',
 '2025/Arista-Networks-Inc--Reports-Second-Quarter-2025-Financial-Results/default.aspx',
 '2025/Arista-Networks-Inc--Reports-Third-Quarter-2025-Financial-Results/default.aspx',
 '2026/Arista-Networks-Inc--Reports-Fourth-Quarter-and-Year-End-2025-Financial-Results/default.aspx',
 '2026/Arista-Networks-Inc--Reports-First-Quarter-2026-Financial-Results/default.aspx',
 '2026/Arista-Networks-Inc--Reports-Second-Quarter-2026-Financial-Results/default.aspx')]

def allowed(url):
 p=urlparse(url)
 try:return p.scheme=='https' and not p.username and not p.password and p.port in (None,443) and (p.hostname in {'investor.equinix.com','investors.arista.com'} or p.hostname=='www.aseglobal.com' and p.path.startswith('/press-room/') or p.hostname=='d1io3yog0oux5.cloudfront.net' and '/equinix/' in p.path or p.hostname=='s21.q4cdn.com' and p.path.startswith('/861911615/files/doc_news/'))
 except ValueError:return False

def fetch_source(url,force=False):
 if not allowed(url):raise ValueError('来源不在官方域名/附件命名空间')
 folder=DATA/'raw';folder.mkdir(exist_ok=True);meta=folder/(hashlib.sha256(url.encode()).hexdigest()+'.meta.json')
 old=json.loads(meta.read_text(encoding='utf-8')) if meta.exists() else {}
 if old and not force and (datetime.fromisoformat(now())-datetime.fromisoformat(old['fetchedAt'])).total_seconds()<86400:return (folder/old['file']).read_bytes(),old['fetchedAt'],old['hash']
 with requests.Session() as s:
  s.trust_env=False;r=s.get(url,timeout=25);r.raise_for_status()
  if not allowed(r.url):raise ValueError('来源重定向到未允许域名')
  raw=r.content
 if len(raw)<100:raise ValueError('空响应')
 version=hashlib.sha256(raw).hexdigest();name=version+('.pdf' if raw.startswith(b'%PDF') else '.html');stamp=now();(folder/name).write_bytes(raw);atomic(meta,{'url':url,'file':name,'hash':version,'fetchedAt':stamp});return raw,stamp,version

def parse_anet(raw):
 if raw.startswith(b'%PDF'):
  text=' '.join('\n'.join(p.extract_text() or '' for p in PdfReader(io.BytesIO(raw)).pages).split());title=text[:700]
 else:
  soup=BeautifulSoup(raw,'html.parser');text=soup.get_text(' ',strip=True)
  title=' '.join(h.get_text(' ',strip=True) for h in soup.find_all(['h1','title']))
 m=re.search(r'Reports (First|Second|Third|Fourth) Quarter(?: and Year End)? (20\d\d) Financial Results',title,re.I)
 if not m or 'Arista Networks' not in title:raise ValueError('Arista发布主体或季度标题不匹配')
 q=['first','second','third','fourth'].index(m[1].lower())+1;y=int(m[2]);end=date(y,q*3,calendar.monthrange(y,q*3)[1]).isoformat()
 iso=re.search(r'Financial Results\s+(20\d\d-\d\d-\d\d)\b',text[:700])
 pub=re.search(r'SANTA CLARA,?\s*(?:Calif|CA)[^A-Za-z]{0,10}([A-Z][a-z]+\s+\d{1,2},\s+20\d\d)',text)
 if not iso and not pub:raise ValueError('Arista实际发布日未核验')
 published=iso[1] if iso else datetime.strptime(pub[1],'%B %d, %Y').date().isoformat()
 if published<end or published>date.today().isoformat():raise ValueError('Arista发布日无效')
 revenue=re.search(r'Revenue of \$([\d.]+) (billion|million)',text,re.I)
 margin=re.search(r'(?<!Non-)GAAP gross margin(?: of)?\s+([\d.]+)%',text)
 if not revenue or not margin:raise ValueError('Arista实际季度收入与GAAP毛利率缺失')
 return {'end':end,'publishedAt':published,'quarter':q,'year':y,'revenue':float(revenue[1])*(10 if revenue[2].lower()=='billion' else .01),'gross_margin':float(margin[1])}

def parse_ase_event(raw,url):
 soup=BeautifulSoup(raw,'html.parser');h=next((h for h in soup.find_all('h1') if h.get_text(' ',strip=True).startswith('ASE ')),None);title=h.get_text(' ',strip=True) if h else '';text=soup.get_text(' ',strip=True)
 tail=text[text.rfind(title)+len(title):] if title else '';m=re.match(r'\s*([A-Z][a-z]+ \d{1,2}, 20\d\d)',tail)
 if not m or 'ASE ' not in title:raise ValueError('ASE官方文章标题/发布日未核验')
 published=datetime.strptime(m[1],'%B %d, %Y').date().isoformat()
 if published>date.today().isoformat():raise ValueError('未来公告不能当成已发布事件')
 if url.endswith('/k18b-groundbreaking-ceremony') and 'K18B Groundbreaking' in title and 'held a groundbreaking ceremony today' in tail:
  return {'id':'ASX-K18B-groundbreaking','entity':'ASX','title':'日月光 K18B 先进封装厂开工','date':published,'kind':'project','isConfirmed':True,'observationNature':'actual','description':'官方确认K18B厂举行开工仪式；预计2028年第一季度完成，属于计划。未披露连续季度实际产能、先进封装单项收入或订单，不能替代正式因子。'}
 if url.endswith('/310x310') and 'Automated 310mm Panel-Level Packaging' in title and 'expected to enter production in the first half of 2027' in tail:
  return {'id':'ASX-310mm-plp-plan','entity':'ASX','title':'日月光 310mm 面板级封装产线计划','date':published,'kind':'supply','isConfirmed':True,'observationNature':'forecast','description':'官方披露自动化310mm×310mm面板级封装产线开发；预计2027年上半年投产，尚非已投产证据。310mm是面板尺寸，不能转成产能或需求增量。'}
 raise ValueError('ASE事件实际/计划口径未通过校验')

def eqix_candidates(raw):
 soup=BeautifulSoup(raw,'html.parser');jobs=[]
 for a in soup.find_all('a',href=True):
  if a.get_text(' ',strip=True)!='Earnings Presentation':continue
  url=urljoin(EQIX_INDEX,a['href']);identity=re.search(r'Q([1-4])[+ _-]+(\d{2})[+ _-]+Earnings',unquote(url),re.I)
  if not identity or not allowed(url):continue
  q,y=int(identity[1]),2000+int(identity[2]);end=date(y,q*3,calendar.monthrange(y,q*3)[1]).isoformat()
  if end<'2024-06-30' or end>date.today().isoformat():continue
  block=next((p for p in a.parents if 'Quarter Ended' in p.get_text(' ',strip=True)),None)
  release=next((b for b in block.find_all('a',href=True) if b.get_text(' ',strip=True)=='Earnings Release'),None) if block else None
  if not release or not allowed(release['href']):continue
  jobs.append({'url':url,'releaseUrl':release['href'],'end':end,'year':y,'quarter':q})
 return list({j['end']:j for j in jobs}.values())

def parse_eqix_capacity(raw,expected=None):
 pages=[p.extract_text() or '' for p in PdfReader(io.BytesIO(raw)).pages]
 if expected:
  front=' '.join(pages[:2])
  if not re.search(r'Q\s*'+str(expected['quarter'])+r'\s*(?:20)?'+str(expected['year'])[-2:],front,re.I):raise ValueError('Equinix PDF内季度与官方链接不一致')
 normalized=[re.sub(r'\s+',' ',t).replace('Previously Opened Data Centers','Previously Opened Capacity').replace('Operational Data Centers','Previously Opened Capacity') for t in pages]
 matches=[(i,t) for i,t in enumerate(normalized,1) if 'Previously Opened Capacity' in t and 'Capacity Under Development' in t and 'xScale' in t]
 if len(matches)!=1:raise ValueError('xScale投运/开发表格无法唯一核验')
 page,text=matches[0]
 if not re.search(r'Capacity\s*\(MW\)',text):raise ValueError('容量MW表头未核验')
 def row(label):
  m=re.search(re.escape(label)+r'(?:\s*\(\d+\))*(?:\s*JV\s+(?:Open\s*){1,2})?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*\$?\s+(\d[\d,]*(?:\.\d+)?)\s+(\d[\d,]*(?:\.\d+)?)',text)
  if not m:raise ValueError(label+'金额/容量/租赁三列未核验')
  return [float(v.replace(',','')) for v in m.groups()]
 opened=row('Previously Opened Capacity');development=row('Capacity Under Development');total=row('Total Portfolio')
 if abs(opened[1]+development[1]-total[1])>2 or opened[2]>opened[1]+1 or development[2]>development[1]+1:raise ValueError('容量交叉合计/租赁校验失败')
 return {'operational_capacity':opened[1],'development_capacity':development[1],'page':page,'opened_cost_million':opened[0],'opened_leasing_mw':opened[2],'development_leasing_mw':development[2]}

def run(force=False):
 path=DATA/'supply-evidence.json';old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {};definitions={d['id']:d for d in old.get('definitions',[])};points={};errors={};runs=[]
 events={e['id']:e for e in old.get('events',[])}
 def configured(entity,family,name,unit,url,eligible=True):
  key=f'{entity}.{family}';d=definition(key,name,name,'projects' if entity=='EQIX' else 'servers',family,entity,entity+' Investor Relations',url,unit,'reported',eligible=eligible)
  d.update({'sourceAdapter':'supply-evidence','reportingScope':'operator_portfolio' if entity=='EQIX' else 'company_total','researchTargets':['data_centers','power','overall'] if entity=='EQIX' else ['servers'],'directness':'portfolio_disclosure' if entity=='EQIX' else 'company_disclosure','methodology':'Equinix xScale全球自有及合资项目组合的已开放容量；非全球AI全量、非使用率、非并网功率。开发容量另列，包含未来阶段，不能称为在建容量。' if entity=='EQIX' else '公司正式披露季度总收入和GAAP毛利率；覆盖AI/云/企业网络，不等于纯AI网络收入。'})
  definitions[key]=d;return d
 for entity,family,name,unit,url,eligible in [('EQIX','operational_capacity','Equinix xScale已开放容量（公司组合）','MW',EQIX_INDEX,True),('EQIX','development_capacity','Equinix xScale开发阶段容量（含规划）','MW',EQIX_INDEX,False),('ANET','company_revenue','网络设备公司总收入（非AI单项）','亿美元',ANET_BASE,True),('ANET','gross_margin','网络设备公司GAAP毛利率','%',ANET_BASE,True)]:configured(entity,family,name,unit,url,eligible)
 def add(entity,family,name,unit,url,stamp,version,job,value,items,eligible=True):
  d=configured(entity,family,name,unit,url,eligible);key=d['id'];end=job['end'];p=observation(key,end,value,url,stamp,version,f'{end[:4]}-{(int(end[5:7])-2):02}-01',f"FY{job['year']} Q{job['quarter']}",items=items,published=job['publishedAt']);p.update({'originalValue':value,'originalUnit':unit,'reportingScope':d['reportingScope']});points.setdefault(key,{})[end]=p
 def arista(url):
  try:
   original_url=url
   parts=url.split('/');stem=parts[-2];published_year=parts[-3]
   pdf='https://s21.q4cdn.com/861911615/files/doc_news/'+stem+'-'+published_year+'.pdf'
   cached_pdf=DATA/'raw'/(hashlib.sha256(pdf.encode()).hexdigest()+'.meta.json')
   if url.startswith(ANET_BASE) and cached_pdf.exists():url=pdf
   try:raw,stamp,version=fetch_source(url,force);job=parse_anet(raw)
   except Exception:
    raw,stamp,version=fetch_source(pdf,force);job=parse_anet(raw);url=pdf
   for family,name,unit in [('company_revenue','网络设备公司总收入（非AI单项）','亿美元'),('gross_margin','网络设备公司GAAP毛利率','%')]:add('ANET',family,name,unit,url,stamp,version,job,job['revenue' if family=='company_revenue' else family],{'parserVersion':VERSION,'scope':'company_networking_not_ai_only'})
   runs.append({'entity':'ANET','url':original_url,'documentUrl':url,'periodEnd':job['end'],'fiscalYear':job['year'],'quarter':job['quarter'],'publishedAt':job['publishedAt'],'parsedAt':now(),'metricIds':['ANET.company_revenue','ANET.gross_margin'],'status':'ready','checkedAt':now()})
  except Exception as e:errors['ANET']=str(e);runs.append({'entity':'ANET','url':url,'status':'fetch_failed','error':str(e),'checkedAt':now()})
 def equinix(job):
  try:
   release,_,_=fetch_source(job['releaseUrl'],force);soup=BeautifulSoup(release,'html.parser');time=soup.find('time');pub=time.get('datetime') if time else None
   if not pub:
    m=re.search(r'([A-Z][a-z]+ \d{1,2}, 20\d\d)',soup.get_text(' ',strip=True));pub=datetime.strptime(m[1],'%B %d, %Y').date().isoformat() if m else None
   if not pub or pub[:10]<job['end'] or pub[:10]>date.today().isoformat():raise ValueError('Equinix来源发布日未核验')
   job={**job,'publishedAt':pub};raw,stamp,version=fetch_source(job['url'],force);row=parse_eqix_capacity(raw,job)
   for family,name in [('operational_capacity','Equinix xScale已开放容量（公司组合）'),('development_capacity','Equinix xScale开发阶段容量（含规划）')]:add('EQIX',family,name,'MW',job['url'],stamp,version,job,row[family],{**row,'parserVersion':VERSION,'indexUrl':EQIX_INDEX,'releaseUrl':job['releaseUrl'],'capacityKind':'xscale_phase_capacity_mw'},eligible=family=='operational_capacity')
   runs.append({'entity':'EQIX','url':job['url'],'periodEnd':job['end'],'status':'ready','checkedAt':now()})
  except Exception as e:errors['EQIX']=str(e);runs.append({'entity':'EQIX','url':job['url'],'periodEnd':job['end'],'status':'fetch_failed','error':str(e),'checkedAt':now()})
 try:
  raw,_,_=fetch_source(EQIX_INDEX,force);jobs=eqix_candidates(raw)
  if not jobs:raise ValueError('官方季度索引未提供可核验的附件链接')
 except Exception as e:jobs=[];errors['EQIX']=str(e)
 urls=list(dict.fromkeys(ANET_RELEASES+[r['url'] for r in candidates('ANET') if allowed(r['url'])]))
 with ThreadPoolExecutor(max_workers=3) as pool:list(pool.map(arista,urls));list(pool.map(equinix,jobs))
 for url in ASE_EVENTS:
  try:
   raw,stamp,version=fetch_source(url,force);event={**parse_ase_event(raw,url),'sourceUrl':url,'fetchedAt':stamp,'version':version,'status':'ready'};events[event['id']]=event;runs.append({'entity':'ASX','url':url,'status':'ready','checkedAt':now()})
  except Exception as e:
   errors['ASX']=str(e);runs.append({'entity':'ASX','url':url,'status':'fetch_failed','error':str(e),'checkedAt':now()})
   for event in events.values():
    if event['sourceUrl']==url:event.update(status='cached',error=str(e))
 result={'schemaVersion':'1','generatedAt':now(),'definitions':list(definitions.values()),'series':{},'projects':[],'events':list(events.values()),'sources':[{'id':'supply-'+r['entity']+'-'+hashlib.sha256(r['url'].encode()).hexdigest()[:12],'name':r['entity']+' 官方来源','url':r['url'],'status':r['status'],'checkedAt':r['checkedAt'],'error':r.get('error')} for r in runs],'sourceRuns':sorted(runs,key=lambda r:(r['entity'],r.get('periodEnd',''),r['url']))}
 for key,d in definitions.items():
  prior={p['periodEnd']:p for p in old.get('series',{}).get(key,{}).get('observations',[])};prior.update(points.get(key,{}));obs=sorted(prior.values(),key=lambda p:p['periodEnd']);error=errors.get(d['entity']);result['series'][key]={'observations':obs,'status':'cached' if error and obs else 'fetch_failed' if error else 'ready' if obs else 'no_observation','checkedAt':now(),'fetchedAt':max((p['fetchedAt'] for p in obs),default=None),'error':error}
 if DATA.resolve()==(__import__('pathlib').Path(__file__).resolve().parents[1]/'data'/'industry').resolve():result=restore_bootstrap('supply-evidence.json',result,backfill_history=True)
 result['ingestedReleases']=[r for r in runs if r['entity']=='ANET' and r['status']=='ready']
 persist(result,path);print(json.dumps({'series':{k:len(v['observations']) for k,v in result['series'].items()},'errors':errors}))

if __name__=='__main__':run('--force' in __import__('sys').argv)
