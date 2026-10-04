"""Entegris consolidated operating sample, never AI-only or copper/aluminium demand.

Use the issuer's actual earnings releases. Headline GAAP and three-month cash
flow columns are kept distinct from guidance, annual/YTD and adjusted results.
Requests use the machine's normal proxy configuration; no subprocess is launched.
"""
import hashlib
import io
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from pypdf import PdfReader

from industry_common import DATA, atomic, definition, now, observation, persist
from industry_bootstrap import restore_bootstrap

VERSION = 'materials-evidence-1.1.0'
INDEX = 'https://www.entegris.com/en/home/about-us/news/news-archive.html?index=7'
IR_BASE = 'https://investor.entegris.com/news/news-details/'
HISTORY_START = '2024-01-01'
USER_AGENT = 'AI Macro Chain Monitor https://github.com/Timo168/ai-macro-chain-monitor'
BASELINE = [IR_BASE + path for path in (
    '2024/Entegris-Reports-Results-for-First-Quarter-of-2024-05-01-2024/default.aspx',
    '2024/Entegris-Reports-Results-for-Second-Quarter-of-2024-07-31-2024/default.aspx',
    '2024/Entegris-Reports-Results-for-Third-Quarter-of-2024-11-04-2024/default.aspx',
    '2025/Entegris-Reports-Results-for-Fourth-Quarter-of-2024/default.aspx',
    '2025/Entegris-Reports-Results-for-First-Quarter-of-2025/default.aspx',
    '2025/Entegris-Reports-Results-for-Second-Quarter-of-2025/default.aspx',
    '2025/Entegris-Reports-Results-for-Third-Quarter-of-2025/default.aspx',
    '2026/Entegris-Reports-Results-for-Fourth-Quarter-of-2025/default.aspx',
    '2026/Entegris-Reports-Results-for-First-Quarter-of-2026/default.aspx',
    '2026/Entegris-Reports-Results-for-Second-Quarter-of-2026/default.aspx',
)]
# These are verified, already-published official attachments, not guesses for
# future releases. New attachments are followed only from actual issuer HTML.
ATTACHMENTS = {
    BASELINE[0]: 'https://s205.q4cdn.com/144974603/files/doc_news/2024/05/pdf.pdf',
    BASELINE[2]: 'https://s205.q4cdn.com/144974603/files/doc_news/2024/11/26cf4f67-2d75-42eb-a376-e74c750e556e.pdf',
    BASELINE[5]: 'https://s205.q4cdn.com/144974603/files/doc_financials/2025/q2/Entegris-Reports-Results-for-Second-Quarter-2025.pdf',
    BASELINE[6]: 'https://s205.q4cdn.com/144974603/files/doc_financials/2025/q3/Entegris-Reports-Results-for-Third-Quarter-2025.pdf',
    BASELINE[7]: 'https://s205.q4cdn.com/144974603/files/doc_financials/2025/q4/Entegris_Reports_Results_For_4Q25.pdf',
    BASELINE[9]: 'https://s205.q4cdn.com/144974603/files/doc_financials/2026/q2/ENTG_Q226_Earnings_Release.pdf',
}
FAMILIES = ('company_revenue', 'gross_margin', 'capex')
PPE_LABELS = ('Acquisition of property, plant and equipment', 'Acquisition of property and equipment')


def allowed(url):
    p = urlparse(url)
    try:
        return p.scheme == 'https' and not p.username and not p.password and p.port in (None, 443) and (
            p.hostname == 'investor.entegris.com' and p.path.startswith('/news/news-details/')
            or p.hostname == 'www.entegris.com' and p.path.startswith('/en/home/about-us/news/')
            or p.hostname == 's205.q4cdn.com' and p.path.startswith('/144974603/files/')
        )
    except ValueError:
        return False


def fetch_source(url, force=False):
    if not allowed(url):
        raise ValueError('材料来源不在Entegris官方域名或附件命名空间')
    folder = DATA / 'raw'
    folder.mkdir(exist_ok=True)
    meta = folder / (hashlib.sha256(url.encode()).hexdigest() + '.meta.json')
    prior = json.loads(meta.read_text(encoding='utf-8')) if meta.exists() else {}
    if prior and not force and (datetime.fromisoformat(now()) - datetime.fromisoformat(prior['fetchedAt'])).total_seconds() < 86400:
        raw = (folder / prior['file']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != prior['hash']:
            raise ValueError('缓存源文件校验失败')
        return raw, prior['fetchedAt'], prior['hash']
    with requests.Session() as session:
        # Respect the user's existing proxy settings. Never print credentials or
        # retry by launching curl.exe/another visible console process.
        response = session.get(url, timeout=25, headers={'User-Agent': USER_AGENT})
        response.raise_for_status()
        if not allowed(response.url):
            raise ValueError('材料来源重定向至未允许域名')
        raw = response.content
    if len(raw) < 100:
        raise ValueError('Entegris来源为空')
    version = hashlib.sha256(raw).hexdigest()
    filename = version + ('.pdf' if raw.startswith(b'%PDF') else '.html')
    (folder / filename).write_bytes(raw)
    stamp = now()
    atomic(meta, {'url': url, 'file': filename, 'hash': version, 'fetchedAt': stamp})
    return raw, stamp, version


def parse_number(value):
    text = re.sub(r'[$,%\s]', '', value)
    if text in ('—', '-', ''):
        raise ValueError('缺失数值不能当成零')
    negative = text.startswith('(') and text.endswith(')')
    text = text.strip('()')
    if not re.fullmatch(r'\d+(?:\.\d+)?', text):
        raise ValueError('财报数值未通过格式校验')
    result = float(text)
    return -result if negative else result


def parse_date(text):
    text = ' '.join(text.replace('\xa0', ' ').split())
    text = re.sub(r'\b([A-Z][a-z]{2})\.\s', r'\1 ', text)
    for fmt in ('%b %d, %Y', '%B %d, %Y', '%Y-%m-%d'):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError('Entegris日期未核验：' + text)


def release_identity(title, text, published, as_of=None):
    as_of = as_of or date.today().isoformat()
    m = re.search(r'Entegris Reports Results for (First|Second|Third|Fourth) Quarter(?: of)? (20\d\d)', title, re.I)
    actual = re.search(r"(?:Company.s|company.s)\s+(?:first|second|third|fourth)\s+quarter ended\s+([A-Z][a-z]+\s+\d{1,2},\s+20\d\d)", text)
    if not m or not actual or 'Entegris, Inc.' not in text:
        raise ValueError('Entegris发布主体、实际季度标题或观测期未核验')
    quarter = ('first', 'second', 'third', 'fourth').index(m[1].lower()) + 1
    year, end = int(m[2]), parse_date(actual[1])
    if end[:4] != str(year) or abs(int(end[5:7]) - quarter * 3) > 1:
        raise ValueError('财报实际观测期与季度标题不一致')
    if not end <= published <= as_of:
        raise ValueError('未来或无效发布日期不能进入实际季度')
    return {'periodEnd': end, 'publishedAt': published, 'fiscalYear': year, 'quarter': quarter, 'fiscalPeriod': f'FY{year} Q{quarter}'}


def html_rows(table):
    return [[c.get_text(' ', strip=True) for c in tr.find_all(['th', 'td'])] for tr in table.find_all('tr')]


def table_unit(table):
    own = table.get_text(' ', strip=True)
    header = own.split('GAAP Results', 1)[0] if 'GAAP Results' in own else own[:500]
    unit = re.search(r'\bin (millions|thousands)\b', header, re.I)
    if not unit:
        previous = table.find_previous(string=re.compile(r'\bin (?:millions|thousands)\b', re.I))
        unit = re.search(r'\bin (millions|thousands)\b', str(previous or ''), re.I)
    if not unit:
        raise ValueError('美元金额表的百万/千单位未核验')
    label = unit[1].lower()
    return ('USD million', 1) if label == 'millions' else ('USD thousand', .001)


def financial_cells(cells):
    """Join typography-only cells, retaining each original numeric column.

    Older issuer HTML puts the closing parenthesis in a separate td and uses
    empty spacer cells. Missing-value dashes remain tokens and are never zero.
    """
    values, pending = [], ''
    for cell in cells:
        value = cell.strip()
        if not value:
            continue
        if pending:
            pending += value
            if pending.startswith('(') and not pending.endswith(')'):
                continue
            values.append(pending)
            pending = ''
        elif value in ('$', '(') or value.startswith('(') and not value.endswith(')'):
            pending = value
        elif value == ')':
            raise ValueError('现金流量表存在未配对的支出括号')
        else:
            values.append(value)
    if pending:
        raise ValueError('现金流量表数值单元格不完整')
    return values


def parse_cash_flow_html(table, period_end):
    """Read the actual three-month column; annual/YTD columns are not quarters."""
    if table is None:
        return {}
    rows = html_rows(table)
    header = next((i for i, row in enumerate(rows) if any(x == 'Three months ended' for x in row)), None)
    if header is None:
        return {}
    groups = [x for x in rows[header] if x]
    if not groups or groups[0] != 'Three months ended':
        raise ValueError('现金流量表当前单季列不是第一组，不能安全读取')
    dates = next(([x for x in row if x] for row in rows[header + 1:header + 4]
                  if any(re.fullmatch(r'[A-Z][a-z]+\s+\d{1,2},\s+20\d\d', x) for x in row)), None)
    matches = [row for row in rows if row and row[0] in PPE_LABELS]
    if not dates or len(matches) != 1:
        return {}
    if parse_date(dates[0]) != period_end:
        raise ValueError('现金流量表当前单季日期与实际财季不一致')
    values = financial_cells(matches[0][1:])
    if len(values) != len(dates):
        raise ValueError('现金流量表数值列和日期列数不一致')
    if values[0] in ('—', '–', '-', ''):
        return {}
    amount = parse_number(values[0])
    if amount > 0:
        raise ValueError('现金购建PPE的支出符号异常')
    unit, scale = table_unit(table)
    return {'capexSourceValue': amount, 'capexOriginalUnit': unit,
            'capexMillion': -amount * scale, 'capexSourceRow': matches[0][0]}


def parse_release_html(raw, as_of=None):
    soup = BeautifulSoup(raw, 'html.parser')
    title = soup.title.get_text(' ', strip=True) if soup.title else ''
    text = soup.get_text(' ', strip=True)
    stamp = soup.select_one('.evergreen-news-date-text')
    if not stamp:
        raise ValueError('Entegris官方发布日缺失')
    job = release_identity(title, text, parse_date(stamp.get_text(' ', strip=True)), as_of)
    source_tables = soup.find_all('table')
    summary_table = next((t for t in source_tables if any(row and row[0] == 'GAAP Results' for row in html_rows(t))), None)
    all_summary_rows = html_rows(summary_table) if summary_table else []
    header_index = next((i for i, row in enumerate(all_summary_rows) if row and row[0] == 'GAAP Results'), None)
    summary = all_summary_rows[header_index:] if header_index is not None else None
    if summary:
        stop = next((i for i, row in enumerate(summary) if row and row[0] == 'Non-GAAP Results'), len(summary))
        summary = summary[:stop]
    if not summary or len(summary[0]) != 4:
        raise ValueError('GAAP实际季度摘要不是当前/同比/上季三列')
    ends = [parse_date(x) for x in summary[0][1:]]
    if ends[0] != job['periodEnd']:
        raise ValueError('GAAP当前列观测期与正文实际季度不一致')
    previous = ends[2]
    if not 70 <= (date.fromisoformat(ends[0]) - date.fromisoformat(previous)).days <= 105:
        raise ValueError('上个实际财季日期不能用于确定本季起点')
    job['periodStart'] = (date.fromisoformat(previous) + timedelta(days=1)).isoformat()
    def row_value(label):
        matches = [row for row in summary if row and row[0] == label]
        if len(matches) != 1 or len(matches[0]) != 4:
            raise ValueError('GAAP实际行无法唯一核验：' + label)
        return parse_number(matches[0][1])
    income_unit, income_scale = table_unit(summary_table)
    job['revenueSourceValue'] = row_value('Net sales')
    job['revenueOriginalUnit'] = income_unit
    job['revenueMillion'] = job['revenueSourceValue'] * income_scale
    job['grossMargin'] = row_value('Gross margin - as a % of net sales')
    if not job['revenueMillion'] > 0 or not -100 <= job['grossMargin'] <= 100:
        raise ValueError('收入或GAAP毛利率超出边界')
    # Never read adjusted gross margin or the forward-guidance section.
    job['capexMillion'] = None
    cash_table = next((t for t in source_tables if 'Condensed Consolidated Statements of Cash Flows' in t.get_text(' ', strip=True)), None)
    job.update(parse_cash_flow_html(cash_table, job['periodEnd']))
    attachments = [urljoin('https://investor.entegris.com', a['href']) for a in soup.find_all('a', href=True) if '.pdf' in a['href']]
    job['attachments'] = [u for u in attachments if allowed(u)]
    return job


def parse_release_pdf(raw, as_of=None):
    pages = [p.extract_text() or '' for p in PdfReader(io.BytesIO(raw)).pages]
    text = ' '.join(' '.join(pages).split())
    title = text[:900]
    pub = re.search(r'BILLERICA,\s*(?:Mass\.|MA\.)(?:,\s*|--\(BUSINESS WIRE\)--)([A-Z][a-z]+\.?\s+\d{1,2},\s+20\d\d)', text)
    if not pub:
        raise ValueError('Entegris PDF官方发布日期未核验')
    job = release_identity(title, text, parse_date(pub[1]), as_of)
    summary = text.split('Quarterly Financial Results Summary', 1)[-1].split('Non-GAAP Results', 1)[0]
    dates = re.search(r'GAAP Results\s+([A-Z][a-z]{2}\s+\d{1,2},\s+20\d\d)\s+([A-Z][a-z]{2}\s+\d{1,2},\s+20\d\d)\s+([A-Z][a-z]{2}\s+\d{1,2},\s+20\d\d)', summary)
    revenue = re.search(r'Net sales\s+\$?([\d,.]+)', summary)
    margin = re.search(r'Gross margin\s*-\s*as a % of net sales\s+([\d.]+)\s*%', summary)
    if not all((dates, revenue, margin)) or parse_date(dates[1]) != job['periodEnd']:
        raise ValueError('Entegris PDF实际GAAP摘要或观测期缺失')
    previous = parse_date(dates[3])
    if not 70 <= (date.fromisoformat(job['periodEnd']) - date.fromisoformat(previous)).days <= 105:
        raise ValueError('PDF实际财季起点不能核验')
    unit = re.search(r'\bin (millions|thousands)\b', summary, re.I)
    if not unit:
        raise ValueError('PDF GAAP金额单位未核验')
    scale = 1 if unit[1].lower() == 'millions' else .001
    job.update(periodStart=(date.fromisoformat(previous) + timedelta(days=1)).isoformat(), revenueMillion=parse_number(revenue[1]) * scale, revenueSourceValue=parse_number(revenue[1]), revenueOriginalUnit='USD million' if scale == 1 else 'USD thousand', grossMargin=parse_number(margin[1]), capexMillion=None, attachments=[])
    # Read only a release PDF's separately labelled three-month cash-flow table.
    # An older release may expose YTD only: leave capex missing rather than guess.
    flow = text.split('Condensed Consolidated Statements of Cash Flows', 1)
    if len(flow) == 2:
        table = flow[1].split('Segment Information', 1)[0]
        groups = re.findall(r'(?:Three|Six|Nine|Twelve) months ended|Year ended', table.split('Operating activities:', 1)[0])
        current = re.search(r'Three months ended(?:\s+(?:Six|Nine|Twelve) months ended|\s+Year ended)?\s+([A-Z][a-z]{2}\s+\d{1,2},\s+20\d\d)', table)
        capex = re.search(r'(Acquisition of property(?:, plant)? and equipment)\s+\(\s*([\d,.]+)\s*\)', table)
        if groups and groups[0] == 'Three months ended' and current and capex and parse_date(current[1]) == job['periodEnd']:
            unit = re.search(r'\bin (millions|thousands)\b', table, re.I)
            if not unit:
                raise ValueError('PDF现金流量表金额单位未核验')
            scale = 1 if unit[1].lower() == 'millions' else .001
            job['capexMillion'] = parse_number(capex[2]) * scale
            job['capexSourceValue'] = -parse_number(capex[2])
            job['capexOriginalUnit'] = 'USD million' if scale == 1 else 'USD thousand'
            job['capexSourceRow'] = capex[1]
    return job


def material_definitions():
    result = []
    for family, name, unit in (
        ('company_revenue', 'Entegris公司总收入（非AI单项）', '亿美元'),
        ('gross_margin', 'Entegris公司GAAP毛利率', '%'),
        ('capex', 'Entegris现金购建固定资产（公司整体）', '亿美元'),
    ):
        method = '公司官方实际财季GAAP口径；百万美元÷100或千美元÷100000换为亿美元，原表单位单独核验；毛利率差使用百分点。PPE仅取现金流量表Three months ended当季支出，并将流出符号转为投入金额。'
        method += ' 公司含半导体及其他高技术业务，不是纯AI材料、铜铝需求或材料订单；2024年PIM业务剥离影响收入同比，未擅自改成有机增长。分部重组前后不拼接。'
        d = definition('ENTG.' + family, name, name, 'semiconductor', family, 'ENTG', 'Entegris official earnings releases', INDEX, unit, 'reported', method)
        d.update(sourceAdapter='materials-evidence', reportingScope='company_total', researchTargets=['semiconductor_materials'], scope='entegris_consolidated_not_ai_only', directness='company_disclosure', dataRole='company_financial_actual', isComparableAcrossEntities=False,
                 interpretation='观察Entegris已实现的经营周期，作为单家公司半导体材料经营样本；不代表整个AI材料市场。', crossCheck='结合分部业务、晶圆投片、先进节点需求、成本转嫁及公司估值；铜铝成本观察仍单独保留。')
        result.append(d)
    return result


def discover_releases(raw, as_of=None):
    as_of = as_of or date.today().isoformat()
    soup = BeautifulSoup(raw, 'html.parser')
    jobs = []
    for block in soup.select('.item'):
        link = block.find('a', href=True)
        title = link.get_text(' ', strip=True) if link else ''
        quarter = re.search(r'Entegris Reports Results (?:for )?(First|Second|Third|Fourth) Quarter(?: of)? (20\d\d)', title, re.I)
        stamp = block.select_one('.date')
        if not quarter or not stamp:
            continue
        published = parse_date(stamp.get_text(' ', strip=True).replace('Published', '').strip())
        if not HISTORY_START <= published <= as_of or int(quarter[2]) < 2024:
            continue
        url = urljoin(INDEX, link['href'])
        if allowed(url):
            jobs.append({'url': url, 'publishedAt': published, 'fiscalYear': int(quarter[2]), 'quarter': ('first', 'second', 'third', 'fourth').index(quarter[1].lower()) + 1})
    if not jobs:
        raise ValueError('官方新闻索引未发现已发布实际季度业绩链接')
    return jobs


def restore_failure(prior, error, checked_at):
    if prior and prior.get('observations'):
        return {**prior, 'status': 'cached', 'error': error, 'checkedAt': checked_at, 'note': '获取失败，保留最后成功实际财季和版本；未添加虚构数值。'}
    return {'observations': [], 'status': 'fetch_failed', 'error': error, 'checkedAt': checked_at, 'fetchedAt': None}


def run(force=False):
    path = DATA / 'materials-evidence.json'
    old = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    definitions = material_definitions()
    points, runs, errors = {}, [], {}
    try:
        index, stamp, version = fetch_source(INDEX, force)
        discovered = discover_releases(index)
        runs.append({'entity': 'ENTG', 'url': INDEX, 'status': 'ready', 'checkedAt': now(), 'fetchedAt': stamp, 'version': version})
    except Exception as exc:
        discovered = []
        errors['index'] = str(exc)
        runs.append({'entity': 'ENTG', 'url': INDEX, 'status': 'fetch_failed', 'checkedAt': now(), 'error': str(exc)})
    # Match discovered actual fiscal jobs to known history to avoid requesting
    # the same historical report through both its corporate and IR URL.
    identities = set()
    urls = list(BASELINE)
    for url in BASELINE:
        m = re.search(r'(First|Second|Third|Fourth)-Quarter-of-(20\d\d)', url)
        identity = (int(m[2]), ('First', 'Second', 'Third', 'Fourth').index(m[1]) + 1)
        identities.add(identity)
    urls += [j['url'] for j in discovered if (j['fiscalYear'], j['quarter']) not in identities]

    def collect(url):
        original = url
        try:
            try:
                raw, stamp, version = fetch_source(url, force)
                job = parse_release_pdf(raw) if raw.startswith(b'%PDF') else parse_release_html(raw)
            except Exception:
                if url not in ATTACHMENTS:
                    raise
                url = ATTACHMENTS[url]
                raw, stamp, version = fetch_source(url, force)
                job = parse_release_pdf(raw)
            family_values = {'company_revenue': job['revenueMillion'] / 100, 'gross_margin': job['grossMargin'], 'capex': job['capexMillion'] / 100 if job['capexMillion'] is not None else None}
            result = []
            for d in definitions:
                family = d['family']
                value = family_values[family]
                if value is None:
                    continue
                original_value = job['grossMargin'] if family == 'gross_margin' else job['revenueSourceValue'] if family == 'company_revenue' else job['capexSourceValue']
                original_unit = '%' if family == 'gross_margin' else job['revenueOriginalUnit'] if family == 'company_revenue' else job['capexOriginalUnit']
                divisor = 100 if original_unit == 'USD million' else 100000
                formula = 'reported GAAP gross margin (%)' if family == 'gross_margin' else f'reported fiscal-quarter net sales ({original_unit}) / {divisor}' if family == 'company_revenue' else f'-reported fiscal-quarter cash acquisition of PPE ({original_unit}) / {divisor}'
                p = observation(d['id'], job['periodEnd'], value, url, stamp, version, job['periodStart'], job['fiscalPeriod'], formula,
                                {'parserVersion': VERSION, 'scope': d['scope'], 'reportedValue': original_value, 'reportedUnit': original_unit, 'sourceReleaseUrl': original, 'sourceColumn': 'GAAP Results current quarter' if family != 'capex' else 'Cash flows Three months ended current quarter', 'sourceRow': 'Gross margin - as a % of net sales' if family == 'gross_margin' else 'Net sales' if family == 'company_revenue' else job.get('capexSourceRow'), 'sourceBasis': 'reported_actual_not_guidance'}, job['publishedAt'])
                p.update(originalValue=original_value, originalUnit=original_unit, originalCurrency='USD', reportingScope='company_total')
                result.append((d['id'], p))
            aliases=[j['url'] for j in discovered if j['fiscalYear']==job['fiscalYear'] and j['quarter']==job['quarter'] and str(j['publishedAt'])[:10]==str(job['publishedAt'])[:10] and allowed(j['url'])]
            run = {'entity': 'ENTG', 'url': original, 'sourceAliases': aliases, 'documentUrl': url, 'periodEnd': job['periodEnd'], 'fiscalYear': job['fiscalYear'], 'quarter': job['quarter'], 'publishedAt': job['publishedAt'], 'fetchedAt': stamp, 'version': version, 'parsedAt': now(), 'metricIds': [k for k, _ in result], 'status': 'ready', 'checkedAt': now()}
            if job['capexMillion'] is None:
                run['missingMetrics'] = ['ENTG.capex']
                run['note'] = '来源没有通过校验的单季现金PPE列；累计或全年值未当作季度。'
            return result, run, None
        except Exception as exc:
            return [], {'entity': 'ENTG', 'url': original, 'status': 'fetch_failed', 'checkedAt': now(), 'error': str(exc)}, str(exc)

    with ThreadPoolExecutor(max_workers=3) as pool:
        for rows, source_run, error in pool.map(collect, list(dict.fromkeys(urls))):
            runs.append(source_run)
            if error:
                errors[source_run['url']] = error
            for key, point in rows:
                points.setdefault(key, {})[point['periodEnd']] = point
    # A failed obsolete archive report should not invalidate a newly verified
    # latest release, but the failed source remains visible in sourceRuns.
    series = {}
    for d in definitions:
        key = d['id']
        previous = old.get('series', {}).get(key, {})
        prior = {p['periodEnd']: p for p in previous.get('observations', [])}
        fresh = points.get(key, {})
        prior.update(fresh)
        obs = sorted(prior.values(), key=lambda p: p['periodEnd'])
        unresolved_latest = any(r.get('status') == 'ready' and key in r.get('missingMetrics', []) and (not obs or r['periodEnd'] >= obs[-1]['periodEnd']) for r in runs)
        newest_discovered = max((j['publishedAt'] for j in discovered), default='')
        latest_verified = 'index' not in errors and bool(fresh) and fresh[max(fresh)]['publishedAt'] >= newest_discovered
        if not fresh or not latest_verified or unresolved_latest:
            error = '最新已发布季度来源未取得或缺少有效当季列；保留最后成功数据。'
            base = {**previous, 'observations': obs} if obs else previous
            series[key] = restore_failure(base, error, now())
        else:
            series[key] = {'observations': obs, 'status': 'ready', 'checkedAt': now(), 'fetchedAt': max(p['fetchedAt'] for p in obs), 'lastSuccessfulAt': max(p['fetchedAt'] for p in obs), 'error': None}
    result = {'schemaVersion': '1', 'generatedAt': now(), 'definitions': definitions, 'series': series, 'events': [], 'projects': [], 'sourceRuns': sorted(runs, key=lambda r: (r.get('periodEnd', ''), r['url'])),
              'sources': [{'id': 'materials-ENTG-' + hashlib.sha256(r['url'].encode()).hexdigest()[:12], 'name': 'Entegris官方公司经营样本', 'url': r['url'], 'status': r['status'], 'checkedAt': r['checkedAt'], 'error': r.get('error')} for r in runs],
              'ingestedReleases': [r for r in runs if r['status'] == 'ready' and r.get('periodEnd')]}
    if (DATA/'bootstrap'/'materials-evidence.json').exists() and DATA.resolve()==(__import__('pathlib').Path(__file__).resolve().parents[1]/'data'/'industry').resolve():
        result=restore_bootstrap('materials-evidence.json',result,backfill_history=True)
    persist(result, path)
    print(json.dumps({'series': {k: {'count': len(v['observations']), 'status': v['status']} for k, v in series.items()}, 'errors': errors}, ensure_ascii=False))
    return result


if __name__ == '__main__':
    run('--force' in __import__('sys').argv)
