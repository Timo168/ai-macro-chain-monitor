"""Collect official decision-time central-bank policy updates.

The comparable BIS chart deliberately stays monthly and month-end. This file
tracks published decisions separately, beginning with the Fed's official RSS
feed, so a decision is never mislabeled as a common month-end observation.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree

from bs4 import BeautifulSoup

from collect import DATA, download

FED_RSS_URL = 'https://www.federalreserve.gov/feeds/press_monetary.xml'
FED_BASE_URL = 'https://www.federalreserve.gov'
FED_HOSTS = {'federalreserve.gov', 'www.federalreserve.gov'}
FED_STATEMENT_PATH = re.compile(r'/newsevents/pressreleases/monetary(?P<date>\d{8})a\.htm(?:\?.*)?$', re.I)
BOJ_STATEMENTS_URL = 'https://www.boj.or.jp/en/mopo/mpmdeci/state_2026/index.htm'
BOJ_BASE_URL = 'https://www.boj.or.jp'
BOJ_DATE_PATTERN = re.compile(r'(?P<month>[A-Z][a-z]+)\.\s*(?P<day>\d{1,2}),\s*(?P<year>\d{4})')
# BOJ publishes the decision documents as scanned PDFs. The entries below are
# only accepted when the official PDF hash matches; a new unrecognised scan is
# retained as a source failure rather than inferring a rate from a headline.
BOJ_VERIFIED_GUIDELINES = {
    'https://www.boj.or.jp/en/mopo/mpmdeci/mpr_2026/k260918a.pdf': {
        'sha256': '71ed633ee13d464695076f2bf35c8a85fc79ddf06bdcbb921ac33004a229805b',
        'announcementDate': '2026-09-18',
        'effectiveDate': '2026-09-24',
        'rate': 1.25,
        'changeBps': 25.0,
        'action': 'raise',
    },
}
ACTION_PATTERN = re.compile(r'\bdecided to\s+(?P<action>raise|lower|maintain)\b', re.I)
RANGE_PATTERN = re.compile(
    r'target range for the federal funds rate(?:\s+by\s+[\d¼½¾\s/.-]+?\s+(?:percentage point|basis points))?\s+(?:to|at)\s+(?P<lower>[\d¼½¾\s/.-]+?)\s+to\s+(?P<upper>[\d¼½¾\s/.-]+?)\s+percent',
    re.I,
)
CHANGE_PATTERN = re.compile(r'\bby\s+(?P<amount>[\d¼½¾\s/.-]+?)\s+(?P<unit>percentage point|basis points)\b', re.I)
EFFECTIVE_PATTERN = re.compile(r'\beffective\s+(?P<date>[A-Z][a-z]+\s+\d{1,2},\s+\d{4})', re.I)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def atomic_write(path: pathlib.Path, payload: dict):
    temporary = path.with_suffix('.tmp.json')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(temporary, path)


def archive_raw(label: str, extension: str, raw: bytes, source: str = 'FED_POLICY'):
    digest = hashlib.sha256(raw).hexdigest()
    archive = DATA / 'versions' / source
    archive.mkdir(parents=True, exist_ok=True)
    path = archive / f'{label}-{digest}.{extension}'
    if not path.exists():
        path.write_bytes(raw)
    return digest, f'data/versions/{source}/{path.name}'


def element_text(element, name: str):
    for child in element:
        if child.tag.rsplit('}', 1)[-1] == name:
            return ''.join(child.itertext()).strip()
    return ''


def find_latest_fed_statement(raw: bytes, today: date | None = None):
    """Return latest verified FOMC statement link in the official RSS feed."""
    today = today or datetime.now(timezone.utc).date()
    root = ElementTree.fromstring(raw)
    candidates = []
    for item in root.iter():
        if item.tag.rsplit('}', 1)[-1] != 'item':
            continue
        title = element_text(item, 'title')
        link = urljoin(FED_BASE_URL, element_text(item, 'link'))
        if title.casefold() != 'federal reserve issues fomc statement':
            continue
        parsed = urlparse(link)
        match = FED_STATEMENT_PATH.fullmatch(parsed.path + (f'?{parsed.query}' if parsed.query else ''))
        if parsed.netloc not in FED_HOSTS or not match:
            continue
        statement_date = datetime.strptime(match.group('date'), '%Y%m%d').date()
        if statement_date > today:
            continue
        published = element_text(item, 'pubDate')
        announced_at = parsedate_to_datetime(published).astimezone(timezone.utc).isoformat() if published else None
        candidates.append((statement_date, link, announced_at))
    if not candidates:
        raise ValueError('No current official FOMC statement found in Fed RSS')
    statement_date, link, announced_at = max(candidates, key=lambda candidate: candidate[0])
    return statement_date, link, announced_at


def html_text(raw: bytes):
    value = raw.decode('utf-8', errors='replace')
    value = re.sub(r'<(?:script|style)\b[^>]*>.*?</(?:script|style)>', ' ', value, flags=re.I | re.S)
    value = re.sub(r'<[^>]+>', ' ', value)
    return re.sub(r'\s+', ' ', unescape(value)).strip()


def parse_rate_token(value: str):
    clean = value.strip().replace('−', '-').replace('–', '-').replace('¼', '.25').replace('½', '.5').replace('¾', '.75')
    clean = re.sub(r'\s+', ' ', clean)
    if '-' in clean and '/' in clean:
        whole, fraction = clean.split('-', 1)
        numerator, denominator = fraction.split('/', 1)
        return float(whole) + float(numerator) / float(denominator)
    if ' ' in clean and '/' in clean:
        whole, fraction = clean.split(' ', 1)
        numerator, denominator = fraction.split('/', 1)
        return float(whole) + float(numerator) / float(denominator)
    if '/' in clean:
        numerator, denominator = clean.split('/', 1)
        return float(numerator) / float(denominator)
    return float(clean)


def parse_fed_statement(raw: bytes, statement_url: str, announcement_date: date):
    text = html_text(raw)
    action_match = ACTION_PATTERN.search(text)
    range_match = RANGE_PATTERN.search(text)
    if not action_match or not range_match:
        raise ValueError('Fed statement wording changed; cannot safely parse target range')
    action = action_match.group('action').lower()
    lower = parse_rate_token(range_match.group('lower'))
    upper = parse_rate_token(range_match.group('upper'))
    if not 0 <= lower <= upper <= 100:
        raise ValueError('Fed target range is out of bounds')
    change_bps = 0.0
    if action != 'maintain':
        change_match = CHANGE_PATTERN.search(text[action_match.start():range_match.end()])
        if not change_match:
            raise ValueError('Fed statement omitted a parseable policy change')
        amount = parse_rate_token(change_match.group('amount'))
        change_bps = amount * (100 if change_match.group('unit').lower().startswith('percentage') else 1)
        if action == 'lower':
            change_bps = -change_bps
    return {
        'bankId': 'fed',
        'bank': '美联储',
        'country': '美国',
        'announcementDate': announcement_date.isoformat(),
        'lower': lower,
        'upper': upper,
        'midpoint': (lower + upper) / 2,
        'action': action,
        'changeBps': change_bps,
        'statementUrl': statement_url,
        'sourceName': '美国联邦储备委员会 FOMC 声明',
    }


def parse_effective_date(raw: bytes):
    match = EFFECTIVE_PATTERN.search(html_text(raw))
    if not match:
        raise ValueError('Fed implementation note omitted a parseable effective date')
    return datetime.strptime(match.group('date'), '%B %d, %Y').date().isoformat()


def find_latest_boj_guideline(raw: bytes, today: date | None = None):
    """Find the latest official BOJ money-market guideline document."""
    today = today or datetime.now(timezone.utc).date()
    soup = BeautifulSoup(raw, 'html.parser')
    candidates = []
    for row in soup.select('tr'):
        cells = row.find_all('td')
        if len(cells) < 2:
            continue
        link = cells[1].find('a', href=True)
        title = link.get_text(' ', strip=True) if link else ''
        if not title.startswith('Change in the Guideline for Money Market Operations'):
            continue
        match = BOJ_DATE_PATTERN.search(cells[0].get_text(' ', strip=True))
        if not match:
            continue
        month = 'Sep' if match.group('month') == 'Sept' else match.group('month')
        published = datetime.strptime(f"{month} {match.group('day')} {match.group('year')}", '%b %d %Y').date()
        if published <= today:
            candidates.append((published, urljoin(BOJ_BASE_URL, link['href'])))
    if not candidates:
        raise ValueError('No current official BOJ money-market guideline found')
    return max(candidates, key=lambda candidate: candidate[0])


def parse_boj_verified_guideline(raw: bytes, statement_url: str, announcement_date: date):
    """Return a decision only for an official BOJ scan with a verified hash."""
    verified = BOJ_VERIFIED_GUIDELINES.get(statement_url)
    if not verified:
        raise ValueError('BOJ guideline scan is new and has no verified rate mapping')
    digest = hashlib.sha256(raw).hexdigest()
    if digest != verified['sha256']:
        raise ValueError('BOJ guideline PDF hash differs from the verified official document')
    if announcement_date.isoformat() != verified['announcementDate']:
        raise ValueError('BOJ guideline date differs from the verified official document')
    rate = verified['rate']
    return {
        'bankId': 'boj',
        'bank': '日本银行',
        'country': '日本',
        'announcementDate': verified['announcementDate'],
        'effectiveDate': verified['effectiveDate'],
        'lower': rate,
        'upper': rate,
        'midpoint': rate,
        'action': verified['action'],
        'changeBps': verified['changeBps'],
        'statementUrl': statement_url,
        'sourceName': '日本银行《货币市场操作方针变更》官方文件',
    }


def collect_boj_decision():
    index = download(BOJ_STATEMENTS_URL)
    announcement_date, statement_url = find_latest_boj_guideline(index)
    statement = download(statement_url)
    decision = parse_boj_verified_guideline(statement, statement_url, announcement_date)
    checked_at = utc_now()
    index_hash, index_path = archive_raw('index', 'html', index, 'BOJ_POLICY')
    statement_hash, statement_path = archive_raw(announcement_date.isoformat() + '-guideline', 'pdf', statement, 'BOJ_POLICY')
    decision['announcedAt'] = None
    decision['fetchedAt'] = checked_at
    decision['archive'] = {
        'indexSha256': index_hash,
        'indexPath': index_path,
        'statementSha256': statement_hash,
        'statementPath': statement_path,
    }
    return decision


def collect_policy_decisions():
    path = DATA / 'policy-decisions.json'
    prior = json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
    checked_at = utc_now()
    source = {
        'name': '央行官方决议文件与公告',
        'url': FED_RSS_URL,
        'frequency': '决议公布后每 15 分钟检查',
        'unit': '各央行政策利率，%',
    }
    prior_decisions = {item.get('bankId'): item for item in (prior or {}).get('decisions', []) if item.get('bankId')}
    errors = []
    updated = []
    try:
        feed = download(FED_RSS_URL)
        announcement_date, statement_url, announced_at = find_latest_fed_statement(feed)
        statement = download(statement_url)
        decision = parse_fed_statement(statement, statement_url, announcement_date)
        implementation_url = statement_url.replace('a.htm', 'a1.htm')
        implementation = download(implementation_url)
        decision['effectiveDate'] = parse_effective_date(implementation)
        decision['implementationUrl'] = implementation_url
        decision['announcedAt'] = announced_at
        decision['fetchedAt'] = checked_at
        feed_hash, feed_path = archive_raw('rss', 'xml', feed)
        statement_hash, statement_path = archive_raw(announcement_date.isoformat() + '-statement', 'html', statement)
        implementation_hash, implementation_path = archive_raw(announcement_date.isoformat() + '-implementation', 'html', implementation)
        decision['archive'] = {
            'feedSha256': feed_hash,
            'feedPath': feed_path,
            'statementSha256': statement_hash,
            'statementPath': statement_path,
            'implementationSha256': implementation_hash,
            'implementationPath': implementation_path,
        }
        prior_decisions['fed'] = decision
        updated.append('FED')
    except Exception as exc:
        errors.append(f'FED: {exc}')
    try:
        decision = collect_boj_decision()
        prior_decisions['boj'] = decision
        updated.append('BOJ')
    except Exception as exc:
        errors.append(f'BOJ: {exc}')
    if updated:
        payload = {
            'generatedAt': checked_at,
            'checkedAt': checked_at,
            'status': 'ready',
            'source': source,
            'decisions': [prior_decisions[key] for key in sorted(prior_decisions)],
            **({'error': '; '.join(errors)} if errors else {}),
        }
    elif prior:
        payload = {**prior, 'checkedAt': checked_at, 'status': 'cached', 'error': '; '.join(errors)}
    else:
        payload = {'generatedAt': checked_at, 'checkedAt': checked_at, 'status': 'fetch_failed', 'source': source, 'decisions': [], 'error': '; '.join(errors)}
    atomic_write(path, payload)
    print(f"POLICY_DECISIONS {'OK' if updated else 'FAILED'} {' '.join(updated)}", flush=True)
    return payload


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.parse_args()
    collect_policy_decisions()
