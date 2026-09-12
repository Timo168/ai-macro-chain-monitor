"""Provenance and durable revisions shared by industry source adapters."""
import hashlib,json,os,pathlib,sqlite3,subprocess,urllib.request
from datetime import datetime,timezone,timedelta
ROOT=pathlib.Path(__file__).resolve().parents[1];DATA=ROOT/'data'/'industry';DATA.mkdir(parents=True,exist_ok=True)
def now():return datetime.now(timezone.utc).isoformat()
def atomic(path,value):
 tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':')),encoding='utf-8');os.replace(tmp,path)
def fetch(url,force=False):
 key=hashlib.sha256(url.encode()).hexdigest();folder=DATA/'raw';folder.mkdir(exist_ok=True);meta=folder/(key+'.meta.json')
 old=json.loads(meta.read_text(encoding='utf-8')) if meta.exists() else {}
 if not force and old and datetime.now(timezone.utc)-datetime.fromisoformat(old['fetchedAt'])<timedelta(hours=24):return (folder/old['file']).read_bytes(),old['fetchedAt'],old['hash']
 try:
  with urllib.request.urlopen(url,timeout=25) as response:raw=response.read()
 except Exception:
  proc=subprocess.run(['curl.exe' if os.name=='nt' else 'curl','--fail','--location','--silent','--show-error','--max-time','25',url],capture_output=True)
  if proc.returncode:raise RuntimeError('来源请求失败 HTTP/网络错误；保留上次成功版本')
  raw=proc.stdout
 if len(raw)<100:raise ValueError('来源响应为空或过短')
 digest=hashlib.sha256(raw).hexdigest();name=digest+('.pdf' if raw.startswith(b'%PDF') else '.xlsx' if raw.startswith(b'PK') else '.html');(folder/name).write_bytes(raw)
 stamp=now();atomic(meta,{'url':url,'file':name,'hash':digest,'fetchedAt':stamp});return raw,stamp,digest
def definition(id,name,en,category,family,entity,source,url,unit='亿美元',value_type='reported',method='',eligible=True,frequency='quarterly',export=True):
 return {'id':id,'nameZh':name,'nameEn':en,'category':category,'family':family,'entity':entity,'frequency':frequency,'unit':unit,'currency':'USD' if '美元' in unit else None,'valueType':value_type,'sourceName':source,'sourceUrl':url,'sourceOwner':source,'accessMethod':'公开财报/数据文件；后台抓取','methodology':method,'aiChainStage':[category],'isComparableAcrossEntities':family in ('capex','revenue','operating_cash_flow','free_cash_flow','capex_ratio'),'normalUpdateDelayDays':65 if frequency=='quarterly' else 70,'recommendationEligible':eligible,'exportAllowed':export,'aggregation':'mean' if frequency=='monthly' else 'none','licenseNote':'仅提取事实数值并保留来源；不再分发整篇财报正文。'}
def observation(id,date,value,url,stamp,version,start=None,fiscal=None,formula=None,items=None,published=None):
 return {'metricId':id,'periodStart':start,'periodEnd':date,'fiscalPeriod':fiscal,'value':value,'originalValue':value,'publishedAt':published,'fetchedAt':stamp,'sourceUrl':url,'version':version,'isEstimated':False,'isRestated':False,'formula':formula,'originalItems':items or {}}
def persist(result,path):
 for key,series in result['series'].items():
  seen=set()
  for p in series['observations']:
   end=datetime.fromisoformat(p['periodEnd']).date()
   if end>datetime.now(timezone.utc).date() or p['periodEnd'] in seen:raise ValueError('Future or duplicate observation: '+key)
   seen.add(p['periodEnd'])
   if p.get('periodStart') and p['periodStart']>p['periodEnd']:raise ValueError('Invalid fiscal interval: '+key)
   if p['value'] is not None and (isinstance(p['value'],bool) or not isinstance(p['value'],(float,int)) or not __import__('math').isfinite(p['value'])):raise ValueError('Invalid numeric observation: '+key)
 conn=sqlite3.connect(DATA/'industry.sqlite');conn.execute('CREATE TABLE IF NOT EXISTS observations(metric_id TEXT,period_end TEXT,version TEXT,payload TEXT,first_seen TEXT,PRIMARY KEY(metric_id,period_end,version))')
 for key,series in result['series'].items():
  for p in series['observations']:
   old=conn.execute('SELECT payload FROM observations WHERE metric_id=? AND period_end=? ORDER BY first_seen DESC LIMIT 1',(key,p['periodEnd'])).fetchone()
   if old:
    prior=json.loads(old[0]);same=prior['value']==p['value'] and prior.get('formula')==p.get('formula') and prior.get('originalItems')==p.get('originalItems')
    if same:p['version']=prior['version'];p['isRestated']=prior.get('isRestated',False)
    else:
     p['isRestated']=True
     p['version']=hashlib.sha256(json.dumps([p['version'],p['value'],p.get('formula'),p.get('originalItems')],sort_keys=True).encode()).hexdigest()
   conn.execute('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?)',(key,p['periodEnd'],p['version'],json.dumps(p,ensure_ascii=False),now()))
 conn.commit();conn.close();atomic(path,result)
