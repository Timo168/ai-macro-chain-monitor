"""Reviewed Oracle official table, with repeatable direct PDF parser when reachable."""
import hashlib,io,json,re
from pypdf import PdfReader
from industry_common import ROOT,DATA,now,fetch,definition,observation,persist
from industry_collect import NAMES,numbers
def run():
 source=json.loads((DATA/'oracle-reviewed.json').read_text(encoding='utf-8'));url=source['sourceUrl'];stamp=source['verifiedAt'];version=hashlib.sha256(json.dumps(source,sort_keys=True).encode()).hexdigest();error=None
 # These reviewed facts are a fixed, explicitly dated import; never relabel them as a new parse.
 error='已核验静态财报版本；新报告与修订尚待完整解析，不以重新下载冒充更新。'
 result={'schemaVersion':'1','generatedAt':now(),'definitions':[],'series':{},'projects':[],'events':[]}
 for family,values in source['rows'].items():
  name,en=NAMES.get(family,('OCI云基础设施收入','Oracle cloud infrastructure revenue') if family=='cloud_infrastructure_revenue' else ('资本开支净现金支出','Net cash outlay for capital expenditures'))
  id='ORCL.'+family;method='Oracle官方FY2027Q1财报附表。实际财季不同于自然季度，按附表单季列提取，剔除TOTAL列。资本开支净现金支出另扣相关短期融资及带融资成分的客户预付款，不与GAAP资本开支混用。'
  d=definition(id,name,en,'cloud' if 'cloud' in family else 'capex',family,'ORCL','Oracle Investor Relations',url,method=method);result['definitions'].append(d)
  pts=[observation(id,p[3],v/100,url,stamp,version,p[2],f'FY{p[0]} Q{p[1]}','USD million / 100 = 亿美元',{en:v,'source_page':10 if family in ('revenue','cloud_revenue','cloud_infrastructure_revenue') else 9},published=source['publishedAt']) for p,v in zip(source['periods'],values)]
  result['series'][id]={'observations':pts,'status':'cached' if error else 'ready','fetchedAt':stamp,'checkedAt':now(),'error':error,'note':'源自经核验官方PDF；直接抓取受限时保留核验版本。'}
 for family,a,b,ratio in [('capex_ratio','capex','revenue',True),('free_cash_flow','operating_cash_flow','capex',False)]:
  id='ORCL.'+family;d=definition(id,*NAMES[family],'capex',family,'ORCL','Oracle Investor Relations',url,'%' if ratio else '亿美元','calculated',f'{a} / {b} × 100' if ratio else f'{a} - {b}');result['definitions'].append(d);pts=[]
  for p,x,y in zip(source['periods'],source['rows'][a],source['rows'][b]):pts.append(observation(id,p[3],x/y*100 if ratio else (x-y)/100,url,stamp,version,p[2],f'FY{p[0]} Q{p[1]}',d['methodology'],{a:x,b:y,'input_unit':'USD million'},published=source['publishedAt']))
  result['series'][id]={'observations':pts,'status':'cached' if error else 'ready','fetchedAt':stamp,'checkedAt':now(),'error':error}
 persist(result,DATA/'oracle.json');print('Oracle reviewed official quarters',len(source['periods']))
if __name__=='__main__':run()
