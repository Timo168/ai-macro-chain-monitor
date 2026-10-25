"""Three observations per connected metric: provenance and independent arithmetic audit.
Report documents its scope: this does not certify completeness or source redistribution rights.
"""
import io,json,math,sys,re,hashlib
from datetime import datetime,timezone
from functools import lru_cache
from pathlib import Path
from bs4 import BeautifulSoup
from pypdf import PdfReader
from industry_common import DATA,ROOT,fetch
from industry_costs import parse_wb,parse_eia
SOURCE_FAILURES={}

@lru_cache(None)
def source(url):
    raw,digest=source_bytes(url)
    if raw.startswith(b'PK'):return raw,digest
    text=' '.join(p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages) if raw.startswith(b'%PDF') else BeautifulSoup(raw,'html.parser').get_text(' ',strip=True)
    return text.replace(',',''),digest

@lru_cache(None)
def source_bytes(url):
    if url in SOURCE_FAILURES:raise RuntimeError(SOURCE_FAILURES[url])
    meta=DATA/'raw'/(hashlib.sha256(url.encode()).hexdigest()+'.meta.json')
    if meta.exists():
        item=json.loads(meta.read_text(encoding='utf-8'));raw=(DATA/'raw'/item['file']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==item['hash']
        return raw,item['hash']
    try:
        if url.startswith('https://data.sec.gov/'):
            from industry_sector_financials import fetch_source
            raw,_,digest=fetch_source(url)
        else:raw,_,digest=fetch(url)
    except Exception as exc:
        SOURCE_FAILURES[url]=str(exc);raise
    return raw,digest

def versioned_bytes(url,expected_hash=None):
    if expected_hash and re.fullmatch(r'[0-9a-f]{64}',expected_hash):
        archived=next((DATA/'raw').glob(expected_hash+'.*'),None)
        if archived:
            raw=archived.read_bytes()
            assert hashlib.sha256(raw).hexdigest()==expected_hash,'Archived observation source checksum changed'
            return raw
    return source_bytes(url)[0]

@lru_cache(None)
def fujimi_report(url,fy,quarter,published):
    from industry_cross_company import parse_report
    return parse_report(source_bytes(url)[0],{'fiscalYear':fy,'quarter':quarter,'publishedAt':published,'url':url})

@lru_cache(None)
def ase_report(url):
    from industry_cross_company import parse_ase_report
    return parse_ase_report(source_bytes(url)[0],url)

@lru_cache(None)
def ercot_months(url,year):
    from industry_power_load import parse_archive
    rows,_=parse_archive(source_bytes(url)[0],year)
    return {row['periodEnd']:row for row in rows}

@lru_cache(None)
def world_bank_prices(url):return parse_wb(source_bytes(url)[0])

@lru_cache(None)
def electricity_prices(url):
    result={}
    for key,points in parse_eia(source_bytes(url)[0]).items():
        result[key]={point[0]:point[1] for point in points}
        assert len(result[key])==len(points),'Duplicate electricity observation periods'
    return result

def check(d,p,data):
    items=p.get('originalItems',{});f=d['family'];value=p['value'];id=d['id']
    if d.get('sourceAdapter')=='public-reviewed':
        ledger=json.loads((DATA/'public-source-facts.json').read_text(encoding='utf-8'))
        fact=next(x for x in ledger['facts'] if x['metricId']==id and x['periodEnd']==p['periodEnd'])
        assert fact['sourceUrl']==p['sourceUrl'] and fact['originalItems']==items
        assert fact.get('publishedAt')==p.get('publishedAt') and fact.get('fiscalPeriod')==p.get('fiscalPeriod')
        if id=='POWER.interconnection':expected=(items['generation_gw']+items['storage_gw'])*1000
        elif id=='GOOG.backlog':expected=items['reported_billion_usd']*10
        elif id=='ETN.gross_margin':expected=(items['net_sales_million']-items['cost_products_million'])/items['net_sales_million']*100
        elif id=='MU.inventory_days':expected=(items['begin_inventory_million']+items['end_inventory_million'])/2/items['quarter_cost_million']*items['quarter_days']
        else:raise AssertionError('Missing independent reviewed formula for '+id)
        assert math.isclose(value,expected)
        return 'matched separate manual official-source fact ledger and independently recomputed units/formula; source document retrieval is not automated'
    if id=='DELL.servers_networking_revenue' or d.get('sourceAdapter')=='supply-evidence':
        from audit_supply_evidence import source_value
        expected,rule=source_value(id,p,source_bytes(p['sourceUrl'])[0])
        assert math.isclose(value,expected,rel_tol=1e-8,abs_tol=1e-8),(id,p['periodEnd'],value,expected)
        return 'independent dated source-table replay: '+rule
    if d.get('sourceAdapter') in ('packaging-operating','materials-evidence'):
        from audit_operating_samples import amkor,entg,source_bytes as operating_source
        loader=lambda url:versioned_bytes(url,p.get('sourceDocumentVersion') if url==p['sourceUrl'] else items.get('baseVersion') if url==items.get('baseUrl') else None)
        soup,_=operating_source(p['sourceUrl'],p.get('sourceDocumentVersion'),loader)
        expected,rule,_=amkor(id,p,soup,loader) if id.startswith('AMKR.') else entg(id,p,soup)
        assert math.isclose(value,expected,rel_tol=1e-8,abs_tol=1e-8),(id,p['periodEnd'],value,expected)
        return 'independent operating-source replay: '+rule
    if d.get('sourceAdapter') in ('sector-financials','institutions'):
        from audit_research_sources import verify_financial,verify_cso
        loader=lambda url:source_bytes(url)[0]
        expected=verify_financial(d,p,loader) if d['sourceAdapter']=='sector-financials' else verify_cso(p,loader)
        assert math.isclose(value,expected,rel_tol=1e-8,abs_tol=1e-8)
        return 'independent dated official facts and units replay; quarterly SEC inputs verified against filed facts'
    if d.get('sourceAdapter')=='cross-company':
        if id.startswith('ASE.'):
            report=ase_report(p['sourceUrl'])
            assert report['periodEnd']==p['periodEnd']
            expected=report['values'][f] if f=='atm_margin' else report['values'][f]/100
        else:
            fy,quarter=map(int,re.fullmatch(r'FY(\d{4}) Q([1-4])',p['fiscalPeriod']).groups())
            report=fujimi_report(p['sourceUrl'],fy,quarter,p['publishedAt'])
            assert report['periodEnd']==p['periodEnd'] and report['values']==items['currentCumulative']
            previous={k:0 for k in report['values']}
            if quarter>1:
                base=fujimi_report(items['previousSourceUrl'],fy,quarter-1,items['previousPublishedAt'])
                assert base['values']==items['previousCumulative'];previous=base['values']
            quarterly={k:v-previous[k] for k,v in report['values'].items()}
            expected=100*quarterly['operating_income']/quarterly['company_revenue'] if f=='operating_margin' else quarterly[f]/100
        assert math.isclose(value,expected,rel_tol=1e-8,abs_tol=1e-8),(id,p['periodEnd'],value,expected)
        return 'dated company source parser replay and independently recomputed fiscal cumulative differences / currency units'
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
    if id in ('HPE.server_revenue','HPE.gross_margin'):
        from industry_extended import parse_hpe_release
        row=next(row for row in parse_hpe_release(source_bytes(p['sourceUrl'])[0]) if row['periodEnd']==p['periodEnd'])
        expected=row[f]/100 if f=='server_revenue' else row[f]
        assert math.isclose(value,expected) and p['fiscalPeriod']==row['fiscalPeriod']
        return 'matched dated official HPE FY2026 restated segment/GAAP columns and original million-dollar conversion'
    if id in ('AMD.datacenter_revenue','AMD.revenue','AMD.datacenter_profit','AMD.gross_margin'):
        from industry_hardware import parse_amd_release
        row=next(row for row in parse_amd_release(source_bytes(p['sourceUrl'])[0]) if row['periodEnd']==p['periodEnd'])
        expected=row[f] if f=='gross_margin' else row[f]/100
        assert math.isclose(value,expected) and p['fiscalPeriod']==row['fiscalPeriod']
        return 'matched dated official AMD segment/GAAP columns and original million-dollar conversion'
    if d.get('sourceAdapter')=='infrastructure':
        from industry_infrastructure import SERIES,parse_fred_monthly
        spec=next(item for item in SERIES if item['id']==id)
        rows=parse_fred_monthly(source_bytes(p['sourceUrl'])[0])
        expected=next(row for row in rows if row['periodEnd']==p['periodEnd'])
        assert value==expected['value'] and items['source_observation_date']==expected['sourceDate']
        assert items['seasonal_adjustment']==spec['seasonal_adjustment']
        assert d['aggregation']==spec['aggregation'] and d['valueType']=='proxy'
        return 'matched dated Census/FRED CSV and verified SA/SAAR and monthly aggregation metadata'
    if id=='PROJECT.operational_milestone_count':
        from industry_projects import SOURCES,parse_source,operational_milestone_observations
        specs=[spec for spec in SOURCES if spec.get('milestoneGroup')=='operational']
        projects=[]
        for spec in specs:
            raw,digest=source_bytes(spec['url'])
            projects.extend(parse_source(spec,raw,p['fetchedAt'],digest))
        rows=operational_milestone_observations(projects,{spec['url'] for spec in specs},p['fetchedAt'])
        expected=next(row for row in rows if row['periodEnd']==p['periodEnd'])
        assert value==expected['value'] and items['sampleProjectIds']==expected['originalItems']['sampleProjectIds']
        assert items['newProjectIds']==expected['originalItems']['newProjectIds']
        assert not d['recommendationEligible'] and d['scoringTier']=='leading_only'
        return 'replayed official operator status pages and deduplicated project milestones; no MW inferred'
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
    if id=='VRT.backlog':
        assert p['isEstimated'] and items['source_measure']=='estimated combined order backlog'
        assert re.search(r'\$\s*'+re.escape(format(items['reported_billion_usd'],'.12g'))+r'\s*B',raw,re.I),(id,p['periodEnd'],'reported backlog not found')
        expected=items['reported_billion_usd']*items['conversion_factor_to_100m_usd']
        assert math.isclose(value,expected) and items['source_precision_billion_usd']==0.1
        return 'matched official presentation backlog, verified reported precision and billion-to-100-million conversion'
    if id=='POWER.load':
        fact=ercot_months(p['sourceUrl'],items['source_year'])[p['periodEnd']]
        assert fact['periodStart']==p['periodStart'] and fact['items']==items and math.isclose(fact['value'],value)
        return 'replayed official ERCOT hourly workbook, complete-month checks and monthly peak selection'
    if id.startswith('WB.'):
        expected=dict(world_bank_prices(p['sourceUrl'])[f])[p['periodEnd']];assert math.isclose(value,expected)
        return 'matched dated cell in archived official monthly workbook'
    if id.startswith('EIA.'):
        expected=electricity_prices(p['sourceUrl'])[id[4:]][p['periodEnd']];assert math.isclose(value,expected)
        if id.startswith('EIA.US.') and f!='electricity_sales':assert math.isclose(value,items['revenue_thousand_usd']/items['sales_mwh']*100)
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
    data=json.loads((DATA/'latest.json').read_text(encoding='utf-8'));samples=[];failures=[];unavailable=[]
    prior_path=DATA/'audit-samples.json'
    if not prior_path.exists():prior_path=ROOT/'docs/industry/verification.json'
    prior=json.loads(prior_path.read_text(encoding='utf-8')) if prior_path.exists() else {'samples':[]}
    prior_samples={(s['metricId'],s['periodEnd'],s['version']):s for s in prior.get('samples',[]) if s.get('checkMode') in ('automatic_source_replay','previous_verified_source_replay')}
    for d in data['definitions']:
        print('Checking',d['id'],file=sys.stderr,flush=True)
        points=[p for p in data['series'][d['id']]['observations'] if p['value'] is not None]
        if not points:
            unavailable.append({'metricId':d['id'],'status':data['series'][d['id']].get('status','not_configured')});continue
        if len(points)<3 or len({p['periodEnd'] for p in points})!=len(points):
            failures.append({'metricId':d['id'],'error':'Fewer than three historical points or duplicate observation periods'});continue
        for p in [points[0],points[len(points)//2],points[-1]]:
            mode='manual_fact_ledger' if d.get('sourceAdapter')=='public-reviewed' else 'automatic_source_replay'
            old=prior_samples.get((d['id'],p['periodEnd'],p['version']))
            series=data['series'][d['id']]
            if old is not None and math.isclose(old['value'],p['value']) and series.get('status')=='cached' and series.get('error'):
                mode='previous_verified_source_replay';method='collector reports a current source failure; identical observation version passed the prior archived-source replay'
                print('Reused prior source audit for cached',d['id'],p['periodEnd'],file=sys.stderr)
            else:
                try:method=check(d,p,data)
                except Exception as error:
                    if isinstance(error,RuntimeError) and '来源请求失败' in str(error) and old is not None and math.isclose(old['value'],p['value']):
                        mode='previous_verified_source_replay';method='current source retrieval unavailable; identical observation version passed the prior archived-source replay'
                        print('Reused prior source audit for',d['id'],p['periodEnd'],file=sys.stderr)
                    else:
                        failures.append({'metricId':d['id'],'periodEnd':p['periodEnd'],'sourceUrl':p['sourceUrl'],'version':p['version'],'error':f'{type(error).__name__}: {error}'[:600]})
                        print('FAILED',d['id'],p['periodEnd'],type(error).__name__,str(error)[:300],file=sys.stderr);continue
            samples.append({'metricId':d['id'],'periodEnd':p['periodEnd'],'value':p['value'],'unit':d['unit'],'currency':d.get('currency'),'sourceUrl':p['sourceUrl'],'version':p['version'],'checkMode':mode,'check':method})
    folder=ROOT/'docs/industry';folder.mkdir(parents=True,exist_ok=True)
    if not samples and not failures:failures.append({'metricId':None,'error':'No connected observations were available for audit'})
    manual=sum(s['checkMode']=='manual_fact_ledger' for s in samples)
    previous=sum(s['checkMode']=='previous_verified_source_replay' for s in samples);automatic=len(samples)-manual
    current=automatic-previous
    checked_at=datetime.now(timezone.utc).isoformat()
    (folder/'verification.json').write_text(json.dumps({'checkedAt':checked_at,'passed':not failures,'scope':'3 periods per connected metric; current or previously recorded archived-source replay where supported, plus a separately tracked manual fact ledger for blocked sources; identical metric, period, value and version are required to reuse a prior replay; arithmetic only, not a license or causal audit','automaticSamples':automatic,'currentSourceReplaySamples':current,'previousSourceReplaySamples':previous,'manualFactLedgerSamples':manual,'failedSamples':len(failures),'failures':failures,'unavailableMetrics':unavailable,'samples':samples},ensure_ascii=False,indent=2),encoding='utf-8')
    # Durable successful replays survive both a fresh CI checkout and a later
    # failed audit. Value participates in identity so a prior result is never
    # silently replaced if the same observation version arrives with new facts.
    archived={(s['metricId'],s['periodEnd'],s['version'],s['value']):s for s in [*prior.get('samples',[]),*samples]}
    from industry_common import atomic
    atomic(DATA/'audit-samples.json',{'schemaVersion':1,'lastAuditAt':checked_at,'samples':list(archived.values())})
    print('Verified transformations for',len(samples),'historical samples across',len(samples)//3,'metrics;',current,'current source replays,',previous,'prior identical-version replays,',manual,'manual fact-ledger samples')
    if failures:print('Failed source replays:',len(failures),file=sys.stderr)
    return not failures
if __name__=='__main__':sys.exit(0 if run() else 1)
