"""Official company cross-checks; original currencies and business scopes stay separate.

Fujimi's current-quarter flows are differences of verified fiscal-year cumulative
statements. These observations are cross-check evidence, not automatic new scores.
No browser, external model, shell or child process is used by this collector.
"""
import calendar
import hashlib
import io
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from pypdf import PdfReader

from industry_common import DATA, atomic, definition, now, observation, persist
from industry_bootstrap import restore_bootstrap

VERSION = 'cross-company-1.0.0'
INDEX = 'https://www.fujimiinc.co.jp/english/ir/news/'
ASE_INDEX = 'https://www.prnewswire.com/news/ase-technology-holding-co.%2C-ltd./'
FAMILIES = ('cmp_revenue', 'company_revenue', 'operating_income', 'operating_margin')
ASE_FAMILIES = ('atm_revenue', 'company_revenue', 'atm_margin')
SCOPE = ('Fujimi CMP包括逻辑与存储器研磨材料，不是纯AI收入；公司收入和营业利润还含硅片、硬盘、一般工业等。'
         '以日元原币观察同比方向，不与美元金额相加；营业利润率不等于Entegris毛利率。')


def allowed(url):
    p = urlparse(url)
    try:
        return p.scheme == 'https' and not p.username and not p.password and p.port in (None, 443) and (
            p.hostname == 'www.fujimiinc.co.jp' and p.path.startswith('/english/ir/')
            or p.hostname == 'www.ircms.jp' and p.path.startswith('/irexport/fujimiinc/')
            or p.hostname == 'www.prnewswire.com' and (
                p.path == '/news/ase-technology-holding-co.%2C-ltd./'
                or re.fullmatch(r'/news-releases/ase-technology-holding-co-ltd-reports-its-unaudited-consolidated-financial-results-for-the-(?:first|second|third|fourth)-quarter(?:-and-the-full-year)?-of-20\d{2}-\d+\.html', p.path)
            )
        )
    except ValueError:
        return False


def fetch_source(url, force=False):
    if not allowed(url):
        raise ValueError('来源不属于已核验官方入口或发行人附件命名空间')
    folder = DATA / 'raw'
    folder.mkdir(exist_ok=True)
    meta = folder / (hashlib.sha256(url.encode()).hexdigest() + '.meta.json')
    previous = json.loads(meta.read_text(encoding='utf-8')) if meta.exists() else {}
    if previous and not force and (datetime.now(timezone.utc) - datetime.fromisoformat(previous['fetchedAt'])).total_seconds() < 86400:
        filename = previous['file']
        if Path(filename).name != filename:
            raise ValueError('缓存文件路径异常')
        raw = (folder / filename).read_bytes()
        if hashlib.sha256(raw).hexdigest() != previous['hash']:
            raise ValueError('来源缓存字节校验失败')
        return raw, previous['fetchedAt'], previous['hash']
    with requests.Session() as session:
        response = session.get(url, timeout=25, headers={'User-Agent': os.environ.get('SEC_USER_AGENT') or 'AI Macro Chain Monitor public financial research'})
        response.raise_for_status()
        if not allowed(response.url):
            raise ValueError('来源重定向至未允许域名')
        raw = response.content
    if len(raw) < 100 or re.search(rb'Access Denied|Just a moment', raw[:800], re.I):
        raise ValueError('来源为空或受到访问限制')
    digest = hashlib.sha256(raw).hexdigest()
    filename = digest + ('.pdf' if raw.startswith(b'%PDF') else '.html')
    (folder / filename).write_bytes(raw)
    stamp = now()
    atomic(meta, {'url': url, 'file': filename, 'hash': digest, 'fetchedAt': stamp})
    return raw, stamp, digest


def discover_indexes(raw):
    soup = BeautifulSoup(raw, 'html.parser')
    urls = [s['src'] for s in soup.select('script[src]') if re.fullmatch(
        r'https://www\.ircms\.jp/irexport/fujimiinc/list/en_ir_news_20\d{2}\.js', s['src'])]
    urls = [u for u in urls if int(re.search(r'(20\d{2})\.js$', u)[1]) >= 2023]
    if not urls:
        raise ValueError('官方新闻页未提供受支持的公开业绩列表')
    return list(dict.fromkeys(urls))


def discover_releases(raw, as_of=None):
    """Parse static document.write fragments as HTML; never execute source JS."""
    text = raw.decode('utf-8') if isinstance(raw, bytes) else raw
    fragments = re.findall(r"document\.write\('([^\n]*?)'\)", text)
    soup = BeautifulSoup(''.join(fragments), 'html.parser')
    results = []
    for a in soup.select('a[href]'):
        title = a.get_text(' ', strip=True)
        m = re.fullmatch(r'FY(20\d\d) (?:(1st|2nd|3rd) Quarter )?Financial Results', title)
        stamp = a.find_previous('dt')
        if not m or not stamp or not allowed(a['href']):
            continue
        published = stamp.get_text(' ', strip=True).replace('.', '-')
        date.fromisoformat(published)
        if published > (as_of or date.today().isoformat()) or int(m[1]) < 2024:
            continue
        results.append({'entity': 'FUJIMI', 'fiscalYear': int(m[1]), 'quarter': int(m[2][0]) if m[2] else 4,
                        'publishedAt': published, 'url': a['href'], 'title': title, 'kind': 'release'})
    return results


def period(fiscal_year, quarter):
    year = fiscal_year if quarter == 4 else fiscal_year - 1
    month = (6, 9, 12, 3)[quarter - 1]
    start = f'{year}-{month - 2:02d}-01'
    end = f'{year}-{month:02d}-{calendar.monthrange(year, month)[1]:02d}'
    return start, end


def number(text):
    value = text.strip().replace(',', '').replace(' ', '')
    if value in ('-', '—', '–', ''):
        raise ValueError('财报当前列缺失，不得跳过缺值读取上年数字')
    if value.startswith(('△', '(')):
        return -float(value.strip('△()'))
    return float(value)


def parse_report(raw, job):
    if not raw.startswith(b'%PDF'):
        raise ValueError('财报不是PDF')
    pages = [p.extract_text() or '' for p in PdfReader(io.BytesIO(raw)).pages]
    text = '\n'.join(pages)
    compact = ' '.join(text.split())
    fy, q = job['fiscalYear'], job['quarter']
    fiscal_label = f'FY{fy} ' + ('First Quarter' if q == 1 else 'Second Quarter' if q == 2 else 'Third Quarter' if q == 3 else '')
    if not re.search(r'FUJIMI\s+INCORPORA\s*TED', compact) or fiscal_label.strip() not in compact:
        raise ValueError('发行人或财季与官方索引不一致')
    start, end = period(fy, q)
    if end >= job['publishedAt']:
        raise ValueError('财报发布日必须晚于观测期末；不能使用期末作发布时间')
    expected_date = datetime.fromisoformat(end).strftime('%B %d, %Y').replace(' 0', ' ')
    statement = None
    token = r'(?:[△(]?\d[\d,]*(?:\.\d+)?\)?|[—–-])'
    for page in pages:
        normalized = re.sub(r'(?<=\d)\s+(?=\d\b)', '', page)
        # Both columns must be present on the actual consolidated statement.
        # Keep line boundaries: a missing cell may not consume another row.
        sales = re.search(r'^\s*Net sales\s+(' + token + r')\s+(' + token + r')\s*$', page, re.M | re.I)
        profit = re.search(r'^\s*Operating profit\s+(' + token + r')\s+(' + token + r')\s*$', page, re.M | re.I)
        if sales and profit and 'Consolidated Statements of Income' in page:
            if 'Millions of yen' not in page or expected_date not in ' '.join(normalized.split()):
                raise ValueError('实际损益表单位或本期表头未通过核验')
            statement = {'company_revenue': number(sales[2]), 'operating_income': number(profit[2])}
    if statement is None:
        raise ValueError('未找到已核验的当期合并损益表两列')
    application = re.search(r'Regarding products for the CMP process of semiconductor devices,(.*?)(?:\(iii\)|Hard Disks)', compact, re.I)
    cmp = re.search(r'net sales.{0,330}?\bto JPY\s*([\d,]+)\s*million', application[1], re.I) if application else None
    if not cmp:
        raise ValueError('未找到CMP实际累计收入')
    statement['cmp_revenue'] = number(cmp[1])
    if not 0 < statement['cmp_revenue'] <= statement['company_revenue']:
        raise ValueError('CMP分项必须处于已核验总收入范围内')
    return {**job, 'periodStart': start, 'periodEnd': end, 'values': statement}


def definitions():
    result = []
    for family, label in [('cmp_revenue', 'Fujimi CMP研磨材料收入'), ('company_revenue', 'Fujimi公司总收入'),
                          ('operating_income', 'Fujimi公司营业利润'), ('operating_margin', 'Fujimi公司营业利润率')]:
        d = definition('FUJIMI.' + family, label, label, 'semiconductor', family, 'FUJIMI', 'Fujimi official financial results', INDEX,
                       '%' if family == 'operating_margin' else '亿日元', 'calculated',
                       '官方日元财年累计实际数；首季直接使用、后续季用本期累计减同财年前一季累计，百万日元÷100为亿日元。单季营业利润率=单季营业利润÷单季总收入×100。' + SCOPE, eligible=False)
        d.update(currency='JPY', sourceAdapter='cross-company', reportingScope='cmp_materials' if family == 'cmp_revenue' else 'company_total',
                 researchTargets=['semiconductor_materials'], scope='fujimi_cmp_and_consolidated_not_ai_only', directness='company_disclosure',
                 dataRole='cross_company_actual', isComparableAcrossEntities=False, crossEvidenceOnly=True,
                 interpretation='用第二家公司的实际收入与利润交叉观察半导体材料经营方向。', crossCheck=SCOPE,
                 normalUpdateDelayDays=65)
        result.append(d)
    return result


def ase_definitions():
    scope = ('ASE Technology Holding 自行发布、经 PR Newswire 分发的季度业绩；ATM 为封装、测试和材料业务，'
             '不同于公司含 EMS 的合并收入。新台币原币观察自身同比，不能视为纯 AI 订单或与 Amkor 美元金额相加。')
    result = []
    for family, label, method in [
        ('atm_revenue', 'ASE 封装测试与材料收入', '季度公告 ATM Results Highlights 中当季 Net revenues，百万新台币÷100。'),
        ('company_revenue', 'ASE 公司合并收入', '季度公告导语中当季合并 Net revenues，百万新台币÷100。'),
        ('atm_margin', 'ASE 封装测试与材料营业利润率', '季度公告 ATM Results Highlights 中当季 Operating margin，百分点原值。'),
    ]:
        d = definition('ASE.' + family, label, label, 'semiconductor', family, 'ASE',
                       'ASE Technology Holding company release via PR Newswire', ASE_INDEX,
                       '%' if family == 'atm_margin' else '亿新台币', 'reported', method + scope,
                       eligible=False)
        d.update(currency='TWD', sourceAdapter='cross-company',
                 reportingScope='ase_atm' if family != 'company_revenue' else 'company_total',
                 researchTargets=['packaging'], scope='ase_atm_includes_non_ai_and_materials',
                 directness='company_disclosure', dataRole='cross_company_actual',
                 isComparableAcrossEntities=False, crossEvidenceOnly=True,
                 interpretation='以第二家公司的封装测试业务经营方向交叉观察。', crossCheck=scope,
                 normalUpdateDelayDays=65)
        result.append(d)
    return result


def ase_indexes():
    return [ASE_INDEX, ASE_INDEX + '?page=2&pagesize=25', ASE_INDEX + '?page=3&pagesize=25']


def discover_ase_releases(raw, as_of=None):
    soup = BeautifulSoup(raw, 'html.parser')
    results = []
    for link in soup.select('a[href]'):
        title = link.get_text(' ', strip=True)
        if not re.search(r'ASE Technology Holding Co\., Ltd\. Reports Its Unaudited Consolidated Financial Results for the (?:First|Second|Third|Fourth) Quarter', title, re.I):
            continue
        year = re.search(r'of (20\d{2})\b', title)
        if not year or int(year[1]) < 2024:
            continue
        url = 'https://www.prnewswire.com' + link['href'] if link['href'].startswith('/') else link['href']
        if allowed(url) and url not in results:
            results.append(url)
    return results


def parse_ase_report(raw, url, as_of=None):
    soup = BeautifulSoup(raw, 'html.parser')
    heading = soup.find('h1')
    title = heading.get_text(' ', strip=True) if heading else ''
    match = re.fullmatch(r'ASE Technology Holding Co\., Ltd\. Reports Its Unaudited Consolidated Financial Results for the (First|Second|Third|Fourth) Quarter(?: and the Full Year)? of (20\d{2})', title, re.I)
    if not match:
        raise ValueError('ASE 公司、公告标题或实际季度无法核验')
    quarter = {'first': 1, 'second': 2, 'third': 3, 'fourth': 4}[match[1].lower()]
    year = int(match[2])
    published_tag = soup.find('meta', attrs={'name': 'date'})
    published = published_tag.get('content') if published_tag else None
    if not published:
        raise ValueError('ASE 公告发布时间缺失')
    published_day = datetime.fromisoformat(published).date().isoformat()
    if as_of and published_day > as_of:
        raise ValueError('ASE 公告尚未发布')
    end = f'{year}-{quarter * 3:02d}-{calendar.monthrange(year, quarter * 3)[1]:02d}'
    if published_day <= end:
        raise ValueError('ASE 公告时间早于报告期末')
    text = ' '.join(soup.get_text(' ', strip=True).split())
    # Some issuer releases render a space before a thousands separator.
    text = re.sub(r'(?<=\d)\s*,\s*(?=\d)', ',', text)
    if 'SOURCE ASE Technology Holding Co., Ltd.' not in text:
        raise ValueError('ASE 公告发布主体未通过核验')
    fiscal = f'{quarter}Q{str(year)[2:]}'
    total = re.search(r'reported its unaudited.{0,45}?net revenues.{0,35}?of NT\s*\$\s*([\d,]+)\s*million for ' + fiscal + r'\b', text, re.I)
    atm_start = re.search(re.escape(fiscal) + r' Results Highlights\s*[–—-]\s*ATM\b', text, re.I)
    if not total or not atm_start:
        raise ValueError('ASE 当季合并收入或 ATM 分项未找到')
    next_section = re.search(re.escape(fiscal) + r' Results Highlights\s*[–—-]\s*EMS\b', text[atm_start.end():], re.I)
    if not next_section:
        raise ValueError('ASE ATM 与 EMS 分段边界缺失')
    atm_text = text[atm_start.end():atm_start.end() + next_section.start()]
    atm_revenue = re.search(r'Net revenues were\s*NT\s*\$\s*([\d,]+)\s*million', atm_text, re.I)
    atm_margin = re.search(r'Operating margin was\s*([\d.]+)\s*%', atm_text, re.I)
    if not atm_revenue or not atm_margin:
        raise ValueError('ASE ATM 当季收入或营业利润率缺失')
    values = {'company_revenue': float(total[1].replace(',', '')),
              'atm_revenue': float(atm_revenue[1].replace(',', '')),
              'atm_margin': float(atm_margin[1])}
    if not 0 < values['atm_revenue'] <= values['company_revenue'] * 1.1 or not 0 < values['atm_margin'] < 100:
        raise ValueError('ASE 当季数值超出已核验业务范围')
    return {'entity': 'ASE', 'fiscalYear': year, 'quarter': quarter,
            'periodStart': f'{year}-{quarter * 3 - 2:02d}-01', 'periodEnd': end,
            'publishedAt': published, 'url': url, 'values': values}


def ase_points(reports):
    result = {family: {} for family in ASE_FAMILIES}
    for report in reports:
        for family in ASE_FAMILIES:
            value = report['values'][family]
            items = {'parserVersion': VERSION, 'reportedUnit': '%' if family == 'atm_margin' else 'NTD million',
                     'reportedValue': value, 'sourceScope': 'ATM including packaging, testing and materials' if family != 'company_revenue' else 'ASE consolidated including EMS',
                     'sourceHash': report['version']}
            p = observation('ASE.' + family, report['periodEnd'], value if family == 'atm_margin' else value / 100,
                            report['url'], report['fetchedAt'], report['version'], report['periodStart'],
                            f"FY{report['fiscalYear']} Q{report['quarter']}",
                            'reported percentage point' if family == 'atm_margin' else 'reported NTD million / 100',
                            items, report['publishedAt'])
            p.update(originalValue=value, originalUnit='%' if family == 'atm_margin' else 'NTD million',
                     originalCurrency='TWD', reportingScope='ase_atm' if family != 'company_revenue' else 'company_total')
            result[family][p['periodEnd']] = p
    return result


def quarterly_points(reports):
    lookup = {(r['fiscalYear'], r['quarter']): r for r in reports}
    result = {family: {} for family in FAMILIES}
    missing = []
    for key, report in sorted(lookup.items()):
        previous = lookup.get((key[0], key[1] - 1)) if key[1] > 1 else None
        if key[1] > 1 and previous is None:
            missing.append({'periodEnd': report['periodEnd'], 'reason': '缺少同财年前一季度累计基期，不能计算单季'})
            continue
        values = {k: v - (previous['values'][k] if previous else 0) for k, v in report['values'].items()}
        if values['company_revenue'] <= 0 or values['cmp_revenue'] < 0 or values['cmp_revenue'] > values['company_revenue']:
            missing.append({'periodEnd': report['periodEnd'], 'reason': '累计差分结果未通过收入范围核验'})
            continue
        values['operating_margin'] = values['operating_income'] / values['company_revenue'] * 100
        for family, value in values.items():
            items = {'parserVersion': VERSION, 'reportedUnit': 'JPY million', 'sourceBasis': 'Japanese GAAP actual fiscal-year cumulative',
                     'currentCumulative': report['values'], 'currentSourceHash': report['version'],
                     'previousCumulative': previous['values'] if previous else None,
                     'previousSourceUrl': previous['url'] if previous else None,
                     'previousSourceHash': previous['version'] if previous else None,
                     'previousPublishedAt': previous['publishedAt'] if previous else None,
                     'sourceScope': SCOPE}
            formula = '100 * quarterly operating profit / quarterly net sales' if family == 'operating_margin' else '(current fiscal YTD - prior same-fiscal-year YTD) / 100' if previous else 'reported first-quarter JPY million / 100'
            digest = hashlib.sha256((report['version'] + (previous['version'] if previous else '')).encode()).hexdigest()
            p = observation('FUJIMI.' + family, report['periodEnd'], value if family == 'operating_margin' else value / 100,
                            report['url'], report['fetchedAt'], digest, report['periodStart'], f'FY{key[0]} Q{key[1]}', formula, items,
                            max(report['publishedAt'], previous['publishedAt'] if previous else report['publishedAt']))
            p.update(originalValue=value, originalUnit='%' if family == 'operating_margin' else 'JPY million', originalCurrency='JPY',
                     reportingScope='cmp_materials' if family == 'cmp_revenue' else 'company_total')
            result[family][p['periodEnd']] = p
    return result, missing


def merge_series(previous, points, healthy, error):
    old = {p['periodEnd']: p for p in previous.get('observations', [])}
    old.update(points)
    obs = sorted(old.values(), key=lambda p: p['periodEnd'])
    success = max((p['fetchedAt'] for p in obs), default=None)
    return {**previous, 'observations': obs, 'status': 'ready' if healthy and points else 'cached' if obs else 'fetch_failed',
            'fetchedAt': success, 'lastSuccessfulAt': success, 'checkedAt': now(), 'error': None if healthy and points else error}


def run(force=False):
    path = DATA / 'cross-company-evidence.json'
    old = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    jobs, errors, runs = [], [], []
    try:
        raw, stamp, digest = fetch_source(INDEX, force)
        indexes = discover_indexes(raw)
        runs.append({'entity': 'FUJIMI', 'url': INDEX, 'status': 'ready', 'fetchedAt': stamp, 'version': digest, 'checkedAt': now()})
        for url in indexes:
            body, _, _ = fetch_source(url, force)
            jobs += discover_releases(body)
        if not jobs:
            raise ValueError('官方索引未找到已发布实际财季')
    except Exception as exc:
        errors.append(str(exc))
        runs.append({'entity': 'FUJIMI', 'url': INDEX, 'status': 'fetch_failed', 'checkedAt': now(), 'error': str(exc)})

    def collect(job):
        try:
            raw, stamp, digest = fetch_source(job['url'], force)
            r = parse_report(raw, job)
            r.update(fetchedAt=stamp, version=digest)
            return r, {**job, 'periodEnd': r['periodEnd'], 'fetchedAt': stamp, 'version': digest, 'parsedAt': now(), 'checkedAt': now(),
                       'metricIds': ['FUJIMI.' + f for f in FAMILIES], 'status': 'ready'}
        except Exception as exc:
            return None, {**job, 'status': 'fetch_failed', 'checkedAt': now(), 'error': str(exc)}

    with ThreadPoolExecutor(max_workers=3) as pool:
        collected = list(pool.map(collect, {j['url']: j for j in jobs}.values()))
    reports = []
    for report, source_run in collected:
        runs.append(source_run)
        if report:
            reports.append(report)
        else:
            errors.append(source_run['error'])
    points, missing = quarterly_points(reports)
    newest = max((period(j['fiscalYear'], j['quarter'])[1] for j in jobs), default=None)
    healthy = bool(jobs) and not any(r['status'] == 'fetch_failed' and r['url'] == INDEX for r in runs)
    series = {d['id']: merge_series(old.get('series', {}).get(d['id'], {}), points[d['family']],
                                   healthy and newest in points[d['family']], '最新官方财季或差分基期缺失；保留最后成功观测和时间。') for d in definitions()}
    ase_urls = []
    ase_errors = []
    ase_reports = []
    for url in ase_indexes():
        try:
            body, fetched, digest = fetch_source(url, force)
            ase_urls.extend(discover_ase_releases(body))
            runs.append({'entity': 'ASE', 'url': url, 'status': 'ready', 'fetchedAt': fetched,
                         'version': digest, 'checkedAt': now()})
        except Exception as exc:
            ase_errors.append(str(exc))
            runs.append({'entity': 'ASE', 'url': url, 'status': 'fetch_failed', 'checkedAt': now(), 'error': str(exc)})
    ase_urls = list(dict.fromkeys(ase_urls))
    if not ase_urls:
        ase_errors.append('ASE 公司公告目录尚未提供可核验的季度业绩链接')

    def collect_ase(url):
        try:
            body, fetched, digest = fetch_source(url, force)
            report = parse_ase_report(body, url, date.today().isoformat())
            report.update(fetchedAt=fetched, version=digest)
            return report, {'entity': 'ASE', 'url': url, 'periodEnd': report['periodEnd'],
                            'publishedAt': report['publishedAt'], 'fetchedAt': fetched, 'version': digest,
                            'parsedAt': now(), 'checkedAt': now(),
                            'metricIds': ['ASE.' + family for family in ASE_FAMILIES], 'status': 'ready'}
        except Exception as exc:
            return None, {'entity': 'ASE', 'url': url, 'status': 'fetch_failed',
                          'checkedAt': now(), 'error': str(exc)}

    with ThreadPoolExecutor(max_workers=3) as pool:
        for report, source_run in pool.map(collect_ase, ase_urls):
            runs.append(source_run)
            if report:
                ase_reports.append(report)
            else:
                ase_errors.append(source_run['error'])
    ase_values = ase_points(ase_reports)
    newest_ase = max((r['periodEnd'] for r in ase_reports), default=None)
    for d in ase_definitions():
        series[d['id']] = merge_series(old.get('series', {}).get(d['id'], {}), ase_values[d['family']],
                                       bool(ase_urls) and newest_ase in ase_values[d['family']] and not ase_errors,
                                       'ASE 最新公司公告抓取或解析未完全成功；保留上次已核验观测。')
    ase_status = ('ready' if all(series['ASE.' + family]['status'] == 'ready' for family in ASE_FAMILIES)
                  else 'cached' if any(series['ASE.' + family]['observations'] for family in ASE_FAMILIES)
                  else 'fetch_failed')
    ase = {'status': ase_status, 'reason': 'ASE 公司自行发布的季度公告，经 PR Newswire 分发；只做跨公司经营线索，不参与正式评分。',
           'error': '; '.join(ase_errors[:3]) or None,
           'lastSuccessfulAt': series['ASE.atm_revenue']['lastSuccessfulAt']}
    errors.extend(ase_errors)
    catalog = [{'id': 'fujimi_cross_company', 'publisher': 'Fujimi', 'title': 'Fujimi CMP与公司实际经营数据', 'sourceUrl': INDEX,
                'status': 'ready' if all(series['FUJIMI.' + family]['status'] == 'ready' for family in FAMILIES)
                          else 'cached' if any(series['FUJIMI.' + family]['observations'] for family in FAMILIES) else 'fetch_failed',
                'modelUseAllowed': True, 'exportAllowed': True, 'purpose': '半导体材料第二家公司交叉证据', 'reason': SCOPE, 'checkedAt': now()},
               {'id': 'ase_cross_company', 'publisher': 'ASE Technology Holding', 'title': 'ASE封装测试季度交叉证据', 'sourceUrl': ASE_INDEX,
                'modelUseAllowed': True, 'exportAllowed': True, 'purpose': '封装测试第二家公司交叉证据', 'checkedAt': now(), **ase}]
    result = {'schemaVersion': '2', 'generatedAt': now(), 'definitions': definitions() + ase_definitions(), 'series': series, 'events': [], 'projects': [],
              'sourceRuns': runs, 'sourceCatalog': catalog, 'errors': errors, 'missingPeriods': missing,
              'sources': [{'id': 'cross-company-FUJIMI', 'name': 'Fujimi官方财报', 'url': INDEX, 'status': catalog[0]['status']},
                          {'id': 'cross-company-ASE', 'name': 'ASE公司公告', 'url': ASE_INDEX, 'status': ase['status'], 'error': ase.get('error')}],
              'ingestedReleases': [r for r in runs if r['status'] == 'ready' and r.get('periodEnd') and
                                   (r['entity'] == 'FUJIMI' and r['periodEnd'] in points['company_revenue'] or
                                    r['entity'] == 'ASE' and r['periodEnd'] in ase_values['company_revenue'])]}
    if (DATA / 'bootstrap' / path.name).exists() and DATA.resolve() == (Path(__file__).resolve().parents[1] / 'data' / 'industry').resolve():
        result = restore_bootstrap(path.name, result, backfill_history=True)
    persist(result, path)
    print(json.dumps({'series': {k: {'count': len(v['observations']), 'status': v['status']} for k, v in result['series'].items()}, 'errors': errors, 'ase': ase['status']}, ensure_ascii=False))
    return result


if __name__ == '__main__':
    run('--force' in __import__('sys').argv)
