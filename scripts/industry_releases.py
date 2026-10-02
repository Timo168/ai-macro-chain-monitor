"""Discover financial releases from official lists; never invent future report URLs.

The adapters consume candidates() without additional network requests. Discovery
records publication, first discovery and successful source-check times separately.
"""
import argparse
import hashlib
import io
import json
import re
import requests
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote

from bs4 import BeautifulSoup
from industry_common import DATA, ROOT, atomic, fetch, now

PATH = DATA / 'release-discovery.json'
VERSION = 1
SOURCES = {
    'DELL': ['https://investors.delltechnologies.com/news-events/press-release'],
    'AMD': ['https://ir.amd.com/news-events/press-releases?category=financial'],
    'NVDA': ['https://nvidianews.nvidia.com/helper-search-news?ct=releases&page=1&q=financial%20results'],
    'HPE': ['https://investors.hpe.com/news-and-events/investor-news-library', 'https://www.hpe.com/us/en/newsroom.html'],
    'ORCL': ['https://investor.oracle.com/investor-news/', 'https://www.oracle.com/news/'],
    'MSFT': ['https://aka.ms/latestearnings'],
    'GOOG': ['https://abc.xyz/investor/earnings/'],
    'AMZN': ['https://ir.aboutamazon.com/quarterly-results/default.aspx'],
    'META': ['https://investor.atmeta.com/financials/'],
    'TSM': ['https://investor.tsmc.com/english/quarterly-results'],
    'MU': ['https://investors.micron.com/quarterly-results'],
    'ETN': ['https://www.eaton.com/us/en-us/company/investor-relations/financial-reports/quarterly-earnings.html'],
    'VRT': ['https://investors.vertiv.com/financials/quarterly-results/default.aspx'],
}
HOSTS = {
    'DELL': {'investors.delltechnologies.com'},
    'AMD': {'ir.amd.com', 'www.amd.com'},
    'NVDA': {'investor.nvidia.com', 'nvidianews.nvidia.com'},
    'HPE': {'investors.hpe.com', 'www.hpe.com'},
    'ORCL': {'investor.oracle.com', 'www.oracle.com'},
    'MSFT': {'www.microsoft.com', 'aka.ms'},
    'GOOG': {'abc.xyz', 's206.q4cdn.com'},
    'AMZN': {'ir.aboutamazon.com', 's2.q4cdn.com'},
    'META': {'investor.atmeta.com', 's21.q4cdn.com'},
    'TSM': {'investor.tsmc.com', 'pr.tsmc.com'},
    'MU': {'investors.micron.com'},
    'ETN': {'www.eaton.com'},
    'VRT': {'investors.vertiv.com', 's22.q4cdn.com'},
}
WORDS = {'first': 1, 'second': 2, 'third': 3, 'fourth': 4}
DATE_WORD = r'(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2}'
PREANNOUNCEMENT = re.compile(r'\b(?:to\s+(?:report|announce|hold\s+(?:a\s+)?conference)|will\s+(?:report|announce|release|be\s+held)|sets?\s+(?:the\s+date|conference\s+call)|earnings\s+conference(?:\s+call)?|earnings\s+announcement)\b', re.I)
RESULT = re.compile(r'\b(?:results|earnings|press\s+release)\b', re.I)


def official_url(entity, url):
    parsed = urlparse(url)
    try:
        return parsed.scheme == 'https' and parsed.hostname in HOSTS.get(entity, set()) and not parsed.username and not parsed.password and parsed.port in (None, 443) and (parsed.hostname != 'aka.ms' or parsed.path == '/latestearnings')
    except ValueError:
        return False


def fiscal_period(text):
    """Parse the issuer's stated fiscal quarter, without calendar-year conversion."""
    text = unquote(text).replace('-', ' ').replace('_', ' ').replace('/', ' ')
    patterns = [
        r'\bQ([1-4])\s*(?:FY|FISCAL(?:\s+YEAR)?)\s*(20\d{2}|\d{2})\b',
        r'\b(?:FY|FISCAL(?:\s+YEAR)?)\s*(20\d{2}|\d{2})\s*Q([1-4])\b',
        r'\bQ([1-4])\s+(20\d{2})\b',
        r'\b(first|second|third|fourth)\s+quarter(?:\s+and(?:\s+full\s+year)?)?\s+(?:of\s+)?(?:fiscal(?:\s+year)?\s+)?(20\d{2})\b',
        r'\b(?:fiscal(?:\s+year)?\s+)?(20\d{2})\s+(first|second|third|fourth)\s+quarter\b',
        r'\b(20\d{2})\s*Q([1-4])\b',
    ]
    for n, pattern in enumerate(patterns):
        m = re.search(pattern, text, re.I)
        if not m:
            continue
        a, b = m.groups()
        if n in (1, 4, 5):
            a, b = b, a
        quarter = WORDS.get(a.lower(), int(a) if a.isdigit() else 0)
        year = int(b) + (2000 if len(b) == 2 else 0)
        if quarter and 2000 <= year <= 2100:
            return year, quarter
    return None


def parse_date(text):
    if not text:
        return None
    text = str(text).strip()
    iso = re.match(r'^(20\d{2}-\d{2}-\d{2})(?:T[^\s]+)?', text)
    if iso:
        try:
            parsed = datetime.fromisoformat(iso.group(0).replace('Z', '+00:00'))
            # Date-only data stays date-only; do not assign a fictional timezone.
            return parsed.isoformat() if parsed.tzinfo else parsed.date().isoformat()
        except ValueError:
            return None
    try:
        parsed = parsedate_to_datetime(text)
        return parsed.isoformat() if parsed.tzinfo else parsed.date().isoformat()
    except (ValueError, TypeError):
        pass
    m = re.search(DATE_WORD, text, re.I)
    if m:
        clean = re.sub(r'(\d)(?:st|nd|rd|th)', r'\1', m.group(0), flags=re.I).replace('.', '').replace(',', '')
        clean = re.sub(r'\bSept\b', 'Sep', clean, flags=re.I)
        for fmt in ('%B %d %Y', '%b %d %Y'):
            try:
                return datetime.strptime(clean, fmt).date().isoformat()
            except ValueError:
                pass
    m = re.search(r'\b(\d{1,2})/(\d{1,2})/(20\d{2})\b', text)
    if m:
        try:
            return datetime(int(m[3]), int(m[1]), int(m[2])).date().isoformat()
        except ValueError:
            pass
    return None


def publication_date(node):
    for item in node.select('time[datetime]'):
        value = parse_date(item.get('datetime'))
        if value:
            return value
    for selector in ('.article-date', '.date', '.date-time', '.nir-widget--news--date-time', '.module-news-date', '[class*="publish"]'):
        item = node.select_one(selector)
        if item:
            value = parse_date(item.get_text(' ', strip=True))
            if value:
                return value
    for meta in node.select('meta'):
        key = (meta.get('name') or meta.get('property') or '').lower()
        if key in ('date', 'datepublished', 'article:published_time', 'publication_date', 'publishdate', 'dc.date.issued'):
            value = parse_date(meta.get('content'))
            if value:
                return value
    for script in node.select('script[type="application/ld+json"]'):
        for raw in re.findall(r'"datePublished"\s*:\s*"([^"]+)"', script.get_text()):
            value = parse_date(raw)
            if value:
                return value
    return None


def _context(anchor):
    for parent in anchor.parents:
        if parent.name == 'article' or {'media-body', 'index-item', 'module-news-list-item', 'news-item'} & set(parent.get('class', [])):
            return parent
    for parent in list(anchor.parents)[:3]:
        if len(parent.get_text(' ', strip=True)) < 1800:
            return parent
    return anchor.parent


def parse_index(entity, raw, index_url):
    """Extract actual links and their surrounding official date/title metadata."""
    soup = BeautifulSoup(raw, 'html.parser')
    result = []
    seen = set()
    canonical = soup.select_one('link[rel="canonical"]')
    base_url = urljoin(index_url, canonical.get('href', '')) if canonical else index_url
    for anchor in soup.select('a[href]'):
        if entity == 'MSFT':
            break
        url = urljoin(base_url, anchor.get('href', '').strip())
        url = urlparse(url)._replace(fragment='').geturl()
        if not official_url(entity, url) or url in seen:
            continue
        context = _context(anchor)
        title = ' '.join(filter(None, [anchor.get_text(' ', strip=True), anchor.get('title'), anchor.get('aria-label')]))
        if title.lower() in ('read more', 'read press release', 'html', 'pdf', 'earnings release', 'press release'):
            heading = context.select_one('h1,h2,h3,h4,.nir-widget--accordion-toggle,.media-heading,.index-item-title')
            title = heading.get_text(' ', strip=True) if heading else context.get_text(' ', strip=True)[:500]
        combined = title + ' ' + unquote(urlparse(url).path)
        period = fiscal_period(combined)
        if entity == 'TSM' and ('/english/quarterly-results/' not in url or not period or period[0] < datetime.now(timezone.utc).year - 1):
            continue
        if not RESULT.search(combined):
            continue
        # A short headline may omit the year: validation may read it from the
        # linked release, never infer fiscal year from the URL publication year.
        if not period and not re.search(r'\bQ[1-4]\b|\b(?:first|second|third|fourth)[ -]quarter\b', combined, re.I):
            continue
        seen.add(url)
        result.append({'entity': entity, 'fiscalYear': period[0] if period else None, 'quarter': period[1] if period else None,
                       'publishedAt': publication_date(context), 'url': url, 'title': title.strip(), 'indexUrl': index_url,
                       'kind': 'upcoming' if PREANNOUNCEMENT.search(title) else 'release'})
    # Microsoft's published latest-earnings short link resolves to a canonical
    # release page. TSMC's current result page may instead be a future meeting.
    if entity in ('MSFT', 'TSM'):
        url = base_url
        period = fiscal_period(url)
        if entity == 'TSM' and not period:
            matches = re.findall(r'20\d{2}[/-]q[1-4]', str(soup), re.I)
            period = fiscal_period(matches[-1]) if matches else None
        if period and official_url(entity, url):
            main = soup.select_one('main') or soup
            text = main.get_text(' ', strip=True)
            title = f'{entity} FY{period[0]} Q{period[1]} earnings results'
            upcoming = re.search(r'(?:Earnings\s+Conference\s+will\s+be\s+held|results\s+will\s+be\s+released)', text, re.I)
            if upcoming:
                title = text[max(0, upcoming.start() - 55):upcoming.end() + 180]
            item = {'entity': entity, 'fiscalYear': period[0], 'quarter': period[1], 'publishedAt': publication_date(soup),
                    'url': url, 'title': title, 'indexUrl': index_url, 'kind': 'upcoming' if upcoming else 'release'}
            if upcoming:
                item['eventAt'] = parse_date(text[upcoming.start():upcoming.end() + 200])
            if url not in seen:
                result.append(item)
    return result


def _document(raw):
    if raw.startswith(b'%PDF'):
        from pypdf import PdfReader
        text = '\n'.join(p.extract_text() or '' for p in PdfReader(io.BytesIO(raw)).pages[:2])
        return None, text
    soup = BeautifulSoup(raw, 'html.parser')
    main = soup.select_one('.article-body, main, .module-news-detail, .news-details, .press-release') or soup.body or soup
    return soup, main.get_text(' ', strip=True)


def validate_release(item, raw):
    """Confirm linked content and publication date before declaring published."""
    soup, text = _document(raw)
    if re.search(r'Just a moment|Access Denied|Checking your browser', text[:600], re.I):
        raise ValueError('官方页面受访问限制')
    headline = soup.select_one('h1,h2.module-news-detail-title') if soup else None
    title = headline.get_text(' ', strip=True) if headline else item['title']
    is_upcoming = item.get('kind') == 'upcoming' or bool(PREANNOUNCEMENT.search(title)) or (item['entity'] == 'TSM' and bool(re.search(r'Earnings\s+Conference\s+will\s+be\s+held', text, re.I)))
    stated = (item.get('fiscalYear'), item.get('quarter'))
    period = fiscal_period(title) or (stated if all(stated) else None) or fiscal_period(text[:4500])
    if not period or not period[0] or period[1] not in (1, 2, 3, 4):
        raise ValueError('官方财报财年或季度无法核验')
    value = dict(item, title=title, fiscalYear=period[0], quarter=period[1], kind='upcoming' if is_upcoming else 'release')
    value['publishedAt'] = item.get('publishedAt') or (publication_date(soup) if soup else None)
    if not value['publishedAt'] and not (is_upcoming and item['entity'] == 'TSM'):
        # Dateline belongs near the opening of an official earnings release;
        # do not use arbitrary dates in its financial tables or footer.
        headline_position = text.find(title)
        dateline = text[headline_position:headline_position + 1800] if headline_position >= 0 else text[:1800]
        value['publishedAt'] = parse_date(dateline)
    if is_upcoming:
        # Headline and its dateline announce the scheduling notice, not the
        # earnings day. Prefer the explicit release/call sentence in the body.
        event = item.get('eventAt')
        for marker in re.finditer(r'(?:will\s+be\s+(?:released|held)|will\s+(?:report|announce|hold|host)|results\s+to\s+be\s+released|conference\s+call\s+(?:on|for)|scheduled\s+for|on\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday))', text, re.I):
            event = event or parse_date(text[marker.start():marker.start() + 350])
            if event:
                break
        value['eventAt'] = event
        if not value['eventAt']:
            raise ValueError('官方预告缺少可核验的举行日期')
    else:
        if not value['publishedAt']:
            raise ValueError('官方已发布财报缺少可核验的发布日期')
        if value['publishedAt'][:10] > datetime.now(timezone.utc).date().isoformat():
            raise ValueError('未来发布日期不能作为已发布财报')
        if not re.search(r'\b(?:revenue|revenues|net\s+income|net\s+earnings|gross\s+margin|cash\s+flow)\b', text, re.I):
            raise ValueError('链接缺少实际财务业绩正文')
    value['format'] = 'pdf' if raw.startswith(b'%PDF') else 'html'
    value['id'] = hashlib.sha256((value['entity'] + '|' + value['url']).encode()).hexdigest()[:20]
    return value


def _entity(entity, prior, force, fetcher):
    checked = now()
    errors = []
    found = []
    successful_checks = []
    for index_url in SOURCES.get(entity, []):
        try:
            raw, fetched, digest = fetcher(index_url, force=True)
            links = parse_index(entity, raw, index_url)
            if not links:
                raise ValueError('官方入口暂无可识别财报链接，无法确认发布状态')
            # Recent actual quarters plus future announcements, never a full
            # historical crawl on every scheduled check.
            links.sort(key=lambda p: (p.get('fiscalYear') or 0, p.get('quarter') or 0, p.get('publishedAt') or ''), reverse=True)
            selected = [p for p in links if p['kind'] == 'release'][:4] + [p for p in links if p['kind'] == 'upcoming'][:3]
            canonical = BeautifulSoup(raw, 'html.parser').select_one('link[rel="canonical"]')
            canonical_url = urljoin(index_url, canonical.get('href', '')) if canonical else index_url
            for item in selected:
                try:
                    if item['url'] in (index_url, canonical_url):
                        body, stamp, version = raw, fetched, digest
                    else:
                        body, stamp, version = fetcher(item['url'], force=force)
                    value = validate_release(item, body)
                    old = next((p for p in prior.get('releases', []) + prior.get('upcoming', []) if p.get('url') == value['url']), {})
                    value.update(discoveredAt=old.get('discoveredAt') or checked, fetchedAt=stamp, version=version)
                    found.append(value)
                    successful_checks.append(fetched)
                except Exception as exc:
                    errors.append(f"{item['url']}: {exc}")
        except Exception as exc:
            errors.append(f'{index_url}: {exc}')
    releases = [p for p in found if p['kind'] == 'release']
    upcoming = [p for p in found if p['kind'] == 'upcoming']
    if not releases and not upcoming:
        # A successful HTTP response alone is not a successful discovery.
        has_cache = bool(prior.get('releases') or prior.get('upcoming'))
        return dict(prior, entity=entity, status='cached' if has_cache else 'fetch_failed', checkedAt=checked,
                    lastSuccessfulAt=prior.get('lastSuccessfulAt'), error='; '.join(errors)[:1800] or '未配置官方入口',
                    releases=prior.get('releases', []), upcoming=prior.get('upcoming', []), indexUrls=SOURCES.get(entity, []), parserVersion=VERSION)
    # Keep previously verified links when the official list rotates or one of
    # the detail pages fails. Their original publication/acquisition times stay.
    combined = {p['url']: p for p in prior.get('releases', [])}
    combined.update({p['url']: p for p in releases})
    releases = sorted(combined.values(), key=lambda p: (p['fiscalYear'], p['quarter'], p.get('publishedAt') or ''), reverse=True)[:12]
    released = {(p['fiscalYear'], p['quarter']) for p in releases}
    today = datetime.now(timezone.utc).date().isoformat()
    upcoming = [p for p in upcoming if (p['fiscalYear'], p['quarter']) not in released and p.get('eventAt', '')[:10] >= today]
    return {'entity': entity, 'status': 'ready', 'checkedAt': checked, 'lastSuccessfulAt': max(successful_checks),
            'error': '; '.join(errors)[:1800] or None, 'partialFailure': bool(errors), 'releases': releases,
            'upcoming': upcoming, 'indexUrls': SOURCES.get(entity, []), 'parserVersion': VERSION}


def candidates(entity, path=None):
    path = Path(path) if path is not None else PATH
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        return value.get('entities', {}).get(entity, {}).get('releases', [])
    except (OSError, ValueError, TypeError):
        return []


def _seed_prior(path):
    """Bootstrap only the real workspace, preserving verified source timestamps."""
    if DATA.resolve() != (ROOT / 'data' / 'industry').resolve() or path != PATH or path.exists():
        return {}
    try:
        seed = json.loads((DATA / 'release-discovery.seed.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    today = datetime.now(timezone.utc).date().isoformat()
    entities = {}
    for entity, prior in seed.get('entities', {}).items():
        if entity not in SOURCES or not isinstance(prior, dict):
            continue
        try:
            success = parse_date(prior.get('lastSuccessfulAt'))
            if not success or success[:10] > today:
                continue
            validated = {'releases': [], 'upcoming': []}
            for kind in validated:
                for item in prior.get(kind, []):
                    if not isinstance(item, dict) or item.get('entity') != entity or not official_url(entity, item.get('url', '')) or not official_url(entity, item.get('indexUrl', '')):
                        continue
                    year, quarter = item.get('fiscalYear'), item.get('quarter')
                    if isinstance(year, bool) or not isinstance(year, int) or not 2000 <= year <= datetime.now(timezone.utc).year + 1 or isinstance(quarter, bool) or quarter not in (1, 2, 3, 4):
                        continue
                    if not all(parse_date(item.get(key)) and parse_date(item[key])[:10] <= today for key in ('fetchedAt', 'discoveredAt')):
                        continue
                    publication = parse_date(item.get('publishedAt'))
                    if kind == 'releases' and (not publication or publication[:10] > today):
                        continue
                    if kind == 'upcoming' and not parse_date(item.get('eventAt')):
                        continue
                    validated[kind].append(item)
            if validated['releases'] or validated['upcoming']:
                entities[entity] = dict(prior, **validated, status='cached', bootstrap=True)
        except (TypeError, ValueError, AttributeError):
            continue
    return {'entities': entities}


def fetch_official(url, force=False):
    """Direct background request avoids a broken desktop proxy; keep raw lineage."""
    key = hashlib.sha256(url.encode()).hexdigest()
    folder = DATA / 'raw'
    folder.mkdir(exist_ok=True)
    meta = folder / (key + '.meta.json')
    try:
        old = json.loads(meta.read_text(encoding='utf-8'))
        if not force and datetime.now(timezone.utc) - datetime.fromisoformat(old['fetchedAt']) < timedelta(hours=24):
            return (folder / old['file']).read_bytes(), old['fetchedAt'], old['hash']
    except (OSError, ValueError, KeyError):
        pass
    try:
        with requests.Session() as session:
            session.trust_env = False
            response = session.get(url, timeout=20)
            response.raise_for_status()
            final = response.url
            if not any(official_url(entity, final) for entity in HOSTS):
                raise ValueError('官方入口重定向到未许可域名')
            raw = response.content
        if len(raw) < 100:
            raise ValueError('官方来源响应为空或过短')
    except Exception:
        return fetch(url, force=force)
    digest = hashlib.sha256(raw).hexdigest()
    filename = digest + ('.pdf' if raw.startswith(b'%PDF') else '.html')
    (folder / filename).write_bytes(raw)
    stamp = now()
    atomic(meta, {'url': url, 'file': filename, 'hash': digest, 'fetchedAt': stamp})
    return raw, stamp, digest


def run(force=False, entities=None, path=None, fetcher=None):
    path = Path(path) if path is not None else PATH
    try:
        prior = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        prior = _seed_prior(path)
    selected = entities or list(SOURCES)
    output = dict(prior.get('entities', {}))
    get = fetcher or fetch_official
    for entity in selected:
        if entity not in SOURCES:
            output[entity] = {'entity': entity, 'status': 'not_configured', 'checkedAt': now(), 'lastSuccessfulAt': None,
                              'error': '未配置官方财报发现入口', 'releases': [], 'upcoming': [], 'indexUrls': []}
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = {entity: pool.submit(_entity, entity, output.get(entity, {}), force, get) for entity in selected if entity in SOURCES}
        for entity, job in jobs.items():
            output[entity] = job.result()
    value = {'generatedAt': now(), 'schemaVersion': VERSION, 'entities': output,
             'methodology': '只发现官方入口实际链接；正式财报核验正文、财季与发布日期；预告单列；失败保留原缓存，不将HTTP失败认定为尚未发布。'}
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic(path, value)
    return value


if __name__ == '__main__':
    cli = argparse.ArgumentParser()
    cli.add_argument('--force', action='store_true')
    cli.add_argument('--entity', action='append')
    args = cli.parse_args()
    result = run(args.force, args.entity)
    print(json.dumps({e: {'status': v['status'], 'releases': len(v['releases']), 'upcoming': len(v['upcoming'])} for e, v in result['entities'].items()}, ensure_ascii=False))
