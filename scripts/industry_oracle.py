"""Oracle official quarter tables; discovered reports extend the reviewed history."""
import argparse,hashlib,io,json,os,re,requests
from datetime import date,datetime,timedelta,timezone
from urllib.parse import urljoin,urlparse
from bs4 import BeautifulSoup
from pypdf import PdfReader
from industry_common import DATA,now,atomic,definition,observation,persist
from industry_collect import NAMES,numbers,quarter_dates

METHOD='Oracle官方财报单季附表，按Fiscal年度和Q1–Q4列提取，排除TOTAL/YTD列；实际财季不同于自然季度。百万美元÷100换算为亿美元。'
NET_METHOD=METHOD+'资本开支净现金支出另扣相关短期融资及带融资成分的客户预付款，保留公司非GAAP定义，不与GAAP资本开支混用。'
ALLOWED_HOSTS={'investor.oracle.com','www.oracle.com','oracle.com'}
SEC_CIK='0001341439'
SEC_URL='https://data.sec.gov/api/xbrl/companyfacts/CIK'+SEC_CIK+'.json'

def cash_ppe_definition():
 d=definition('ORCL.cash_ppe_capex','现金购置固定资产（SEC原始口径）','Cash payments to acquire property plant and equipment','capex','capex','ORCL','SEC EDGAR companyfacts / Oracle原始申报',SEC_URL,method='仅使用PaymentsToAcquirePropertyPlantAndEquipment。美元÷1亿；单季原值或同财政期初累计差分。与原Oracle附表资本开支及非GAAP净现金支出分别保存，不拼接、不得将同公司多口径重复计分。',eligible=False)
 d.update(sourceAdapter='oracle',directness='company_total',scope='cash_ppe_payments',dataRole='company_financial_actual',reportingScope='company_total',isComparableAcrossEntities=False)
 return d

def fetch_sec_companyfacts(force=False):
 """Direct official SEC request, including an identifiable configurable User-Agent."""
 folder=DATA/'raw';folder.mkdir(exist_ok=True);key=hashlib.sha256(SEC_URL.encode()).hexdigest();meta=folder/(key+'.meta.json')
 try:
  old=json.loads(meta.read_text(encoding='utf-8'))
  if not force and datetime.now(timezone.utc)-datetime.fromisoformat(old['fetchedAt'])<timedelta(hours=24):return (folder/old['file']).read_bytes(),old['fetchedAt'],old['hash']
 except (OSError,ValueError,KeyError):pass
 with requests.Session() as session:
  session.trust_env=False
  response=session.get(SEC_URL,headers={'User-Agent':os.environ.get('SEC_USER_AGENT') or 'AI Macro Chain Monitor (+https://github.com/Timo168/ai-macro-chain-monitor)','Accept-Encoding':'identity'},timeout=25)
  response.raise_for_status()
  if response.url!=SEC_URL:raise ValueError('Oracle SEC companyfacts unexpected redirect')
  raw=response.content
 if len(raw)<100:raise ValueError('Oracle SEC companyfacts empty response')
 version=hashlib.sha256(raw).hexdigest();filename=version+'.json';(folder/filename).write_bytes(raw);stamp=now();atomic(meta,{'url':SEC_URL,'file':filename,'hash':version,'fetchedAt':stamp})
 return raw,stamp,version

def parse_sec_core(raw,as_of=None):
 """Require actual USD facts and preserve the three distinct cash/GAAP definitions."""
 from industry_sector_financials import quarterly_flows,tagged_facts
 payload=json.loads(raw);as_of=as_of or date.today().isoformat()
 if int(payload.get('cik',-1))!=int(SEC_CIK):raise ValueError('Oracle SEC CIK mismatch')
 tags={'revenue':('RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet'),'operating_cash_flow':('NetCashProvidedByUsedInOperatingActivities',),'cash_ppe_capex':('PaymentsToAcquirePropertyPlantAndEquipment',)}
 result={}
 for family,choices in tags.items():
  rows=quarterly_flows(tagged_facts(payload,choices,as_of),as_of);validated=[]
  for row in rows:
   actual=date.fromisoformat(row['end'])
   if actual.month not in (2,5,8,11):continue
   fy=actual.year+(1 if actual.month>=8 else 0);q={8:1,11:2,2:3,5:4}[actual.month]
   if (row['start'],row['end'])!=quarter_dates('ORCL',fy,q):continue
   if family in ('revenue','cash_ppe_capex') and row['value']<0:raise ValueError('Oracle negative revenue/cash PPE requires manual validation')
   validated.append({**row,'fiscalYear':fy,'quarter':q})
  if not validated:raise ValueError('Oracle SEC actual quarter unavailable: '+family)
  result[family]=validated
 # A report is a complete core snapshot only when all three current intervals
 # are present; one tag's older observations cannot claim the new report.
 ends=[rows[-1]['end'] for rows in result.values()]
 if len(set(ends))!=1:raise ValueError('Oracle SEC core metric latest quarters do not match')
 return result

def update_sec_core(result,values,releases,stamp,version):
 from industry_sector_financials import filing_url
 metric='ORCL.cash_ppe_capex'
 if not any(d['id']==metric for d in result['definitions']):result['definitions'].append(cash_ppe_definition())
 for family,rows in values.items():
  metric='ORCL.'+family;prior=result['series'].get(metric,{});points={p['periodEnd']:p for p in prior.get('observations',[])}
  for row in rows:
   url=filing_url(SEC_CIK,row['accession'])
   point=observation(metric,row['end'],row['value']/100000000,url,stamp,version,row['start'],f"FY{row['fiscalYear']} Q{row['quarter']}",'actual quarter USD / 100000000; cumulative current minus prior YTD when applicable',{'source_api_url':SEC_URL,'source_cik':SEC_CIK,'original_unit':'USD','rawSourceFacts':json.dumps(row['inputs'],sort_keys=True,separators=(',',':')),'basis':row['basis']},published=row['publishedAt'])
   point.update(originalValue=row['value'],originalUnit='USD',originalCurrency='USD',filingDate=row['publishedAt']);points[row['end']]=point
  observations=sorted(points.values(),key=lambda p:p['periodEnd']);newest=observations[-1]
  sec_behind=newest['periodEnd']>rows[-1]['end']
  result['series'][metric]={'observations':observations,'status':'cached' if sec_behind else 'ready','fetchedAt':newest['fetchedAt'],'lastSuccessfulAt':stamp,'checkedAt':now(),'error':'SEC最新申报尚未包含既有较新财期，保留原附表最新观测。' if sec_behind else None,'note':'SEC实际季度核心口径；申报日与公司业绩公告日分别保存，其他分部及非GAAP附表仍按各自来源状态。'}
  d=next(d for d in result['definitions'] if d['id']==metric);d['sourceUrl']=points[rows[-1]['end']]['sourceUrl']
 latest=values['revenue'][-1];core=[values[family][-1] for family in values]
 for release in releases:
  if (release['fiscalYear'],release['quarter'])!=(latest['fiscalYear'],latest['quarter']):continue
  # SEC fy/fp describes the filing. Validate the current input, not a Q3
  # subtraction base, and require the actual interval to match this release.
  expected_fp='FY' if release['quarter']==4 else 'Q'+str(release['quarter'])
  inputs=[next((p for p in row['inputs'] if p['end']==row['end']),{}) for row in core]
  if not all(p.get('fy')==release['fiscalYear'] and p.get('fp')==expected_fp and p.get('filed','')>=release['publishedAt'][:10] for p in inputs):continue
  result['ingestedReleases'].append({**{k:release[k] for k in ('entity','url','fiscalYear','quarter','publishedAt')},'periodEnd':latest['end'],'parsedAt':stamp,'financialSourceUrl':filing_url(SEC_CIK,latest['accession']),'basis':'sec_core_metrics','metrics':['ORCL.revenue','ORCL.operating_cash_flow','ORCL.cash_ppe_capex'],'note':'仅更新SEC核心指标，原附表capex、分部及非GAAP净现金支出独立保留。'})

def apply_sec_fallback(result,releases,force=False):
 try:
  raw,stamp,version=fetch_sec_companyfacts(force=force)
  update_sec_core(result,parse_sec_core(raw),releases,stamp,version)
 except Exception as error:
  metric='ORCL.cash_ppe_capex';prior=result['series'].get(metric,{})
  if not any(d['id']==metric for d in result['definitions']):result['definitions'].append(cash_ppe_definition())
  result['series'][metric]={**prior,'observations':prior.get('observations',[]),'status':'cached' if prior.get('observations') else 'fetch_failed','checkedAt':now(),'error':'SEC核心口径备用获取失败：'+str(error),'note':'保留原官方附表历史；不能据此认定新财报尚未发布。'}
  return str(error)
 return None

def official_url(url):
 parsed=urlparse(url)
 return parsed.scheme=='https' and parsed.hostname in ALLOWED_HOSTS and not parsed.username

def discovered_candidates():
 from industry_releases import candidates
 return candidates('ORCL')

def fetch_report(url,force=False):
 from industry_releases import fetch_official
 return fetch_official(url,force=force)

def quarter_table(page,label,year,q):
 """Exclude both annual/YTD total columns and require an identifiable quarter grid."""
 if not re.search(r'\$\s*in\s+millions',page,re.I):raise ValueError('Oracle table unit is not USD millions')
 if not re.search(r'Fiscal\s+'+str(year-1)+r'\s+Fiscal\s+'+str(year),page,re.I):raise ValueError('Oracle fiscal-year columns do not match release')
 if not re.search(r'Q1\s+Q2\s+Q3\s+Q4\s+TOTAL\s+Q1\s+Q2\s+Q3\s+Q4',page,re.I):raise ValueError('Oracle quarter grid/TOTAL boundary missing')
 matches=re.findall(r'^\s*'+label+r'\s+([^\n]+)',page,re.M|re.I)
 for text in matches:
  if '%' in text:continue
  vals=numbers(text)
  if len(vals)!=6+q:continue
  # The official supplementary tables can have a rounding difference of one million.
  if abs(sum(vals[:4])-vals[4])>2 or abs(sum(vals[5:5+q])-vals[-1])>2:raise ValueError('Oracle quarterly columns do not reconcile with total')
  return [(year-1,i+1,v) for i,v in enumerate(vals[:4])]+[(year,i+1,v) for i,v in enumerate(vals[5:5+q])]
 raise ValueError('Oracle quarterly row missing or ambiguous: '+label)

def parse_oracle_pages(pages,year,q):
 """Parse the source's dated financial statements and explicitly quartered appendix."""
 joined='\n'.join(pages)
 if not re.search(r'Q'+str(q)+r'\s+FISCAL\s+'+str(year)+r'\s+FINANCIAL RESULTS',joined,re.I):raise ValueError('Oracle release fiscal identity mismatch')
 start,end=quarter_dates('ORCL',year,q)
 month=date.fromisoformat(end).strftime('%B');day=date.fromisoformat(end).day
 income=next((p for p in pages if 'CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS' in p.upper()),'')
 if not re.search(r'Three Months Ended\s+'+month+r'\s+'+str(day)+r',?',income,re.I) or not re.search(r'\b'+end[:4]+r'\b',income):raise ValueError('Oracle actual three-month income period missing')
 specs={'operating_cash_flow':('FREE CASH FLOW',r'GAAP Operating Cash Flow'),'capex':('FREE CASH FLOW',r'Capital Expenditures'),'net_capex_outlay':('NET CASH OUTLAY FOR CAPITAL EXPENDITURES',r'Net Cash Outlay for Capital Expenditures'),'revenue':('SUPPLEMENTAL ANALYSIS OF GAAP REVENUES',r'Total revenues'),'cloud_revenue':('SUPPLEMENTAL ANALYSIS OF GAAP REVENUES',r'Cloud'),'cloud_infrastructure_revenue':('SUPPLEMENTAL ANALYSIS OF GAAP REVENUES',r'Cloud infrastructure')}
 result={}
 for family,(heading,label) in specs.items():
  found=[]
  for i,page in enumerate(pages):
   if heading not in page.upper():continue
   try:rows=quarter_table(page,label,year,q)
   except ValueError:continue
   found=[{'fiscalYear':fy,'quarter':fq,'periodStart':quarter_dates('ORCL',fy,fq)[0],'periodEnd':quarter_dates('ORCL',fy,fq)[1],'value':abs(v) if family=='capex' else v,'sourcePage':i+1} for fy,fq,v in rows];break
  if not found and family in ('capex','operating_cash_flow','revenue'):raise ValueError('Oracle required quarter table cannot be validated: '+family)
  if found:result[family]=found
 return result

def parse_oracle_release(raw,year,q):
 if not raw.startswith(b'%PDF'):raise ValueError('Oracle financial appendix PDF required')
 return parse_oracle_pages([page.extract_text() or '' for page in PdfReader(io.BytesIO(raw)).pages],year,q)

def parse_oracle_html(raw,year,q):
 """Only exact financial tables qualify; the rounded press-release narrative does not."""
 soup=BeautifulSoup(raw,'html.parser');pages=[]
 for table in soup.find_all('table'):
  headings='\n'.join(h.get_text(' ',strip=True) for h in table.find_all_previous(['h1','h2','h3','h4'],limit=4))
  lines=[' '.join(c.get_text(' ',strip=True) for c in row.find_all(['td','th'],recursive=False)) for row in table.find_all('tr') if not row.find('table')]
  pages.append(headings+'\n'+'\n'.join(lines))
 if not pages:raise ValueError('Oracle rounded narrative has no exact financial tables')
 return parse_oracle_pages(pages,year,q)

def load_release(release,force=False):
 url=release['url']
 if not official_url(url):raise ValueError('Oracle report outside official domain')
 raw,stamp,version=fetch_report(url,force=force)
 if raw.startswith(b'%PDF'):return parse_oracle_release(raw,release['fiscalYear'],release['quarter']),url,stamp,version
 soup=BeautifulSoup(raw,'html.parser');attachments=[]
 if soup.find('table'):
  try:return parse_oracle_html(raw,release['fiscalYear'],release['quarter']),url,stamp,version
  except ValueError:pass
 for a in soup.find_all('a',href=True):
  target=urljoin(url,a['href']);label=a.get_text(' ',strip=True)+' '+target
  if official_url(target) and urlparse(target).path.lower().endswith('.pdf') and re.search(r'press.?release|earnings.?release|financial.?results',label,re.I):attachments.append(target)
 failures=[]
 for target in dict.fromkeys(attachments):
  try:
   pdf,stamp,version=fetch_report(target,force=force)
   return parse_oracle_release(pdf,release['fiscalYear'],release['quarter']),target,stamp,version
  except Exception as e:failures.append(str(e))
 raise ValueError('Oracle official financial PDF unavailable or unvalidated'+(': '+'; '.join(failures) if failures else ''))

def seed_history(source):
 url=source['sourceUrl'];stamp=source['verifiedAt'];version=hashlib.sha256(json.dumps(source,sort_keys=True).encode()).hexdigest()
 result={'schemaVersion':'1','generatedAt':now(),'definitions':[],'series':{},'projects':[],'events':[],'ingestedReleases':[]}
 for family,values in source['rows'].items():
  name,en=NAMES.get(family,('OCI云基础设施收入','Oracle cloud infrastructure revenue') if family=='cloud_infrastructure_revenue' else ('资本开支净现金支出','Net cash outlay for capital expenditures'))
  metric='ORCL.'+family;method=NET_METHOD if family=='net_capex_outlay' else METHOD
  result['definitions'].append(definition(metric,name,en,'cloud' if 'cloud' in family else 'capex',family,'ORCL','Oracle Investor Relations',url,method=method))
  points=[observation(metric,p[3],v/100,url,stamp,version,p[2],f'FY{p[0]} Q{p[1]}','USD million / 100 = 亿美元',{en:v,'source_page':10 if family in ('revenue','cloud_revenue','cloud_infrastructure_revenue') else 9},published=source['publishedAt']) for p,v in zip(source['periods'],values)]
  result['series'][metric]={'observations':points,'status':'cached','fetchedAt':stamp,'checkedAt':now(),'error':'保留经核验历史财报版本；等待官方新报告解析。'}
 return result

def update_history(result,parsed,release,url,stamp,version):
 for family,rows in parsed.items():
  metric='ORCL.'+family;d=next(d for d in result['definitions'] if d['id']==metric)
  d['sourceUrl']=url
  series=result['series'][metric];points={p['periodEnd']:p for p in series['observations']}
  for row in rows:
   points[row['periodEnd']]=observation(metric,row['periodEnd'],row['value']/100,url,stamp,version,row['periodStart'],f"FY{row['fiscalYear']} Q{row['quarter']}",'USD million / 100 = 亿美元',{'reported_USD_million':row['value'],'source_page':row['sourcePage'],'column':'Q'+str(row['quarter']),'fiscalYear':row['fiscalYear'],'excluded_columns':['TOTAL','YTD']},published=release['publishedAt'])
  result['series'][metric]={'observations':sorted(points.values(),key=lambda p:p['periodEnd']),'status':'ready','fetchedAt':stamp,'checkedAt':now(),'error':None}
 end=quarter_dates('ORCL',release['fiscalYear'],release['quarter'])[1]
 result['ingestedReleases'].append({**{k:release[k] for k in ('entity','url','fiscalYear','quarter','publishedAt')},'periodEnd':end,'parsedAt':stamp,'financialSourceUrl':url,'ingestionMethod':'validated_quarter_tables'})

def reviewed_proof(result,source,release):
 """Match a discovered publication to facts already verified in the exact official PDF."""
 fy,q,_,end=source['periods'][-1];url=source['sourceUrl']
 if not official_url(url) or not urlparse(url).path.lower().endswith('.pdf'):return None
 if (release.get('fiscalYear'),release.get('quarter'),release.get('publishedAt'))!=(fy,q,source['publishedAt']):return None
 for family,values in source['rows'].items():
  p=next((p for p in result['series'].get('ORCL.'+family,{}).get('observations',[]) if p['periodEnd']==end),None)
  if not p or p['value']!=values[-1]/100 or p['sourceUrl']!=url or p.get('publishedAt')!=source['publishedAt']:return None
 return {**{k:release[k] for k in ('entity','url','fiscalYear','quarter','publishedAt')},'periodEnd':end,'parsedAt':source['verifiedAt'],'financialSourceUrl':url,'ingestionMethod':'reviewed_official_table','basis':'reviewed_history'}

def derived_series(result):
 for family,a,b,ratio in [('capex_ratio','capex','revenue',True),('free_cash_flow','operating_cash_flow','capex',False)]:
  metric='ORCL.'+family;left=result['series']['ORCL.'+a];right=result['series']['ORCL.'+b];lookup={p['periodEnd']:p for p in right['observations']};points=[]
  for p in left['observations']:
   other=lookup.get(p['periodEnd'])
   if not other or p['value'] is None or other['value'] is None or (ratio and not other['value']):continue
   points.append(observation(metric,p['periodEnd'],p['value']/other['value']*100 if ratio else p['value']-other['value'],p['sourceUrl'],p['fetchedAt'],p['version'],p['periodStart'],p['fiscalPeriod'],f'{a} / {b} × 100' if ratio else f'{a} - {b}',{a:p['value'],b:other['value'],'input_unit':'亿美元','input_versions':[p['version'],other['version']],'input_source_urls':[p['sourceUrl'],other['sourceUrl']]},published=max(filter(None,[p.get('publishedAt'),other.get('publishedAt')]),default=None)))
  existing=next((d for d in result['definitions'] if d['id']==metric),None)
  if existing:result['definitions'].remove(existing)
  url=points[-1]['sourceUrl'] if points else left.get('sourceUrl','')
  result['definitions'].append(definition(metric,*NAMES[family],'capex',family,'ORCL','Oracle Investor Relations',url,'%' if ratio else '亿美元','calculated',f'{a} / {b} × 100' if ratio else f'{a} - {b}'))
  cached=left['status']!='ready' or right['status']!='ready'
  result['series'][metric]={'observations':points,'status':'cached' if cached else 'ready','fetchedAt':points[-1]['fetchedAt'] if points else None,'checkedAt':now(),'error':left.get('error') or right.get('error')}

def run(force=False):
 source=json.loads((DATA/'oracle-reviewed.json').read_text(encoding='utf-8'));path=DATA/'oracle.json';result=seed_history(source)
 if path.exists():
  old=json.loads(path.read_text(encoding='utf-8'))
  prior_definitions={d['id']:d for d in old.get('definitions',[])}
  if 'ORCL.cash_ppe_capex' in old.get('series',{}):
   result['definitions'].append(cash_ppe_definition());result['series']['ORCL.cash_ppe_capex']=old['series']['ORCL.cash_ppe_capex']
  for metric,series in old.get('series',{}).items():
   if metric not in result['series']:continue
   points={p['periodEnd']:p for p in result['series'][metric]['observations']};points.update({p['periodEnd']:p for p in series.get('observations',[])})
   result['series'][metric]={**series,'observations':sorted(points.values(),key=lambda p:p['periodEnd'])}
   d=next(d for d in result['definitions'] if d['id']==metric)
   if metric in prior_definitions:d['sourceUrl']=prior_definitions[metric].get('sourceUrl',d['sourceUrl'])
  result['ingestedReleases']+=old.get('ingestedReleases',[])
 errors=[]
 try:releases=discovered_candidates()
 except Exception as e:releases=[];errors.append('官方发布发现失败：'+str(e))
 for release in sorted(releases,key=lambda r:(r['fiscalYear'],r['quarter'])):
  proof=reviewed_proof(result,source,release)
  if proof:result['ingestedReleases'].append(proof)
  try:
   parsed,url,stamp,version=load_release(release,force=force);update_history(result,parsed,release,url,stamp,version)
  except Exception as e:errors.append(f"FY{release['fiscalYear']} Q{release['quarter']}: {e}")
 if errors or not releases:
  error='; '.join(errors) if errors else '尚无可验证的新官方财报候选；保留上次成功数据。'
  for series in result['series'].values():series.update(status='cached',checkedAt=now(),error=error)
  sec_error=apply_sec_fallback(result,releases,force=force)
  if sec_error:errors.append('SEC备用：'+sec_error)
 derived_series(result)
 result['ingestedReleases']=list({(r['entity'],r['url'],r['fiscalYear'],r['quarter']):r for r in result['ingestedReleases']}.values())
 result['releaseErrors']=errors;persist(result,path);print('Oracle official quarters',len(result['series']['ORCL.revenue']['observations']),flush=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--force',action='store_true');run(force=parser.parse_args().force)
