"""Independently re-read 3 archived official source points per new metric.

No network calls or collector parsers; this verifies the exact downloaded bytes,
source column and unit conversion, not only the saved transformed JSON.
"""
import hashlib,io,json,re
from datetime import datetime
from pathlib import Path
from bs4 import BeautifulSoup
from pypdf import PdfReader

ROOT=Path(__file__).resolve().parents[1];DATA=ROOT/'data'/'industry'
METRICS={'companies.json':['NVDA.revenue','NVDA.gross_margin','NVDA.datacenter_revenue'],'hardware.json':['DELL.servers_networking_revenue'],'supply-evidence.json':['EQIX.operational_capacity','EQIX.development_capacity','ANET.company_revenue','ANET.gross_margin']}

def verify_raw(point):
 meta=json.loads((DATA/'raw'/(hashlib.sha256(point['sourceUrl'].encode()).hexdigest()+'.meta.json')).read_text(encoding='utf-8'));raw=(DATA/'raw'/meta['file']).read_bytes()
 assert hashlib.sha256(raw).hexdigest()==meta['hash'],'Source byte checksum changed'
 return raw,meta['hash']

def cells(raw):
 soup=BeautifulSoup(raw,'html.parser');tables=[[[c.get_text(' ',strip=True) for c in r.find_all(['td','th'],recursive=False)] for r in t.find_all('tr') if not r.find('table')] for t in soup.find_all('table')]
 return soup,tables

def nums(row):return [float(x.replace(',','')) for x in re.findall(r'\d[\d,]*(?:\.\d+)?',' '.join(row[1:]))]

def source_value(metric,point,raw):
 if metric.startswith('NVDA.'):
  soup,tables=cells(raw);text=soup.get_text(' ',strip=True)
  if metric.endswith('datacenter_revenue'):return float(re.search(r'Data Center revenue(?: of| was)? \$([\d.]+) billion',text,re.I)[1])*10,'headline USD billion × 10 = 亿美元'
  label='Gross margin' if metric.endswith('gross_margin') else 'Revenue'
  table=next(t for t in tables if 'GAAP' in ' '.join(' '.join(r) for r in t[:3]) and any(r and r[0]==label for r in t))
  value=nums(next(r for r in table if r and r[0]==label))[0]
  return (value if label=='Gross margin' else value/100),'GAAP current quarter column; USD million / 100 or reported %'
 if metric.startswith('DELL.'):
  _,tables=cells(raw);table=next(t for t in tables if any(r and r[0].lower() in ['servers and networking','ai-optimized servers'] for r in t))
  dates=re.findall(r'[A-Z][a-z]+ \d{1,2}\s*,?\s*20\d\d',' '.join(' '.join(r) for r in table[:8]));dates=[datetime.strptime(' '.join(x.replace(',','').split()),'%B %d %Y').date().isoformat() for x in dates];column=dates.index(point['periodEnd'])
  row=next((r for r in table if r and r[0].lower()=='servers and networking'),None)
  value=nums(row)[column] if row else sum(nums(next(r for r in table if r and r[0].lower()==label.lower()))[column] for label in ['AI-optimized servers','Traditional servers and networking'])
  return value/100,'actual dated fiscal column; combined AI + traditional USD million / 100'
 pages=[p.extract_text() or '' for p in PdfReader(io.BytesIO(raw)).pages];text=' '.join(' '.join(pages).split())
 if metric.startswith('ANET.'):
  if metric.endswith('company_revenue'):
   m=re.search(r'Revenue of \$([\d.]+) (billion|million)',text);return float(m[1])*(10 if m[2]=='billion' else .01),'issuer quarterly revenue USD billion/million → 亿美元'
  return float(re.search(r'(?<!Non-)GAAP gross margin(?: of)? ([\d.]+)%',text)[1]),'first actual GAAP column; non-GAAP excluded'
 page=pages[int(point['originalItems']['page'])-1];page=' '.join(page.split()).replace('Previously Opened Data Centers','Previously Opened Capacity');label='Previously Opened Capacity' if metric.endswith('operational_capacity') else 'Capacity Under Development'
 assert 'Capacity (MW)' in page
 m=re.search(re.escape(label)+r'(?:\s*\(\d+\))*(?:\s*JV\s+(?:Open\s*){1,2})?\s*\$?\s*(\d[\d,]*)\s*\$?\s+(\d[\d,]*)\s+(\d[\d,]*)',page)
 return float(m[2].replace(',','')),'MW second column, not project investment $ or leased MW'

def run():
 rows=[]
 for file,metrics in METRICS.items():
  payload=json.loads((DATA/file).read_text(encoding='utf-8'))
  for metric in metrics:
   observations=payload['series'][metric]['observations']
   for point in [observations[0],observations[len(observations)//2],observations[-1]]:
    raw,source_hash=verify_raw(point);value,rule=source_value(metric,point,raw);assert abs(value-point['value'])<1e-8,(metric,point['periodEnd'],value,point['value'])
    rows.append({'metricId':metric,'periodEnd':point['periodEnd'],'storedValue':point['value'],'recomputedValue':value,'passed':True,'rule':rule,'sourceUrl':point['sourceUrl'],'sourceByteSha256':source_hash,'observationVersion':point['version'],'publishedAt':point.get('publishedAt'),'fetchedAt':point['fetchedAt']})
 output=ROOT/'docs'/'industry'/'supply-evidence-verification.json';output.write_text(json.dumps({'checkedAt':datetime.now().astimezone().isoformat(),'method':'Independently re-read archived official bytes and table columns; no collector parser reuse','passed':len(rows),'checked':len(rows),'points':rows},ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print('Official source points verified:',len(rows))

if __name__=='__main__':run()
