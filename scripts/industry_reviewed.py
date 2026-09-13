"""Materialize separately reviewed official facts without claiming automated retrieval."""
import hashlib,json,sys
from industry_common import DATA,atomic,persist

SOURCE=DATA/'public-reviewed.json'
LEDGER=DATA/'public-source-facts.json'

def micron_definition():
    url='https://www.sec.gov/Archives/edgar/data/723125/000072312526000015/mu-20260528.htm'
    method='((期初库存+期末库存)/2) ÷ 当季GAAP销售成本 × 财季实际天数。Micron公司合并口径，含各类存储产品及其他存货，不能解释为HBM、DRAM或NAND单项库存。'
    return {'id':'MU.inventory_days','nameZh':'Micron公司整体库存周转天数','nameEn':'Micron company-wide inventory days','category':'semiconductor','family':'inventory_days','entity':'MU','frequency':'quarterly','unit':'天','currency':None,'valueType':'calculated','sourceName':'Micron SEC 10-Q','sourceUrl':url,'sourceOwner':'Micron Technology / U.S. SEC','accessMethod':'官方10-Q逐项核验导入；自动抓取受SEC访问限制时保留核验版本','methodology':method,'aiChainStage':['semiconductor'],'isComparableAcrossEntities':False,'normalUpdateDelayDays':65,'recommendationEligible':True,'exportAllowed':True,'aggregation':'none','licenseNote':'仅提取财务报表事实与计算结果并保留SEC原文链接。','sourceAdapter':'public-reviewed'}

def micron_observation(fact,reviewed_at):
    items=fact['originalItems'];value=(items['begin_inventory_million']+items['end_inventory_million'])/2/items['quarter_cost_million']*items['quarter_days']
    version=hashlib.sha256(json.dumps(fact,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    return {'metricId':'MU.inventory_days','periodStart':fact['periodStart'],'periodEnd':fact['periodEnd'],'fiscalPeriod':fact['fiscalPeriod'],'value':value,'originalValue':value,'publishedAt':fact['publishedAt'],'fetchedAt':fact.get('reviewedAt',reviewed_at),'sourceUrl':fact['sourceUrl'],'version':version,'isEstimated':False,'isRestated':False,'formula':'((期初库存+期末库存)/2) ÷ 当季GAAP销售成本 × 财季实际天数','originalItems':items}

def materialize(write_source=False):
    data=json.loads(SOURCE.read_text(encoding='utf-8'));ledger=json.loads(LEDGER.read_text(encoding='utf-8'))
    facts={(f['metricId'],f['periodEnd']):f for f in ledger['facts']}
    if not any(d['id']=='MU.inventory_days' for d in data['definitions']):data['definitions'].append(micron_definition())
    micron=[f for f in ledger['facts'] if f['metricId']=='MU.inventory_days']
    if len(micron)<3:raise ValueError('Micron inventory days requires three adjacent reviewed quarters')
    micron_points=[micron_observation(f,ledger['reviewedAt']) for f in sorted(micron,key=lambda x:x['periodEnd'])]
    data['series']['MU.inventory_days']={'observations':micron_points,'status':'reviewed','fetchedAt':max(p['fetchedAt'] for p in micron_points),'checkedAt':max(f.get('reviewedAt',ledger['reviewedAt']) for f in micron),'note':'Micron官方10-Q核验导入；公司整体口径，不代表HBM、DRAM或NAND单项。自动抓取受阻时保留此版本。'}
    for definition in data['definitions']:
        if definition.get('sourceAdapter')!='public-reviewed':continue
        series=data['series'][definition['id']]
        for point in series['observations']:
            fact=facts.get((definition['id'],point['periodEnd']))
            if fact is None:raise ValueError(f'Missing independent fact ledger row: {definition["id"]} {point["periodEnd"]}')
            if point['originalItems']!=fact['originalItems']:raise ValueError(f'Fact ledger operands differ: {definition["id"]} {point["periodEnd"]}')
            point['sourceUrl']=fact['sourceUrl'];point['publishedAt']=fact.get('publishedAt');point['fiscalPeriod']=fact.get('fiscalPeriod');point['periodStart']=fact.get('periodStart',point.get('periodStart'));point['fetchedAt']=fact.get('reviewedAt',point['fetchedAt'])
        series['status']='reviewed';series.pop('error',None)
        series['fetchedAt']=max(point['fetchedAt'] for point in series['observations'])
    data['generatedAt']=ledger['reviewedAt']
    if write_source:atomic(SOURCE,data)
    persist(data,DATA/'reviewed-cache.json')
    print('Reviewed official facts',len(facts),'across',len(data['definitions']),'metrics')
    return data

if __name__=='__main__':materialize('--normalize-source' in sys.argv)
