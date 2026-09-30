"""World Bank monthly metals/gas and EIA state retail electricity: no price interpolation."""
import io,json,re,calendar
from openpyxl import load_workbook
from industry_common import DATA,now,fetch,definition,observation,persist
WB='https://www.worldbank.org/en/research/commodity-markets'
WB_FILE='https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx'
EIA='https://www.eia.gov/electricity/data/state/xls/861m/HS861M%202010-.xlsx'
def parse_wb(raw):
 rows=list(load_workbook(io.BytesIO(raw),read_only=True,data_only=True)['Monthly Prices'].values);i=next(i for i,r in enumerate(rows[:12]) if 'Copper' in r);headers=rows[i];result={}
 for key,name in [('copper','Copper'),('aluminum','Aluminum'),('natural_gas','Natural gas, US')]:
  col=headers.index(name);pts=[]
  if ('mt' if key!='natural_gas' else 'mmbtu') not in str(rows[i+1][col]).lower():raise ValueError('Unexpected WB unit')
  for row in rows[i+2:]:
   if not re.fullmatch(r'\d{4}M\d{2}',str(row[0])):continue
   y,m=map(int,str(row[0]).split('M'));v=row[col];pts.append((f'{y}-{m:02}-{calendar.monthrange(y,m)[1]}',float(v) if isinstance(v,(int,float)) else None))
  result[key]=pts
 return result
def parse_eia(raw):
 book=load_workbook(io.BytesIO(raw),read_only=True,data_only=True);rows=list(book['Monthly-States'].values)
 # Validate the source layout for both end-use sectors before indexing the
 # cells.  A shifted workbook must fail and retain the last good snapshot,
 # rather than silently treating revenue or sales as a price.
 if not (
  rows[1][8]=='Revenue' and rows[1][9]=='Sales' and rows[1][11]=='Price'
  and rows[2][8]=='Thousand Dollars' and rows[2][9]=='Megawatthours' and rows[2][11]=='Cents/kWh'
  and rows[1][12]=='Revenue' and rows[1][13]=='Sales' and rows[1][15]=='Price'
  and rows[2][12]=='Thousand Dollars' and rows[2][13]=='Megawatthours' and rows[2][15]=='Cents/kWh'
 ):
  raise ValueError('Unexpected EIA-861M commercial/industrial column layout')
 result={};national={}
 for row in rows[3:]:
  if isinstance(row[0],(int,float)) and isinstance(row[2],str) and len(row[2])==2:
   y,m=int(row[0]),int(row[1]);end=f'{y}-{m:02}-{calendar.monthrange(y,m)[1]}'
   for sector,revenue,sales in [('commercial',8,9),('industrial',12,13)]:
    national.setdefault((end,sector),[]).append((row[2],row[revenue],row[sales]))
  if not isinstance(row[0],(int,float)) or row[2] not in ('US','VA','TX','OH','GA','AZ','SC','ID','IN','LA'):continue
  y,m=int(row[0]),int(row[1]);end=f'{y}-{m:02}-{calendar.monthrange(y,m)[1]}'
  for sector,col,sales_col in [('commercial',11,9),('industrial',15,13)]:
   key=str(row[2])+'.'+sector;v=row[col];sales=row[sales_col]
   result.setdefault(key,[]).append((end,float(v) if isinstance(v,(int,float)) and v>0 else None,str(row[3]),{'price_cents_kwh':v}))
   # EIA-861M sales are statewide end-use sales, not electricity consumed by
   # data centers.  Keep the native MWh facts separately so a displayed
   # price never gets mistaken for a demand measure and missing inputs are not
   # converted to zero.
   result.setdefault(key+'_sales',[]).append((end,float(sales) if isinstance(sales,(int,float)) and sales>=0 else None,str(row[3]),{'sales_mwh':sales}))
 for (end,sector),points in national.items():
  all_regions=len({p[0] for p in points})==51
  all_sales=all(isinstance(p[2],(int,float)) and p[2]>=0 for p in points)
  sales_value=sum(p[2] for p in points) if all_regions and all_sales else None
  value=100*sum(p[1] for p in points)/sales_value if sales_value and all(isinstance(p[1],(int,float)) for p in points) else None
  price_items={'revenue_thousand_usd':sum(p[1] for p in points) if value is not None else None,'sales_mwh':sales_value,'region_count':len({p[0] for p in points})}
  result.setdefault('US.'+sector,[]).append((end,value,'Calculated: 50 states + DC revenue-weighted by sales',price_items))
  result.setdefault('US.'+sector+'_sales',[]).append((end,sales_value,'Calculated: 50 states + DC sales total',{'sales_mwh':sales_value,'region_count':len({p[0] for p in points})}))
 return {k:sorted(v) for k,v in result.items()}
def run():
 path=DATA/'costs.json';old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'series':{}};result={'schemaVersion':'1','generatedAt':now(),'definitions':[],'series':{},'projects':[],'events':[]}
 try:
  url=WB_FILE
  try:
   html=fetch(WB)[0].decode(errors='replace');matches=re.findall(r'https://[^\s"<>]+CMO-Historical-Data-Monthly\.xlsx',html)
   if matches:url=matches[-1]
  except Exception:pass
  raw,stamp,version=fetch(url);metal=parse_wb(raw);error=None
 except Exception as e:metal={};error=str(e)
 for key,name,en in [('copper','铜','Copper'),('aluminum','铝','Aluminum'),('natural_gas','美国天然气','Natural gas, U.S. Henry Hub')]:
  id='WB.'+key;d=definition(id,name,en,'costs',key,'全球' if key!='natural_gas' else '美国','World Bank Pink Sheet',WB,'美元/公吨' if key!='natural_gas' else '美元/MMBtu','official','世界银行月度均价。天然气为美国 Henry Hub 基准；不是各地发电厂或数据中心采购合同。',frequency='monthly');result['definitions'].append(d)
  if key in metal:result['series'][id]={'observations':[observation(id,date,v,url,stamp,version) for date,v in metal[key]],'status':'ready','fetchedAt':stamp,'checkedAt':now()}
  else:result['series'][id]={**old['series'].get(id,{'observations':[]}),'status':'cached' if old['series'].get(id,{}).get('observations') else 'fetch_failed','checkedAt':now(),'error':error}
 try:raw,stamp,version=fetch(EIA);electricity=parse_eia(raw);error=None
 except Exception as e:electricity={};error=str(e)
 regions={'US':'美国全国','VA':'弗吉尼亚州','TX':'得克萨斯州','OH':'俄亥俄州','GA':'佐治亚州','AZ':'亚利桑那州','SC':'南卡罗来纳州','ID':'爱达荷州','IN':'印第安纳州','LA':'路易斯安那州'}
 for region,name in regions.items():
  for sector,label in [('commercial','商业'),('industrial','工业')]:
   key=region+'.'+sector;id='EIA.'+key;d=definition(id,name+label+'电价',name+' '+sector+' retail electricity price','power','electricity',region,'EIA-861M','https://www.eia.gov/electricity/data/state/','美分/kWh','official','终端零售收入/售电量的平均价格；商业/工业分别统计，非批发电价、非数据中心实际合同价格。月度初值可修订。',frequency='monthly');d.update({'sourceAdapter':'costs','directness':'regional_retail_price','dataRole':'electricity_cost_context','normalUpdateDelayDays':45,'aggregation':'mean'});result['definitions'].append(d)
   if region=='US':d['valueType']='calculated';d['methodology']='美国50州及DC行业收入总和（千美元）/售电量总和（MWh）×100 = 美分/kWh；仅51个地区齐备时计算。非各州价格的简单平均，非数据中心合同价。'
   if key in electricity:result['series'][id]={'observations':[dict(observation(id,date,v,EIA,stamp,version,formula='sum(state revenue thousand USD) / sum(state sales MWh) * 100' if region=='US' else None,items=items),basis=status) for date,v,status,items in electricity[key]],'status':'ready','fetchedAt':stamp,'lastSuccessfulAt':stamp,'checkedAt':now(),'error':None}
   else:result['series'][id]={**old['series'].get(id,{'observations':[]}),'status':'cached' if old['series'].get(id,{}).get('observations') else 'fetch_failed','checkedAt':now(),'error':error or '来源文件尚未取得该地区'}
   sales_id='EIA.'+key+'_sales';sales_definition=definition(sales_id,name+label+'售电量',name+' '+sector+' retail electricity sales','power','electricity_sales',region,'EIA-861M','https://www.eia.gov/electricity/data/state/','MWh','official','EIA-861M按州、终端行业统计的月度售电量。商业与工业分类由公用事业或服务商按NAICS、需求/用量或费率表划分；不是数据中心专属负荷，不能据此推导AI耗电或项目投运。',False,frequency='monthly');sales_definition.update({'sourceAdapter':'costs','directness':'regional_load_proxy','dataRole':'electricity_demand_context','interpretation':'州级商业/工业售电量是区域终端用电背景，天气、人口、一般商业和工业活动都会影响它。','transmission':'持续变化可提示区域用电环境或电网压力变化，仍须结合项目所在地、并网、合同和电力负荷验证。','crossCheck':'EIA-860M机组容量、ERCOT等区域实际负荷、项目级官方状态与披露MW。','normalUpdateDelayDays':45,'aggregation':'sum'});result['definitions'].append(sales_definition)
   sales_key=key+'_sales'
   if sales_key in electricity:result['series'][sales_id]={'observations':[dict(observation(sales_id,date,v,EIA,stamp,version,formula='sum(state sales MWh) for 50 states + DC' if region=='US' else None,items=items),basis=status) for date,v,status,items in electricity[sales_key]],'status':'ready','fetchedAt':stamp,'lastSuccessfulAt':stamp,'checkedAt':now(),'error':None,'note':'区域终端售电量背景，不是数据中心实际耗电。'}
   else:result['series'][sales_id]={**old['series'].get(sales_id,{'observations':[]}),'status':'cached' if old['series'].get(sales_id,{}).get('observations') else 'fetch_failed','checkedAt':now(),'error':error or '来源文件尚未取得该地区'}
 persist(result,path);print('industry costs:',sum(bool(s['observations']) for s in result['series'].values()),'connected')
if __name__=='__main__':run()
