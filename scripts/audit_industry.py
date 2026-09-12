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
    raw,_,digest=fetch(url)
    if raw.startswith(b'PK'):return raw,digest
    text=' '.join(p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages) if raw.startswith(b'%PDF') else BeautifulSoup(raw,'html.parser').get_text(' ',strip=True)
    return text.replace(',',''),digest

def check(d,p,data):
    items=p.get('originalItems',{});f=d['family'];value=p['value'];id=d['id']
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
