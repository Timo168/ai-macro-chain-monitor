"""Resolve Dell's migrated IR reports without treating a news list as a report."""
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

HOST = 'investors.delltechnologies.com'
INDEX = f'https://{HOST}/news-events/press-releases'
RESULTS = f'https://{HOST}/financial-information/financial-results'
WORDS = {'first': 1, 'second': 2, 'third': 3, 'fourth': 4}
# These numeric legacy addresses are the repository's existing fiscal sources.
LEGACY_NODES = {'/node/19176': (2026, 4), '/node/19036': (2026, 3)}
PERIOD = re.compile(r'(first|second|third|fourth)[ -]quarter(?:[ -]and[ -]full[ -]year)?[ -]fiscal[ -](20\d{2})', re.I)


def official(url):
    try:
        item = urlparse(url)
        return item.scheme == 'https' and item.hostname == HOST and not item.username and not item.password and item.port in (None, 443)
    except ValueError:
        return False


def fiscal_period(text):
    match = PERIOD.search(unquote(text))
    return (int(match[2]), WORDS[match[1].lower()]) if match else None


def requested_period(url):
    return LEGACY_NODES.get(urlparse(url).path) or fiscal_period(url)


def is_report_url(url):
    if not official(url):
        return False
    path = urlparse(url).path
    return path in LEGACY_NODES or (('/news-releases/news-release-details/' in path or '/press-releases/detail/' in path)
                                   and bool(re.search(r'dell-technologies-(?:delivers|announces)-', path, re.I)))


def validate_report(raw, actual_url, expected):
    if not official(actual_url) or not is_report_url(actual_url):
        raise ValueError('Dell 财报详情跳转到列表或非官方页面')
    if not raw:
        raise ValueError('Dell 财报正文为空')
    soup = BeautifulSoup(raw, 'html.parser')
    headings = [node.get_text(' ', strip=True) for node in soup.select('h1, title')]
    if not any(re.search(r'Dell Technologies (?:Delivers|Announces)', text, re.I) and fiscal_period(text) == expected for text in headings):
        raise ValueError('Dell 财报标题与请求财政期不一致')
    tables = ' '.join(node.get_text(' ', strip=True) for node in soup.select('table'))
    if not re.search(r'Total\s+net\s+revenue', tables, re.I) or not re.search(r'Three\s+Months\s+Ended', tables, re.I):
        raise ValueError('Dell 财报未包含季度财务表格')


def request_official(url):
    """Check every redirect before following it; keep requests in this process."""
    with requests.Session() as session:
        session.trust_env = False
        for _ in range(6):
            if not official(url):
                raise ValueError('Dell 来源不在官方域名')
            response = session.get(url, timeout=20, allow_redirects=False)
            if response.is_redirect:
                url = urljoin(url, response.headers['Location'])
                continue
            response.raise_for_status()
            return response.content, url
    raise ValueError('Dell 官方来源重定向次数过多')


def resolve_report(url, request=request_official):
    expected = requested_period(url)
    if not is_report_url(url) or not expected:
        raise ValueError('Dell 财报地址缺少可核对的财政期')
    try:
        raw, actual = request(url)
    except requests.RequestException:
        raw, actual = b'', url
    if not official(actual):
        raise ValueError('Dell 来源跳转到非官方域名')
    try:
        validate_report(raw, actual, expected)
        return raw, actual
    except ValueError:
        pass
    # The official index exposes year/category filters. Dell Q1-Q3 are
    # published in the preceding calendar year; Q4 in the fiscal year.
    year, quarter = expected
    index_url = INDEX + f'?year={year if quarter == 4 else year - 1}&category=financial'
    index, actual_index = request(index_url)
    if not official(actual_index) or urlparse(actual_index).path.rstrip('/') != urlparse(INDEX).path:
        raise ValueError('Dell 财报索引跳转异常')
    soup = BeautifulSoup(index, 'html.parser')
    candidates = set()
    for anchor in soup.select('a[href]'):
        target = urljoin(actual_index, anchor['href'])
        title = anchor.get_text(' ', strip=True)
        if (official(target) and '/press-releases/detail/' in urlparse(target).path
                and re.search(r'Dell Technologies (?:Delivers|Announces)', title, re.I)
                and fiscal_period(title) == expected and fiscal_period(target) == expected):
            candidates.add(target)
    if not candidates:
        # Historical releases leave the paginated news feed. The financial
        # results archive links the original earnings release for each quarter.
        archive, actual_archive = request(RESULTS)
        if not official(actual_archive) or urlparse(actual_archive).path.rstrip('/') != urlparse(RESULTS).path:
            raise ValueError('Dell 官方财报档案未找到同财政期报告')
        for anchor in BeautifulSoup(archive, 'html.parser').select('a[href]'):
            target = urljoin(actual_archive, anchor['href'])
            if (is_report_url(target) and fiscal_period(target) == expected
                    and re.search(r'\bEarnings\s+Release\b', anchor.get_text(' ', strip=True), re.I)):
                candidates.add(target)
    if len(candidates) != 1:
        raise ValueError('Dell 官方索引未找到唯一的同财政期财报')
    raw, actual = request(candidates.pop())
    validate_report(raw, actual, expected)
    return raw, actual


def source_metadata(url, folder):
    try:
        return json.loads((folder / (hashlib.sha256(url.encode()).hexdigest() + '.meta.json')).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def fetch_report(url, folder, force=False, request=request_official):
    expected = requested_period(url)
    if not is_report_url(url) or not expected:
        raise ValueError('Dell 财报地址缺少可核对的财政期')
    old = source_metadata(url, folder)
    if old and not force:
        try:
            raw = (folder / old['file']).read_bytes()
            if hashlib.sha256(raw).hexdigest() != old['hash']:
                raise ValueError('Dell 存档校验失败')
            validate_report(raw, old.get('resolvedUrl', url), expected)
            if datetime.now(timezone.utc) - datetime.fromisoformat(old['fetchedAt']) < timedelta(hours=24):
                return raw, old['fetchedAt'], old['hash']
        except (OSError, KeyError, TypeError, ValueError):
            pass
    # Do not overwrite a successful cache until the replacement is validated.
    raw, actual = resolve_report(url, request)
    digest = hashlib.sha256(raw).hexdigest()
    stamp = datetime.now(timezone.utc).isoformat()
    folder.mkdir(parents=True, exist_ok=True)
    filename = digest + '.html'
    (folder / filename).write_bytes(raw)
    meta = folder / (hashlib.sha256(url.encode()).hexdigest() + '.meta.json')
    temporary = meta.with_suffix('.tmp')
    temporary.write_text(json.dumps({'url': url, 'resolvedUrl': actual, 'file': filename, 'hash': digest, 'fetchedAt': stamp}), encoding='utf-8')
    temporary.replace(meta)
    return raw, stamp, digest
