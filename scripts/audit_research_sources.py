"""Three raw-source spot checks per newly connected actual metric.

This verifies units, dated inputs and calculations, not investment performance.
It reads the archived raw source independently of collector parse functions.
"""
import hashlib, io, json, math, re
from collections import defaultdict
from pathlib import Path
from pypdf import PdfReader

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data'/'industry'

def raw_source(url):
    meta=json.loads((DATA/'raw'/(hashlib.sha256(url.encode()).hexdigest()+'.meta.json')).read_text(encoding='utf-8'))
    raw=(DATA/'raw'/meta['file']).read_bytes()
    assert hashlib.sha256(raw).hexdigest()==meta['hash'], 'Raw source checksum mismatch'
    return raw

def quarter_value(inputs):
    assert len(inputs) in (1,2)
    if len(inputs)==1:return inputs[0]['val']
    current,base=sorted(inputs,key=lambda fact:fact['end'],reverse=True)
    assert current['start']==base['start'] and base['filed']<=current['filed']
    return current['val']-base['val']

def verify_financial(definition,point):
    items=point['originalItems']
    if definition['entity']=='TSM':
        text=' '.join(' '.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(raw_source(point['sourceUrl']))).pages).split())
        text=re.sub(r'(?<=\d)\s+(?=\d)', '', text)
        text=re.sub(r'(\d)\.\s+(\d)',r'\1.\2',text)
        pattern=r'Gross margin for the quarter was (\d+(?:\.\d+)?)%' if definition['family']=='gross_margin' else r'consolidated revenue of NT\$([\d,.]+) billion'
        match=re.search(pattern,text,re.I);assert match, 'Actual TSMC value anchor missing'
        expected=float(match[1].replace(',',''))*(1 if definition['family']=='gross_margin' else 10)
        assert point['publishedAt'] and point['publishedAt']>point['periodEnd']
    else:
        payload=json.loads(raw_source(items['source_api_url']))
        assert str(payload['cik']).zfill(10)==items['source_cik']
        inputs=json.loads(items['rawSourceFacts']);groups=defaultdict(list)
        for fact in inputs:
            source_rows=payload['facts']['us-gaap'][fact['tag']]['units']['USD']
            assert any(all(row.get(key)==value for key,value in fact.items() if key!='tag') for row in source_rows)
            assert fact['filed']<=point['publishedAt'], 'Future vintage used in quarterly calculation'
            groups[fact['tag']].append(fact)
        revenues=[tag for tag in groups if tag in ('RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet')]
        assert len(revenues)==1
        revenue=quarter_value(groups[revenues[0]])
        if definition['family']=='company_revenue':expected=revenue/100000000
        else:
            other=[tag for tag in groups if tag!=revenues[0]];assert len(other)==1
            amount=quarter_value(groups[other[0]])
            gross=amount if other[0]=='GrossProfit' else revenue-amount
            expected=gross/revenue*100
    assert math.isclose(point['value'],expected,rel_tol=1e-9,abs_tol=1e-9)
    return expected

def verify_cso(point):
    payload=json.loads(raw_source(point['originalItems']['sourceApiUrl']))
    indices={}
    for dimension in payload['id']:
        order=payload['dimension'][dimension]['category']['index']
        indices[dimension]=order if isinstance(order,dict) else {code:i for i,code in enumerate(order)}
    coordinates={'STATISTIC':'MEC02','TLIST(Q1)':point['originalItems']['sourceQuarter'],'C03907V04659':'10'}
    offset=0
    for name,size in zip(payload['id'],payload['size']):offset=offset*size+indices[name][coordinates[name]]
    expected=payload['value'][offset] if isinstance(payload['value'],list) else payload['value'].get(str(offset))
    assert point['value']==expected
    assert payload['dimension']['STATISTIC']['category']['unit']['MEC02']['label']=='GWh'
    assert point['publishedAt'].replace('+00:00','Z')==payload['updated'].replace('.000Z','Z')
    return expected

def run():
    financial=json.loads((DATA/'sector-financials.json').read_text(encoding='utf-8'))
    institutions=json.loads((DATA/'institutions.json').read_text(encoding='utf-8'))
    checks=[]
    for definition in financial['definitions']+institutions['definitions']:
        data=financial if definition.get('sourceAdapter')=='sector-financials' else institutions
        observations=[p for p in data['series'][definition['id']]['observations'] if p['value'] is not None]
        assert len(observations)>=3,definition['id']+' lacks three actual observations'
        samples=[observations[0],observations[len(observations)//2],observations[-1]]
        for point in samples:
            expected=verify_financial(definition,point) if data is financial else verify_cso(point)
            checks.append({'metricId':definition['id'],'periodEnd':point['periodEnd'],'value':point['value'],'independentlyRecomputed':expected,'unit':definition['unit'],'sourceUrl':point['sourceUrl'],'publishedAt':point['publishedAt'],'version':point['version'],'passed':True})
    report=institutions['researchReports'][0]
    text=raw_source(report['sourceUrl']).decode('utf-8')
    assert '485' in text and '950' in text
    assert [fact['nature'] for fact in report['facts']]==['estimate','forecast']
    assert report['modelRole']=='scenario_only'
    result={'scope':'9 actual series x 3 historical points; IEA two explicit scenario facts checked separately. Does not validate trading outcomes.','actualChecks':checks,'scenarioChecks':[{'report':report['id'],'facts':report['facts'],'passed':True}],'passed':True}
    target=ROOT/'docs'/'industry'/'institutional-source-verification.json'
    target.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Raw-source checks passed:',len(checks),'actual points; 2 IEA scenario facts')

if __name__=='__main__':run()
