"""Extract only SIA's own public monthly statistical announcements; not secondary news."""
import calendar,json,re
from bs4 import BeautifulSoup
from industry_common import DATA,now,fetch,definition,observation,persist
INDEX='https://www.semiconductors.org/policies/market-data/'
MONTHS={m.lower():i for i,m in enumerate(calendar.month_name) if m}
def parse_release(raw):
 text=' '.join(BeautifulSoup(raw,'html.parser').get_text(' ',strip=True).split());points=[]
 # Sales total must be adjacent to a named observation month, never a projection.
 for m in re.finditer(r'(?:sales (?:were|totaled|of)|total of)\s*\$(\d+(?:\.\d+)?)\s*billion\s*(?:during|for|in)?\s*(?:the month of\s*)?([A-Z][a-z]+)\s+(20\d\d)',text):
  value,month,year=m.groups()
  if month.lower() in MONTHS:points.append((int(year),MONTHS[month.lower()],float(value)))
 for m in re.finditer(r'([A-Z][a-z]+)\s+(20\d\d)\s+total of\s*\$(\d+(?:\.\d+)?)\s*billion',text):
  month,year,value=m.groups()
  if month.lower() in MONTHS:points.append((int(year),MONTHS[month.lower()],float(value)))
 if 'three-month moving average' not in text.lower():raise ValueError('SIA moving-average methodology not identified')
 return points
def run():
 path=DATA/'sia.json';old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {};id='SIA.semiconductor_sales';prior=old.get('series',{}).get(id,{});points={p['periodEnd']:p for p in prior.get('observations',[])};error=None;stamp=prior.get('fetchedAt')
 try:
  raw,_,_=fetch(INDEX);soup=BeautifulSoup(raw,'html.parser');links=list(dict.fromkeys(a.get('href') for a in soup.find_all('a') if a.get('href','').startswith('https://www.semiconductors.org/global-semiconductor-sales-')))
  for link in links[:8]:
   raw,fetched,version=fetch(link)
   for y,m,value in parse_release(raw):
    end=f'{y}-{m:02}-{calendar.monthrange(y,m)[1]}';points[end]=observation(id,end,value*10,link,fetched,version,formula='公开统计中的十亿美元 × 10 = 亿美元',items={'reported_billion_USD':value,'statistic':'three-month moving average'})
   stamp=fetched
  if not points:raise ValueError('尚未解析到完整月份、单位和数值')
 except Exception as e:error=str(e)
 d=definition(id,'全球半导体销售额（三个月移动平均）','Worldwide semiconductor sales, three-month moving average','semiconductor','semiconductor_sales','全球','SIA / WSTS',INDEX,'亿美元','official','只取SIA公开统计公告的已披露月份，是三个月移动平均，不是单月原始销售额。同比基于已公布的四舍五入金额计算，可能与官方未舍入增速略有差异。完整WSTS付费历史未接入；全球半导体不等于AI芯片。',eligible=False,frequency='monthly',export=False)
 d['licenseNote']='SIA/WSTS完整数据需要授权；仅展示公开统计公告数值与链接，CSV关闭。';result={'schemaVersion':'1','generatedAt':now(),'definitions':[d],'series':{id:{'observations':sorted(points.values(),key=lambda p:p['periodEnd']),'status':'cached' if error and points else 'fetch_failed' if error else 'ready','fetchedAt':stamp,'checkedAt':now(),'error':error}},'projects':[],'events':[]};persist(result,path);print('SIA public months',len(points),error or 'OK')
if __name__=='__main__':run()
