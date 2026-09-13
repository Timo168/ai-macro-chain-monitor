"""Three observations per connected metric: provenance and independent arithmetic audit.
Report documents its scope: this does not certify completeness or source redistribution rights.
"""
import io,json,math,sys,re,hashlib
from functools import lru_cache
from pathlib import Path
from bs4 import BeautifulSoup
from pypdf import PdfReader
from industry_common import DATA,ROOT,fetch
from industry_costs import parse_wb,parse_eia

@lru_cache(None)
def source(url):
    raw,digest=source_bytes(url)
    if raw.startswith(b'PK'):return raw,digest
    text=' '.join(p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages) if raw.startswith(b'%PDF') else BeautifulSoup(raw,'html.parser').get_text(' ',strip=True)
    return text.replace(',',''),digest

def source_bytes(url):
    meta=DATA/'raw'/(hashlib.sha256(url.encode()).hexdigest()+'.meta.json')
    if meta.exists():
        item=json.loads(meta.read_text(encoding='utf-8'));raw=(DATA/'raw'/item['file']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==item['hash']
        return raw,item['hash']
    raw,_,digest=fetch(url)
    return raw,digest

def check(d,p,data):
    items=p.get('originalItems',{});f=d['family'];value=p['value'];id=d['id']
    if d.get('sourceAdapter')=='public-reviewed':
        review=json.loads((DATA/'public-reviewed.json').read_text(encoding='utf-8'))
        fact=next(x for x in review['series'][id]['observations'] if x['periodEnd']==p['periodEnd'])
        assert fact['originalItems']==items
        if id=='POWER.interconnection':expected=(items['generation_gw']+items['storage_gw'])*1000
        elif id=='GOOG.backlog':expected=items['reported_billion_usd']*10
        elif id=='ETN.gross_margin':expected=(items['net_sales_million']-items['cost_products_million'])/items['net_sales_million']*100
        else:raise AssertionError('Missing independent reviewed formula for '+id)
        assert math.isclose(value,expected)
        return 'matched separately reviewed official source facts and independently recomputed units/formula; not an automated source audit'
    if f in ('capex_ratio','free_cash_flow','cloud_margin'):
        a,b={'capex_ratio':('capex','revenue'),'free_cash_flow':('operating_cash_flow','capex'),'cloud_margin':('cloud_profit','cloud_revenue')}[f]
        operands=[next(x['value'] for x in data['series'][d['entity']+'.'+k]['observations'] if x['periodEnd']==p['periodEnd']) for k in (a,b)]
        expected=operands[0]-operands[1] if f=='free_cash_flow' else operands[0]/operands[1]*100
        assert math.isclose(value,expected,rel_tol=1e-8,abs_tol=1e-8),(id,p['periodEnd'],value,expected)
        return 'matched input observations and independently recomputed formula'
    if id.startswith('ORCL.'):
        review=json.loads((DATA/'oracle-reviewed.json').read_text(encoding='utf-8'));idx=next(i for i,r in enumerate(review['periods']) if r[3]==p['periodEnd'])
        assert math.isclose(value,review['rows'][f][idx]/100)
        return 'matched separately reviewed official PDF table facts'
    raw,digest=source(p['sourceUrl'])
    if id=='DELL.inventory_days':
        from industry_collect import html_tables,row_numbers
        from industry_hardware import dates
        def tables_at(url):return html_tables(source_bytes(url)[0])[1]
        for key,date_key,url_key in [('begin_inventory_million','begin_date','begin_source_url'),('end_inventory_million',None,'end_source_url')]:
            end=items[date_key] if date_key else p['periodEnd']
            table=next(t for t in tables_at(items[url_key]) if row_numbers(t,'Inventories'))
            assert dict(zip(dates(table)[:2],row_numbers(table,'Inventories')[:2]))[end]==items[key]
        pnl=next(t for t in tables_at(p['sourceUrl']) if row_numbers(t,'Total net revenue') and 'Three Months Ended' in ' '.join(' '.join(r) for r in t[:6]))
        assert dates(pnl)[0]==p['periodEnd']
        assert row_numbers(pnl,'Total net revenue')[0]-row_numbers(pnl,'Gross margin')[0]==items['quarter_cost_million']
        from datetime import date
        days=(date.fromisoformat(p['periodEnd'])-date.fromisoformat(items['begin_date'])).days
        expected=(items['begin_inventory_million']+items['end_inventory_million'])/2/items['quarter_cost_million']*days
        assert days==items['quarter_days'] and math.isclose(value,expected)
        return 'matched dated beginning/end inventory tables and quarterly GAAP cost; independently counted fiscal days'
    if id=='POWER.equipment_price':
        from collect import parse_csv
        content,_=source_bytes(p['sourceUrl'])
        expected=next(x['value'] for x in parse_csv(content) if x['date']==items['source_observation_date'])
        assert value==expected
        return 'matched exact observation date in BLS/FRED CSV; native index unchanged'
    if id.startswith('WB.'):
        expected=dict(parse_wb(raw)[f])[p['periodEnd']];assert math.isclose(value,expected)
        return 'matched dated cell in archived official monthly workbook'
    if id.startswith('EIA.'):
        expected=next(x[1] for x in parse_eia(raw)[id[4:]] if x[0]==p['periodEnd']);assert math.isclose(value,expected)
        if id.startswith('EIA.US.'):assert math.isclose(value,items['revenue_thousand_usd']/items['sales_mwh']*100)
        return 'matched official state workbook; national series recomputed from 51 regions'
    operands=[v for k,v in items.items() if isinstance(v,(float,int)) and k not in ('source_page','region_count')]
    if not operands:operands=[p.get('originalValue',value)]
    for v in operands:
        # NVIDIA headline is in billions while normalized original item is in millions.
        candidates=[v,v/1000] if id=='NVDA.datacenter_revenue' else [v]
        assert any(re.search(r'(?<![\d.])'+re.escape(format(abs(x),'.12g'))+r'(?:\.0+)?(?![\d.])',raw) for x in candidates),(id,p['periodEnd'],'source operand not found',v)
    if id=='DELL.gross_margin':expected=items['Gross profit USD million']/items['Revenue USD million']*100
    elif d['unit']=='%':expected=operands[0]
    elif id.startswith('SIA.'):expected=items['reported_billion_USD']*10
    elif 'reported_billion_usd' in items:expected=items['reported_billion_usd']*10
    else:expected=abs(operands[0])/100 if f in ('capex','finance_lease_payments') else operands[0]/100
    assert math.isclose(value,expected,abs_tol=1e-8,rel_tol=1e-8),(id,p['periodEnd'],value,expected)
    return 'raw numeric operands present in official report; unit/formula independently recomputed'

def run():
    data=json.loads((DATA/'latest.json').read_text(encoding='utf-8'));samples=[]
    for d in data['definitions']:
        points=[p for p in data['series'][d['id']]['observations'] if p['value'] is not None]
        if not points:continue
        assert len(points)>=3,d['id']
        assert len({p['periodEnd'] for p in points})==len(points),d['id']
        for p in [points[0],points[len(points)//2],points[-1]]:
            method=check(d,p,data)
            samples.append({'metricId':d['id'],'periodEnd':p['periodEnd'],'value':p['value'],'unit':d['unit'],'currency':d.get('currency'),'sourceUrl':p['sourceUrl'],'version':p['version'],'check':method})
    folder=ROOT/'docs/industry';folder.mkdir(parents=True,exist_ok=True)
    (folder/'verification.json').write_text(json.dumps({'scope':'3 periods per metric; arithmetic and archived source checks, not a license or causal audit','samples':samples},ensure_ascii=False,indent=2),encoding='utf-8')
    print('Verified',len(samples),'historical samples across',len(samples)//3,'metrics')
if __name__=='__main__':run()
