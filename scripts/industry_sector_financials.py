"""Auditable company financials for under-covered AI-related supply-chain sectors.

SEC company facts are actual consolidated results, not pure-AI revenue. Quarterly
flows use reported 70--105 day intervals, or a validated cumulative difference.
TSMC's quarterly IR earnings release supplies TIFRS consolidated revenue and
gross margin; its SEC 20-F annual values are never relabeled as quarterly data.
"""
import argparse
import calendar
import hashlib
import io
import json
import math
import os
import re
import subprocess
import urllib.request
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urljoin

from pypdf import PdfReader

from industry_collect import html_tables
from industry_common import DATA, ROOT, CREATE_NO_WINDOW, WINDOWS_STARTUPINFO, atomic, definition, now, observation, persist
from industry_bootstrap import restore_bootstrap
from industry_releases import candidates

PARSER_VERSION = 'sector-financials-1.0.0'
SEC_COMPANIES = {
    'MU': {'cik': '0000723125', 'category': 'semiconductor', 'name': '美光'},
    'ETN': {'cik': '0001551182', 'category': 'power', 'name': '伊顿'},
    'VRT': {'cik': '0001674101', 'category': 'power', 'name': '维谛'},
}
SEC_REVENUE_TAGS = ('RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet')
SEC_COST_TAGS = ('CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold')
ALLOWED_FORMS = {'10-Q', '10-Q/A', '10-K', '10-K/A'}
HISTORY_START = '2023-01-01'


def filing_url(cik, accession):
    return f'https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace("-", "")}/{accession}-index.html'


def fetch_source(url, force=False):
    """Cache raw public documents; all curl fallbacks are hidden on Windows."""
    key = hashlib.sha256(url.encode()).hexdigest()
    folder = DATA / 'raw'
    folder.mkdir(exist_ok=True)
    metadata = folder / (key + '.meta.json')
    prior = json.loads(metadata.read_text(encoding='utf-8')) if metadata.exists() else {}
    if not force and prior and datetime.now(timezone.utc) - datetime.fromisoformat(prior['fetchedAt']) < timedelta(hours=24):
        return (folder / prior['file']).read_bytes(), prior['fetchedAt'], prior['hash']
    user_agent = os.environ.get('SEC_USER_AGENT') or 'AI Macro Chain Monitor (+https://github.com/Timo168/ai-macro-chain-monitor)'
    headers = {'User-Agent': user_agent, 'Accept-Encoding': 'identity'}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
            raw = response.read()
    except Exception as request_error:
        process = subprocess.run(
            ['curl.exe' if os.name == 'nt' else 'curl', '--fail', '--location', '--silent', '--show-error',
             '--max-time', '30', '--user-agent', user_agent, url],
            capture_output=True, creationflags=CREATE_NO_WINDOW, startupinfo=WINDOWS_STARTUPINFO,
        )
        if process.returncode:
            raise RuntimeError(f'官方来源请求失败（HTTP {getattr(request_error, "code", "不可用")}，备用请求退出 {process.returncode}）；保留最后成功数据，不生成替代值')
        raw = process.stdout
    if len(raw) < 100:
        raise ValueError('官方来源响应为空或过短')
    digest = hashlib.sha256(raw).hexdigest()
    suffix = '.pdf' if raw.startswith(b'%PDF') else '.json' if raw.lstrip().startswith(b'{') else '.html'
    filename = digest + suffix
    (folder / filename).write_bytes(raw)
    stamp = now()
    atomic(metadata, {'url': url, 'file': filename, 'hash': digest, 'fetchedAt': stamp})
    return raw, stamp, digest


def valid_fact(point, as_of):
    value = point.get('val')
    return (
        point.get('form') in ALLOWED_FORMS and point.get('start') and point.get('end')
        and point.get('filed') and point.get('accn') and point['start'] <= point['end'] <= as_of
        and point['filed'] <= as_of and not isinstance(value, bool)
        and isinstance(value, (int, float)) and math.isfinite(value)
    )


def tagged_facts(payload, tags, as_of):
    """Use a single semantic tag where available, rather than merge unlike tags."""
    gaap = payload.get('facts', {}).get('us-gaap', {})
    for tag in tags:
        rows = [dict(p, tag=tag) for p in gaap.get(tag, {}).get('units', {}).get('USD', []) if valid_fact(p, as_of)]
        if rows:
            return rows
    return []


def fact_priority(point):
    return point['filed'], point['accn'], point.get('frame', '')


def compact_fact(point):
    return {key: point[key] for key in ('tag', 'start', 'end', 'val', 'filed', 'accn', 'form', 'fy', 'fp') if key in point}


def quarterly_flows(facts, as_of=None):
    """Extract real fiscal quarters, including Q4 = annual minus nine-month YTD.

    Cumulative differences require identical fiscal starts, adjacent 70--105 day
    endpoints, and a base filing no later than the current filing. Never subtract
    a standalone quarterly value from a YTD/annual value or invent missing ends.
    """
    as_of = as_of or date.today().isoformat()
    available_facts = [fact for fact in facts if valid_fact(fact, as_of)]
    by_interval = {}
    for fact in available_facts:
        key = fact['start'], fact['end']
        if key not in by_interval or fact_priority(fact) > fact_priority(by_interval[key]):
            by_interval[key] = fact
    direct = {}
    for fact in by_interval.values():
        duration = (date.fromisoformat(fact['end']) - date.fromisoformat(fact['start'])).days + 1
        if 70 <= duration <= 105:
            row = {'start': fact['start'], 'end': fact['end'], 'value': fact['val'], 'inputs': [compact_fact(fact)], 'publishedAt': fact['filed'], 'accession': fact['accn'], 'basis': 'reported_quarter'}
            previous = direct.get(row['end'])
            if previous is None or (row['publishedAt'], row['accession']) > (previous['publishedAt'], previous['accession']):
                direct[row['end']] = row
    for current in sorted(by_interval.values(), key=lambda p: (p['end'], p['filed'])):
        duration = (date.fromisoformat(current['end']) - date.fromisoformat(current['start'])).days + 1
        if duration < 140 or duration > 380 or current['end'] in direct:
            continue
        # A newer comparative filing may contain the same nine-month interval.
        # Keep the earlier version that was already public at the annual filing,
        # rather than letting a later comparison remove a valid historical Q4.
        bases = [p for p in available_facts if p['start'] == current['start'] and p['end'] < current['end']
                 and p['filed'] <= current['filed'] and 70 <= (date.fromisoformat(current['end']) - date.fromisoformat(p['end'])).days <= 105]
        if not bases:
            continue
        base = max(bases, key=lambda p: (p['end'], fact_priority(p)))
        start = (date.fromisoformat(base['end']) + timedelta(days=1)).isoformat()
        direct[current['end']] = {
            'start': start, 'end': current['end'], 'value': current['val'] - base['val'],
            'inputs': [compact_fact(current), compact_fact(base)], 'publishedAt': current['filed'],
            'accession': current['accn'], 'basis': 'cumulative_difference',
        }
    return [row for end, row in sorted(direct.items()) if end >= HISTORY_START]


def parse_sec_companyfacts(raw, entity, as_of=None):
    as_of = as_of or date.today().isoformat()
    payload = json.loads(raw)
    if int(payload.get('cik', -1)) != int(SEC_COMPANIES[entity]['cik']):
        raise ValueError('SEC公司CIK不匹配')
    revenue = quarterly_flows(tagged_facts(payload, SEC_REVENUE_TAGS, as_of), as_of)
    if not revenue:
        raise ValueError('SEC未返回可校验的实际季度营业收入')
    profit = {row['end']: row for row in quarterly_flows(tagged_facts(payload, ('GrossProfit',), as_of), as_of)}
    cost = {row['end']: row for row in quarterly_flows(tagged_facts(payload, SEC_COST_TAGS, as_of), as_of)}
    margins = []
    for row in revenue:
        other = profit.get(row['end']) or cost.get(row['end'])
        if not other or other['start'] != row['start'] or row['value'] <= 0:
            continue
        # A gross margin combines only the same fiscal interval and same filing
        # lineage. Revised revenue must not be mixed with an older cost basis.
        if [p['accn'] for p in row['inputs']] != [p['accn'] for p in other['inputs']]:
            continue
        gross = other['value'] if row['end'] in profit else row['value'] - other['value']
        margin = gross / row['value'] * 100
        if not -100 <= margin <= 100:
            raise ValueError('GAAP毛利率超出可校验边界')
        margins.append({**row, 'value': margin, 'inputs': row['inputs'] + other['inputs'], 'grossProfitRaw': gross, 'revenueRaw': row['value'], 'basis': 'gross_profit_divided_by_revenue'})
    return {'company_revenue': revenue, 'gross_margin': margins}


def parse_tsm_release(raw, year, quarter):
    text = ' '.join(' '.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(raw)).pages).split())
    # Some published PDF text layers split the final digits of the year.
    text = re.sub(r'\b(20)\s*(\d)\s*(\d)\b', r'\1\2\3', text)
    publication = re.search(r'([A-Z][a-z]+ \d{1,2}, 20\d{2})\s*--\s*TSMC', text)
    period = re.search(r'(?:quarter|three months) ended ([A-Z][a-z]+ \d{1,2}, 20\d{2})', text, re.I)
    revenue = re.search(r'consolidated revenue of NT\$\s*([\d,]+(?:\.\s*\d+)?)\s+billion', text, re.I)
    margin = re.search(r'Gross margin for the quarter was (\d+(?:\s*\.\s*\d+)?)\s*%', text, re.I)
    if not all((publication, period, revenue, margin)):
        raise ValueError('TSMC季度实际业绩锚点、日期或币种缺失；不解析后文指引')
    end = datetime.strptime(period[1], '%B %d, %Y').date().isoformat()
    expected_end = date(year, quarter * 3, calendar.monthrange(year, quarter * 3)[1]).isoformat()
    if end != expected_end:
        raise ValueError('TSMC官方实际季度与请求季度不匹配')
    published = datetime.strptime(publication[1], '%B %d, %Y').date().isoformat()
    return {'periodEnd': end, 'periodStart': date(year, quarter * 3 - 2, 1).isoformat(), 'publishedAt': published,
            'revenueBillionTwd': float(revenue[1].replace(',', '').replace(' ', '')), 'grossMargin': float(margin[1].replace(' ', '')), 'fiscalPeriod': f'FY{year} Q{quarter}'}


def financial_definition(entity, family):
    category = SEC_COMPANIES.get(entity, {}).get('category', 'semiconductor')
    source = 'TSMC Investor Relations' if entity == 'TSM' else 'SEC EDGAR companyfacts / 公司原始申报'
    url = 'https://investor.tsmc.com/english/quarterly-results/' if entity == 'TSM' else f'https://data.sec.gov/api/xbrl/companyfacts/CIK{SEC_COMPANIES[entity]["cik"]}.json'
    margin = family == 'gross_margin'
    metric_id = entity + ('.company_gross_margin' if entity == 'ETN' and margin else '.' + family)
    currency = 'TWD' if entity == 'TSM' else 'USD'
    unit = '%' if margin else '亿新台币' if currency == 'TWD' else '亿美元'
    name = ('公司整体毛利率（TIFRS）' if entity == 'TSM' else '公司整体GAAP毛利率') if margin else '公司整体营业收入（非AI单项）'
    method = ('同一实际财季、同一申报版本的毛利额÷收入×100；如无毛利额则（收入−销售成本）÷收入×100。' if margin else '公司合并实际收入，保留原币种；美元源值÷1亿，TSMC十亿新台币×10。')
    if entity == 'TSM':
        method = '公司官方季度业绩稿披露的TIFRS整体毛利率。' if margin else method
    method += ' 全公司口径包含非AI业务，不是AI/HBM订单、出货量或纯AI收入。累计流量仅在财政期初一致且相邻季末可校验时作差，拒绝把年度数据当季度。'
    d = definition(metric_id, name, 'Consolidated gross margin' if margin else 'Consolidated company revenue (not AI-only)', category, family, entity, source, url, unit, 'calculated' if margin and entity != 'TSM' else 'reported', method)
    d.update({'currency': currency, 'sourceAdapter': 'sector-financials', 'sourceOwner': source, 'directness': 'company_total',
              'dataRole': 'company_financial_actual', 'scope': 'consolidated_company_not_ai_only', 'reportingScope': 'company_total',
              'researchTargets': ['memory'] if entity == 'MU' else ['foundry'] if entity == 'TSM' else ['power'], 'isComparableAcrossEntities': False,
              'normalUpdateDelayDays': 65, 'interpretation': '观察相关企业已实现需求与盈利；无法据此单独判断纯AI业务需求或个股合理估值。',
              'crossCheck': '结合分部收入、订单、产品结构、估值、资本开支和项目里程碑；不得以整体收入代替建设完成证据。'})
    return d


def sec_observations(entity, family, rows, stamp, raw_version):
    d = financial_definition(entity, family)
    result = []
    for row in rows:
        source = filing_url(SEC_COMPANIES[entity]['cik'], row['accession'])
        value = row['value'] if family == 'gross_margin' else row['value'] / 100000000
        inputs = {'source_api_url': d['sourceUrl'], 'source_cik': SEC_COMPANIES[entity]['cik'], 'parser_version': PARSER_VERSION,
                  'rawSourceFacts': json.dumps(row['inputs'], sort_keys=True, separators=(',', ':')), 'original_unit': 'USD', 'scope': 'consolidated_company_not_ai_only'}
        if family == 'gross_margin':
            inputs.update({'gross_profit_usd': row['grossProfitRaw'], 'revenue_usd': row['revenueRaw']})
        else:
            inputs['reported_or_derived_quarter_usd'] = row['value']
        formula = '(gross profit / revenue) * 100' if family == 'gross_margin' else 'actual fiscal quarter USD / 100000000'
        if any(len([p for p in row['inputs'] if p['tag'] == tag]) == 2 for tag in {p['tag'] for p in row['inputs']}):
            formula += '; fiscal cumulative current minus preceding YTD'
        p = observation(d['id'], row['end'], value, source, stamp, raw_version, row['start'], None, formula, inputs, row['publishedAt'])
        p.update({'originalValue': row['value'], 'originalUnit': '%' if family == 'gross_margin' else 'USD', 'originalCurrency': 'USD', 'filingDate': row['publishedAt'], 'basis': row['basis']})
        result.append(p)
    return result


def restore_failure(prior, error, checked_at):
    if prior and prior.get('observations'):
        return {**prior, 'status': 'cached', 'error': error, 'checkedAt': checked_at,
                'lastSuccessfulAt': prior.get('lastSuccessfulAt') or prior.get('fetchedAt'), 'note': '获取失败，展示最后成功观测；未生成新季度值。'}
    return {'observations': [], 'status': 'fetch_failed', 'checkedAt': checked_at, 'error': error}


def sec_release_matches(entity, release, row, as_of):
    """A filing's fy/fp also label comparative facts: validate the actual end."""
    primary=next((p for p in row['inputs'] if p.get('end')==row['end']),{})
    quarter_tag=re.fullmatch(r'Q([1-4])',str(primary.get('fp') or ''))
    actual_quarter=4 if primary.get('fp')=='FY' else int(quarter_tag[1]) if quarter_tag else None
    year,quarter=release.get('fiscalYear'),release.get('quarter')
    if not year or quarter not in (1,2,3,4) or year!=primary.get('fy') or quarter!=actual_quarter:return False
    month={1:11,2:2,3:5,4:8}[quarter] if entity=='MU' else quarter*3
    actual_year=year-1 if entity=='MU' and quarter==1 else year
    expected=date(actual_year,month,calendar.monthrange(actual_year,month)[1])
    if abs((date.fromisoformat(row['end'])-expected).days)>14:return False
    published=release.get('publishedAt')
    return bool(published and published[:10]<=row['publishedAt']<=as_of)


def build(force=False, source_fetch=fetch_source, prior=None, as_of=None):
    as_of = as_of or date.today().isoformat()
    path = DATA / 'sector-financials.json'
    old = prior if prior is not None else json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'series': {}}
    if prior is None and DATA == ROOT / 'data' / 'industry':
        old = restore_bootstrap('sector-financials.json', old)
    result = {'schemaVersion': '1', 'collectorVersion': PARSER_VERSION, 'generatedAt': now(), 'definitions': [], 'series': {}, 'projects': [], 'events': [], 'ingestedReleases': old.get('ingestedReleases', [])}
    for entity, company in SEC_COMPANIES.items():
        defs = [financial_definition(entity, family) for family in ('company_revenue', 'gross_margin')]
        result['definitions'].extend(defs)
        try:
            raw, stamp, version = source_fetch(defs[0]['sourceUrl'], force=force)
            values = parse_sec_companyfacts(raw, entity, as_of)
            # The SEC filing can lag the earnings announcement. Only the actual
            # latest quarter with matching fiscal tags and a filing published
            # after that announcement proves ingestion of that new report.
            latest_row = max(values['company_revenue'], key=lambda row: row['end'])
            for release in candidates(entity, path=DATA/'release-discovery.json'):
                if sec_release_matches(entity,release,latest_row,as_of):
                    result['ingestedReleases'].append({**release, 'periodEnd':latest_row['end'], 'parsedAt':stamp, 'filingUrl':filing_url(company['cik'],latest_row['accession'])})
            for d in defs:
                rows = sec_observations(entity, d['family'], values[d['family']], stamp, version)
                prior_series = old.get('series', {}).get(d['id'], {})
                if not rows and prior_series.get('observations'):
                    result['series'][d['id']] = restore_failure(prior_series, '官方数据未返回同申报版本可校验的季度指标，保留既有观测', now())
                    continue
                retained = {p['periodEnd']: p for p in prior_series.get('observations', []) if p['periodEnd'] <= as_of}
                retained.update({p['periodEnd']: p for p in rows})
                result['series'][d['id']] = {'observations': sorted(retained.values(), key=lambda p: p['periodEnd']), 'status': 'ready' if rows else 'no_observation', 'fetchedAt': stamp, 'lastSuccessfulAt': stamp,
                                           'checkedAt': now(), 'error': None, 'note': '公司实际合并财务数据；非纯AI业务。SEC申报日为来源发布时间。'}
        except Exception as error:
            for d in defs:
                result['series'][d['id']] = restore_failure(old.get('series', {}).get(d['id']), str(error), now())
    tsm_defs = [financial_definition('TSM', family) for family in ('company_revenue', 'gross_margin')]
    result['definitions'].extend(tsm_defs)
    points = {d['id']: {} for d in tsm_defs}
    errors = []
    latest_success_end = None
    release_path=DATA/'release-discovery.json'
    jobs={}
    if release_path.exists():
        # Known history plus actual links found on the official publication
        # index. No guessed next-quarter URL is used to infer publication.
        for p in old.get('series',{}).get('TSM.company_revenue',{}).get('observations',[]):
            m=re.fullmatch(r'FY(20\d{2}) Q([1-4])',p.get('fiscalPeriod') or '')
            if m:jobs[(int(m[1]),int(m[2]))]={'url':p['sourceUrl'],'release':None}
        for release in candidates('TSM',path=release_path):
            if release.get('publishedAt') and release['publishedAt'][:10]<=as_of:
                jobs[(release['fiscalYear'],release['quarter'])]={'url':release['url'],'release':release}
    else:
        # Backward-compatible historical import before discovery is configured.
        for year in range(2024, int(as_of[:4]) + 1):
            for quarter in range(1, 5):
                end=date(year,quarter*3,calendar.monthrange(year,quarter*3)[1])
                if (date.fromisoformat(as_of)-end).days>=21:
                    jobs[(year,quarter)]={'url':f'https://investor.tsmc.com/english/quarterly-results/{year}/q{quarter}','release':None}
    for (year,quarter),job in sorted(jobs.items()):
            end = date(year, quarter * 3, calendar.monthrange(year, quarter * 3)[1])
            index = job['url']
            try:
                raw, stamp, version = source_fetch(index, force=force)
                if raw.startswith(b'%PDF'):
                    release=index
                else:
                    soup, _ = html_tables(raw)
                    release = next((urljoin(index, a['href']) for a in soup.find_all('a', href=True) if a.get_text(' ', strip=True) == 'Earnings Release'), None)
                    if not release:raise ValueError('TSMC官方季度页未提供Earnings Release附件；保留历史')
                    if __import__('urllib.parse',fromlist=['urlparse']).urlparse(release).hostname not in ('investor.tsmc.com','pr.tsmc.com'):raise ValueError('TSMC附件不是允许的官方域名')
                    raw, stamp, version = source_fetch(release, force=force)
                row = parse_tsm_release(raw, year, quarter)
                if row['publishedAt'] > as_of:
                    continue
                for d in tsm_defs:
                    margin = d['family'] == 'gross_margin'
                    raw_value = row['grossMargin'] if margin else row['revenueBillionTwd']
                    p = observation(d['id'], row['periodEnd'], raw_value if margin else raw_value * 10, release, stamp, version,
                                    row['periodStart'], row['fiscalPeriod'], 'reported percent' if margin else 'reported billion TWD * 10 = 100 million TWD',
                                    {'reported_percent' if margin else 'reported_billion_twd': raw_value, 'parser_version': PARSER_VERSION, 'quarter_index_url': index, 'scope': 'consolidated_company_not_ai_only'}, row['publishedAt'])
                    p.update({'originalValue': raw_value, 'originalUnit': '%' if margin else 'TWD billion', 'originalCurrency': 'TWD', 'basis': 'official_actual_quarter'})
                    points[d['id']][row['periodEnd']] = p
                latest_success_end = row['periodEnd']
                if job['release']:
                    result['ingestedReleases'].append({**job['release'],'periodEnd':row['periodEnd'],'parsedAt':stamp})
            except Exception as error:
                errors.append(f'{year} Q{quarter}: {error}')
    for d in tsm_defs:
        prior_series = old.get('series', {}).get(d['id'], {})
        merged = {p['periodEnd']: p for p in prior_series.get('observations', [])}
        merged.update(points[d['id']])
        rows = sorted(merged.values(), key=lambda p: p['periodEnd'])
        if not points[d['id']]:
            result['series'][d['id']] = restore_failure(prior_series, '; '.join(errors) or '未发现可验证的TSMC季度报告候选，发布状态尚不能确认', now())
        else:
            result['series'][d['id']] = {'observations': rows, 'status': 'cached' if errors else 'ready', 'fetchedAt': rows[-1]['fetchedAt'], 'lastSuccessfulAt': rows[-1]['fetchedAt'],
                                       'checkedAt': now(), 'error': '; '.join(errors) or None, 'note': '实际TIFRS季度数据；新季度未发布时保持最后观测，不插值、不引用指引。', 'latestVerifiedPeriodEnd': latest_success_end}
    result['ingestedReleases']=list({(r['entity'],r['url'],r.get('publishedAt')):r for r in result['ingestedReleases']}.values())
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    output = build(args.force)
    persist(output, DATA / 'sector-financials.json')
    print('Sector financial metrics', len(output['series']), 'ready', sum(s['status'] == 'ready' for s in output['series'].values()), flush=True)
