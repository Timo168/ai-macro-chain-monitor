"""Collect official decision-time central-bank policy updates.

The comparable BIS chart deliberately stays monthly and month-end. This file
tracks published decisions separately, beginning with the Fed's official RSS
feed, so a decision is never mislabeled as a common month-end observation.
"""
import argparse
import hashlib
import io
import json
import os
import pathlib
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree

from bs4 import BeautifulSoup
from pypdf import PdfReader

from collect import DATA, download

FED_RSS_URL = 'https://www.federalreserve.gov/feeds/press_monetary.xml'
BOE_RSS_URL = 'https://www.bankofengland.co.uk/rss/news'
FED_BASE_URL = 'https://www.federalreserve.gov'
FED_HOSTS = {'federalreserve.gov', 'www.federalreserve.gov'}
FED_STATEMENT_PATH = re.compile(r'/newsevents/pressreleases/monetary(?P<date>\d{8})a\.htm(?:\?.*)?$', re.I)
BOJ_STATEMENTS_URL = f'https://www.boj.or.jp/en/mopo/mpmdeci/state_{datetime.now(timezone.utc).year}/index.htm'
BOJ_BASE_URL = 'https://www.boj.or.jp'
BOJ_DATE_PATTERN = re.compile(r'(?P<month>[A-Z][a-z]+)\.?\s*(?P<day>\d{1,2}),\s*(?P<year>\d{4})')
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
OFFICIAL_DECISION_SOURCES = (
    {'bankId': 'fed', 'bank': '美联储', 'country': '美国', 'url': FED_RSS_URL},
    {'bankId': 'boj', 'bank': '日本银行', 'country': '日本', 'url': BOJ_STATEMENTS_URL},
    {'bankId': 'bok', 'bank': '韩国银行', 'country': '韩国', 'url': 'https://www.bok.or.kr/eng/main/contents.do?menuNo=400020'},
    {'bankId': 'ecb', 'bank': '欧洲央行', 'country': '欧元区', 'url': 'https://www.ecb.europa.eu/press/press_conference/html/index.en.html'},
    {'bankId': 'boe', 'bank': '英格兰银行', 'country': '英国', 'url': BOE_RSS_URL},
    {'bankId': 'boc', 'bank': '加拿大银行', 'country': '加拿大', 'url': 'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/'},
    {'bankId': 'rba', 'bank': '澳大利亚储备银行', 'country': '澳大利亚', 'url': 'https://www.rba.gov.au/monetary-policy/int-rate-decisions/'},
    {'bankId': 'rbnz', 'bank': '新西兰储备银行', 'country': '新西兰', 'url': 'https://www.rbnz.govt.nz/monetary-policy/monetary-policy-decisions'},
    {'bankId': 'snb', 'bank': '瑞士国家银行', 'country': '瑞士', 'url': 'https://www.snb.ch/en/the-snb/mandates-goals/monetary-policy/decisions'},
    {'bankId': 'pboc', 'bank': '中国人民银行', 'country': '中国', 'url': 'https://www.pbc.gov.cn/'},
    {'bankId': 'cbr', 'bank': '俄罗斯银行', 'country': '俄罗斯', 'url': 'https://cbr.ru/eng/hd_base/KeyRate/'},
    {'bankId': 'rbi', 'bank': '印度储备银行', 'country': '印度', 'url': 'https://www.rbi.org.in/Scripts/Annualpolicy.aspx'},
    {'bankId': 'bcb', 'bank': '巴西中央银行', 'country': '巴西', 'url': 'https://www.bcb.gov.br/en/monetarypolicy/copomstatements/cronologicos'},
    {'bankId': 'sarb', 'bank': '南非储备银行', 'country': '南非', 'url': 'https://www.resbank.co.za/en/home/what-we-do/monetary-policy/monetary-policy-committee'},
)
PARSED_DECISION_BANKS = {'fed','boj','boe','ecb','boc','rba','snb','rbi','rbnz'}
ACTION_PATTERN = re.compile(r'\bdecided to\s+(?P<action>raise|lower|maintain)\b', re.I)
RANGE_PATTERN = re.compile(
    r'target range for the federal funds rate(?:\s+by\s+[\d¼½¾\s/.-]+?\s+(?:percentage point|basis points))?\s+(?:to|at)\s+(?P<lower>[\d¼½¾\s/.-]+?)\s+to\s+(?P<upper>[\d¼½¾\s/.-]+?)\s+percent',
    re.I,
)
CHANGE_PATTERN = re.compile(r'\bby\s+(?P<amount>[\d¼½¾\s/.-]+?)\s+(?P<unit>percentage point|basis points)\b', re.I)
EFFECTIVE_PATTERN = re.compile(r'\beffective\s+(?P<date>[A-Z][a-z]+\s+\d{1,2},\s+\d{4})', re.I)
BOE_TITLE_PATTERN = re.compile(r'Bank [Rr]ate\s+(?P<action>maintained|increased|reduced)\s+(?:at|to)\s+(?P<rate>\d+(?:\.\d+)?)%', re.I)
ECB_DECISION_DATE_PATTERN = re.compile(r'PREVIOUS\s+.*?\s+(?P<date>\d{1,2}\s+[A-Z][a-z]+\s+20\d{2})\s+NEXT', re.I)
ECB_EFFECTIVE_DATE_PATTERN = re.compile(r'With effect from:\s*(?P<date>\d{1,2}\s+[A-Z][a-z]+\s+20\d{2})', re.I)
ECB_DEPOSIT_PATTERN = re.compile(r'Deposit facility\s+(?P<rate>\d+(?:\.\d+)?)\s*%', re.I)
BOC_ROW_PATTERN = re.compile(r'(?P<date>[A-Z][a-z]+\s+\d{1,2},\s+20\d{2})\s+(?P<rate>\d+(?:\.\d+)?)\s+(?P<change>---|[+-]\d+(?:\.\d+)?)')
RBA_DATE_PATTERN = re.compile(r'(?P<day>\d{1,2})\s+(?P<month>[A-Z][a-z]+)\s+(?P<year>20\d{2})')
RBA_DECISION_PATTERN = re.compile(r'Board decided to\s+(?P<action>leave|increase|reduce).*?(?:unchanged at|to)\s+(?P<rate>\d+(?:\.\d+)?)\s+per cent', re.I)


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


def parse_boe_statement(raw: bytes, statement_url: str, announcement_date: date):
    text = html_text(raw)
    match = BOE_TITLE_PATTERN.search(text)
    if not match:
        raise ValueError('BoE statement omitted a parseable Bank Rate result')
    action = {'maintained': 'maintain', 'increased': 'raise', 'reduced': 'lower'}[match.group('action').lower()]
    rate = float(match.group('rate'))
    change_bps = 0.0
    if action != 'maintain':
        # Restrict to the committee's adopted decision, before dissenting votes.
        change = re.search(r'Monetary Policy Committee\s*\(MPC\)\s+voted\s+(?:by a majority of\s+[\d–−-]+\s+|unanimously\s+)?to\s+(increase|reduce)\s+Bank Rate by\s+(\d+(?:\.\d+)?)\s+percentage points?,?\s+to\s+(\d+(?:\.\d+)?)%', text, re.I)
        if not change or float(change[3]) != rate or {'increase':'raise','reduce':'lower'}[change[1].lower()] != action:
            raise ValueError('BoE majority decision omitted a matching policy-change amount')
        change_bps = float(change[2]) * (100 if action == 'raise' else -100)
    return {'bankId': 'boe', 'bank': '英格兰银行', 'country': '英国', 'announcementDate': announcement_date.isoformat(), 'effectiveDate': announcement_date.isoformat(), 'lower': rate, 'upper': rate, 'midpoint': rate, 'action': action, 'changeBps': change_bps, 'statementUrl': statement_url, 'sourceName': '英格兰银行货币政策摘要与会议纪要'}


def find_latest_boe_statement(raw: bytes, today: date | None = None):
    today = today or datetime.now(timezone.utc).date()
    root = ElementTree.fromstring(raw)
    candidates = []
    for item in root.iter():
        if item.tag.rsplit('}', 1)[-1] != 'item':
            continue
        title = element_text(item, 'title')
        link = element_text(item, 'link')
        if not BOE_TITLE_PATTERN.search(title) or '/monetary-policy-summary-and-minutes/' not in link:
            continue
        published = element_text(item, 'pubDate')
        if not published:
            continue
        announced = parsedate_to_datetime(published).astimezone(timezone.utc)
        if announced.date() <= today:
            candidates.append((announced.date(), link, announced.isoformat()))
    if not candidates:
        raise ValueError('No current BoE monetary-policy summary found in official RSS')
    return max(candidates, key=lambda candidate: candidate[0])


def parse_ecb_current_decision(raw: bytes, statement_url: str):
    text = html_text(raw)
    date_match = ECB_DECISION_DATE_PATTERN.search(text)
    effective_match = ECB_EFFECTIVE_DATE_PATTERN.search(text)
    rate_match = ECB_DEPOSIT_PATTERN.search(text)
    if not date_match or not effective_match or not rate_match:
        raise ValueError('ECB current-decision page omitted a parseable date or deposit rate')
    announcement_date = datetime.strptime(date_match.group('date'), '%d %B %Y').date().isoformat()
    effective_date = datetime.strptime(effective_match.group('date'), '%d %B %Y').date().isoformat()
    rate = float(rate_match.group('rate'))
    return {'bankId': 'ecb', 'bank': '欧洲央行', 'country': '欧元区', 'announcementDate': announcement_date, 'effectiveDate': effective_date, 'lower': rate, 'upper': rate, 'midpoint': rate, 'action': 'maintain', 'changeBps': 0.0, 'statementUrl': statement_url, 'sourceName': '欧洲央行最新货币政策决议页（存款便利利率）'}


def parse_boc_current_decision(raw: bytes, statement_url: str):
    rows = BOC_ROW_PATTERN.findall(html_text(raw))
    if len(rows) < 2:
        raise ValueError('Bank of Canada current-rate page omitted recent decision rows')
    latest_date, latest_rate, _ = rows[0]
    _, prior_rate, _ = rows[1]
    rate, prior = float(latest_rate), float(prior_rate)
    difference = rate - prior
    return {'bankId': 'boc', 'bank': '加拿大银行', 'country': '加拿大', 'announcementDate': datetime.strptime(latest_date, '%B %d, %Y').date().isoformat(), 'effectiveDate': None, 'lower': rate, 'upper': rate, 'midpoint': rate, 'action': 'raise' if difference > 0 else 'lower' if difference < 0 else 'maintain', 'changeBps': difference * 100, 'statementUrl': statement_url, 'sourceName': '加拿大银行政策利率官方页面'}


def find_latest_rba_statement(raw: bytes, today: date | None = None):
    today = today or datetime.now(timezone.utc).date()
    soup = BeautifulSoup(raw, 'html.parser')
    candidates = []
    for link in soup.find_all('a', href=True):
        match = RBA_DATE_PATTERN.fullmatch(link.get_text(' ', strip=True))
        if not match or '/media-releases/' not in link['href']:
            continue
        published = datetime.strptime(f"{match.group('day')} {match.group('month')} {match.group('year')}", '%d %B %Y').date()
        if published <= today:
            candidates.append((published, urljoin('https://www.rba.gov.au', link['href'])))
    if not candidates:
        raise ValueError('No current RBA monetary-policy statement found')
    return max(candidates, key=lambda candidate: candidate[0])


def parse_rba_statement(raw: bytes, statement_url: str, announcement_date: date):
    match = RBA_DECISION_PATTERN.search(html_text(raw))
    if not match:
        raise ValueError('RBA statement omitted a parseable cash-rate result')
    action = {'leave': 'maintain', 'increase': 'raise', 'reduce': 'lower'}[match.group('action').lower()]
    rate = float(match.group('rate'))
    change_bps = 0.0
    if action != 'maintain':
        change = re.search(r'\bby\s+(\d+(?:\.\d+)?)\s+basis points?\b', match[0], re.I)
        if not change:
            raise ValueError('RBA adopted decision omitted a policy-change amount')
        change_bps = float(change[1]) * (1 if action == 'raise' else -1)
    return {'bankId': 'rba', 'bank': '澳大利亚储备银行', 'country': '澳大利亚', 'announcementDate': announcement_date.isoformat(), 'effectiveDate': announcement_date.isoformat(), 'lower': rate, 'upper': rate, 'midpoint': rate, 'action': action, 'changeBps': change_bps, 'statementUrl': statement_url, 'sourceName': '澳大利亚储备银行货币政策委员会声明'}


def latest_monthly_rate(bank_id: str):
    path = DATA / 'policy-rates.json'
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding='utf-8'))
    series = next((item for item in payload.get('series', []) if item.get('id') == bank_id), None)
    return float(series['latestValue']) if series and series.get('latestValue') is not None else None


def finalize_single_rate_decision(decision, raw: bytes, checked_at: str, source: str):
    """Attach audit fields without rewriting a decision using lagged monthly data."""
    digest, path = archive_raw(decision['announcementDate'] + '-statement', 'html', raw, source)
    decision['announcedAt'] = None
    decision['fetchedAt'] = checked_at
    decision['archive'] = {'statementSha256': digest, 'statementPath': path}
    return decision


def collect_boe_decision(checked_at: str):
    feed = download(BOE_RSS_URL)
    announcement_date, statement_url, announced_at = find_latest_boe_statement(feed)
    statement = download(statement_url)
    decision = parse_boe_statement(statement, statement_url, announcement_date)
    decision = finalize_single_rate_decision(decision, statement, checked_at, 'BOE_POLICY')
    decision['announcedAt'] = announced_at
    return decision


def collect_ecb_decision(checked_at: str):
    source_url = next(source['url'] for source in OFFICIAL_DECISION_SOURCES if source['bankId'] == 'ecb')
    raw = download(source_url)
    return finalize_single_rate_decision(parse_ecb_current_decision(raw, source_url), raw, checked_at, 'ECB_POLICY')


def collect_boc_decision(checked_at: str):
    source_url = next(source['url'] for source in OFFICIAL_DECISION_SOURCES if source['bankId'] == 'boc')
    raw = download(source_url)
    return finalize_single_rate_decision(parse_boc_current_decision(raw, source_url), raw, checked_at, 'BOC_POLICY')


def collect_rba_decision(checked_at: str):
    source_url = next(source['url'] for source in OFFICIAL_DECISION_SOURCES if source['bankId'] == 'rba')
    index = download(source_url)
    announcement_date, statement_url = find_latest_rba_statement(index)
    statement = download(statement_url)
    return finalize_single_rate_decision(parse_rba_statement(statement, statement_url, announcement_date), statement, checked_at, 'RBA_POLICY')


def find_latest_dated_policy_link(raw: bytes, bank_id: str, today: date | None = None):
    """Discover issuer-linked statements; dates are never invented from a calendar."""
    today = today or datetime.now(timezone.utc).date()
    base = 'https://www.snb.ch' if bank_id == 'snb' else 'https://www.rbi.org.in'
    pattern = r'Monetary policy assessment of (\d{1,2} [A-Z][a-z]+ 20\d{2})' if bank_id == 'snb' else r'Governor[’\']s Statement[:,]?\s*([A-Z][a-z]+\s+\d{1,2},\s*20\d{2})'
    candidates = []
    for link in BeautifulSoup(raw,'html.parser').find_all('a',href=True):
        match = re.fullmatch(pattern,link.get_text(' ',strip=True),re.I)
        if not match:
            continue
        published = datetime.strptime(match[1], '%d %B %Y' if bank_id == 'snb' else '%B %d, %Y').date()
        url = urljoin(base,link['href']);parsed=urlparse(url)
        if parsed.hostname not in ({'www.snb.ch','snb.ch'} if bank_id=='snb' else {'www.rbi.org.in','rbi.org.in'}):
            continue
        if published <= today:
            candidates.append((published,url))
    if not candidates:
        raise ValueError(bank_id.upper()+' index has no dated principal policy release')
    return max(candidates)


def parse_snb_statement(raw: bytes, statement_url: str, announcement_date: date):
    text = html_text(raw)
    if not re.search(r'Monetary policy assessment of\s+'+str(announcement_date.day)+r'\s+'+announcement_date.strftime('%B %Y'),text,re.I):
        raise ValueError('SNB statement date does not match its index')
    match = re.search(r'Swiss National Bank (?:is )?(leaves|leaving|raises|raising|lowers|lowering) (?:the )?SNB policy rate\s+(?:(unchanged)\s+at|by\s+(\d+(?:\.\d+)?)\s+percentage points?\s+to)\s+(-?\d+(?:\.\d+)?)\s*%',text,re.I)
    if not match:
        raise ValueError('SNB adopted policy-rate decision cannot be verified')
    action='maintain' if match[2] else 'raise' if match[1].lower().startswith('rais') else 'lower'
    rate=float(match[4]);change=0 if action=='maintain' else float(match[3])*(100 if action=='raise' else -100)
    return {'bankId':'snb','bank':'瑞士国家银行','country':'瑞士','announcementDate':announcement_date.isoformat(),'effectiveDate':None,'lower':rate,'upper':rate,'midpoint':rate,'action':action,'changeBps':change,'statementUrl':statement_url,'sourceName':'瑞士国家银行货币政策评估'}


def parse_rbi_statement(raw: bytes, statement_url: str, announcement_date: date):
    text = html_text(raw)
    dated = re.search(r'Date\s*:\s*([A-Z][a-z]+\s+\d{1,2},\s*20\d{2})',text)
    if not dated or datetime.strptime(dated[1],'%b %d, %Y').date()!=announcement_date:
        raise ValueError('RBI publication date does not match its index')
    match = re.search(r'(?:the )?MPC\s+(?:(?:unanimously\s+)?voted\s+(?:unanimously\s+|by a majority of\s+[\d–−-]+\s+)?)?(?:decided\s+)?to\s+(increase|reduce|keep|maintain)\s+the policy repo rate(?: under the liquidity adjustment facility \(LAF\))?\s+(?:unchanged\s+)?(?:by\s+(\d+(?:\.\d+)?)\s+(bps|basis points)\s+)?(?:to|at)\s+(\d+(?:\.\d+)?)\s+per cent',text,re.I)
    if not match:
        raise ValueError('RBI adopted repo-rate decision cannot be verified')
    action={'increase':'raise','reduce':'lower','keep':'maintain','maintain':'maintain'}[match[1].lower()]
    if action!='maintain' and not match[2]:
        raise ValueError('RBI policy change omitted its amount')
    rate=float(match[4]);change=0 if action=='maintain' else float(match[2])*(1 if action=='raise' else -1)
    return {'bankId':'rbi','bank':'印度储备银行','country':'印度','announcementDate':announcement_date.isoformat(),'effectiveDate':None,'lower':rate,'upper':rate,'midpoint':rate,'action':action,'changeBps':change,'statementUrl':statement_url,'sourceName':'印度储备银行货币政策行长声明（回购利率）'}


def parse_rbnz_history(raw: bytes, source_url: str, today: date | None = None):
    today=today or datetime.now(timezone.utc).date();rows=[]
    for row in BeautifulSoup(raw,'html.parser').find_all('tr'):
        cells=row.find_all(['td','th'])
        if len(cells)<3:
            continue
        label=cells[0].get_text(' ',strip=True);rate_text=cells[1].get_text(' ',strip=True)
        if not re.fullmatch(r'\d{1,2}\s+[A-Z][a-z]+\s+20\d{2}',label) or not re.fullmatch(r'\d+(?:\.\d+)?',rate_text):
            continue
        published=datetime.strptime(label,'%d %B %Y').date()
        link=cells[2].find('a',href=True);url=urljoin(source_url,link['href']) if link else source_url
        if published<=today and urlparse(url).hostname in {'www.rbnz.govt.nz','rbnz.govt.nz'}:
            rows.append((published,float(rate_text),url))
    rows=sorted(set(rows),reverse=True)
    if len(rows)<2:
        raise ValueError('RBNZ official OCR history requires two dated decision rows')
    (published,rate,url),(prior_date,prior_rate,prior_url)=rows[:2];change=round((rate-prior_rate)*100,8)
    return {'bankId':'rbnz','bank':'新西兰储备银行','country':'新西兰','announcementDate':published.isoformat(),'effectiveDate':None,'lower':rate,'upper':rate,'midpoint':rate,'action':'raise' if change>0 else 'lower' if change<0 else 'maintain','changeBps':change,'statementUrl':url,'sourceName':'新西兰储备银行官方OCR决议历史（公布后约24小时更新）','comparison':{'announcementDate':prior_date.isoformat(),'rate':prior_rate,'statementUrl':prior_url},'historySourceUrl':source_url}


def collect_snb_decision(checked_at: str):
    index_url=next(source['url'] for source in OFFICIAL_DECISION_SOURCES if source['bankId']=='snb')
    published,url=find_latest_dated_policy_link(download(index_url),'snb')
    raw=download(url)
    return finalize_single_rate_decision(parse_snb_statement(raw,url,published),raw,checked_at,'SNB_POLICY')


def collect_rbi_decision(checked_at: str):
    index_url=next(source['url'] for source in OFFICIAL_DECISION_SOURCES if source['bankId']=='rbi')
    published,url=find_latest_dated_policy_link(download(index_url),'rbi')
    raw=download(url)
    return finalize_single_rate_decision(parse_rbi_statement(raw,url,published),raw,checked_at,'RBI_POLICY')


def collect_rbnz_decision(checked_at: str):
    url=next(source['url'] for source in OFFICIAL_DECISION_SOURCES if source['bankId']=='rbnz')
    raw=download(url)
    return finalize_single_rate_decision(parse_rbnz_history(raw,url),raw,checked_at,'RBNZ_POLICY')


def find_boj_guidelines(raw: bytes, today: date | None = None):
    """Find official principal decisions, including unchanged-rate statements."""
    today = today or datetime.now(timezone.utc).date()
    soup = BeautifulSoup(raw, 'html.parser')
    candidates = []
    for row in soup.select('tr'):
        cells = row.find_all('td')
        if len(cells) < 2:
            continue
        link = cells[1].find('a', href=True)
        title = link.get_text(' ', strip=True) if link else ''
        if not (title.startswith('Change in the Guideline for Money Market Operations') or title.startswith('Statement on Monetary Policy')):
            continue
        match = BOJ_DATE_PATTERN.search(cells[0].get_text(' ', strip=True))
        if not match:
            continue
        month = match.group('month')[:3]
        published = datetime.strptime(f"{month} {match.group('day')} {match.group('year')}", '%b %d %Y').date()
        url = urljoin(BOJ_BASE_URL, link['href'])
        parsed = urlparse(url)
        if published <= today and parsed.hostname == 'www.boj.or.jp' and re.fullmatch(r'/en/mopo/mpmdeci/mpr_\d{4}/k\d{6}a\.pdf', parsed.path):
            candidates.append((published, url))
    if not candidates:
        raise ValueError('No current official BOJ money-market guideline found')
    return sorted(set(candidates), reverse=True)


def find_latest_boj_guideline(raw: bytes, today: date | None = None):
    return find_boj_guidelines(raw, today)[0]


def parse_boj_guideline_rate(text: str, announcement_date: date):
    """Read the adopted target before references, dissent, or a second section."""
    text = re.sub(r'(?<=\d)\s+(?=\d)', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if not re.search(re.escape(announcement_date.strftime('%B')) + r'\s+' + str(announcement_date.day) + r',\s*' + str(announcement_date.year), text[:250]):
        raise ValueError('BOJ document date does not match the official index')
    principal = re.split(r'\b2\.\s|\[Note\]\s*Voting|Voting against|\bReference\b', text, maxsplit=1, flags=re.I)[0]
    match = re.search(r'(?:Policy Board of the Bank of Japan|Bank of Japan).*?decided(?:,?\s+by\s+(?:a\s+)?[\d–−-]+\s+majority vote,?)?\s+to (?:set|maintain|change).*?guideline.*?The Bank will encourage the uncollateralized overnight call rate to (?:remain|be) at around\s+(-?\d+(?:\.\d+)?)\s+percent', principal, re.I)
    if not match or not -5 <= float(match[1]) <= 100:
        raise ValueError('BOJ adopted money-market target cannot be uniquely verified')
    return float(match[1])


def boj_document_rate(raw: bytes, url: str, published: date):
    text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(raw)).pages)
    if text.strip():
        return parse_boj_guideline_rate(text, published)
    return parse_boj_verified_guideline(raw, url, published)['midpoint']


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
    candidates = find_boj_guidelines(index)
    announcement_date, statement_url = candidates[0]
    statement = download(statement_url)
    if statement_url in BOJ_VERIFIED_GUIDELINES:
        decision = parse_boj_verified_guideline(statement, statement_url, announcement_date)
    else:
        rate = boj_document_rate(statement, statement_url, announcement_date)
        if len(candidates) < 2:
            raise ValueError('BOJ previous official decision is required to verify the change')
        prior_date, prior_url = candidates[1]
        prior_raw = download(prior_url)
        prior_rate = boj_document_rate(prior_raw, prior_url, prior_date)
        prior_hash, prior_path = archive_raw(prior_date.isoformat() + '-guideline', 'pdf', prior_raw, 'BOJ_POLICY')
        difference = round((rate - prior_rate) * 100, 8)
        decision = {'bankId':'boj','bank':'日本银行','country':'日本','announcementDate':announcement_date.isoformat(),'effectiveDate':None,'lower':rate,'upper':rate,'midpoint':rate,'action':'raise' if difference > 0 else 'lower' if difference < 0 else 'maintain','changeBps':difference,'statementUrl':statement_url,'sourceName':'日本银行货币政策声明','comparison':{'announcementDate':prior_date.isoformat(),'rate':prior_rate,'statementUrl':prior_url,'sha256':prior_hash,'path':prior_path}}
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


def check_official_source(source, checked_at, verified_ids, decisions=None, rate_errors=None):
    """Check a configured official source without inventing an unparsed rate."""
    prior=(decisions or {}).get(source['bankId']);verified=source['bankId'] in verified_ids
    result = {
        'bankId': source['bankId'], 'bank': source['bank'], 'country': source['country'],
        'sourceUrl': source['url'], 'checkedAt': checked_at,
        'status': 'ready', 'decisionStatus': 'verified' if verified else 'source_checked',
        'rateVerificationStatus':'verified' if verified else 'not_configured' if source['bankId'] not in PARSED_DECISION_BANKS else 'cached' if prior else 'fetch_failed',
        'latestVerifiedAt':prior.get('fetchedAt') if prior else None,
        'latestVerifiedAnnouncementDate':prior.get('announcementDate') if prior else None,
    }
    if (rate_errors or {}).get(source['bankId']):
        result['rateError']=rate_errors[source['bankId']]
    try:
        raw = download(source['url'])
        if not raw:
            raise ValueError('Official source returned no content')
    except Exception as exc:
        result['status'] = 'fetch_failed'
        result['error'] = str(exc)[-220:]
    return result


def check_all_official_sources(checked_at, verified_ids, decisions=None, rate_errors=None):
    """Check all configured official pages concurrently within the 15-minute run."""
    results = []
    with ThreadPoolExecutor(max_workers=6) as executor:
        pending = [executor.submit(check_official_source, source, checked_at, verified_ids, decisions, rate_errors) for source in OFFICIAL_DECISION_SOURCES]
        for future in as_completed(pending):
            results.append(future.result())
    return sorted(results, key=lambda item: item['bankId'])


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
    rate_errors = {}
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
        rate_errors['fed']=str(exc)
    try:
        decision = collect_boj_decision()
        prior_decisions['boj'] = decision
        updated.append('BOJ')
    except Exception as exc:
        errors.append(f'BOJ: {exc}')
        rate_errors['boj']=str(exc)
    for code, collector in [('BOE', collect_boe_decision), ('ECB', collect_ecb_decision), ('BOC', collect_boc_decision), ('RBA', collect_rba_decision), ('SNB', collect_snb_decision), ('RBI', collect_rbi_decision), ('RBNZ', collect_rbnz_decision)]:
        try:
            decision = collector(checked_at)
            prior_decisions[decision['bankId']] = decision
            updated.append(code)
        except Exception as exc:
            errors.append(f'{code}: {exc}')
            rate_errors[code.lower()]=str(exc)
    checks = check_all_official_sources(checked_at, {code.lower() for code in updated}, prior_decisions, rate_errors)
    failed_checks = [item for item in checks if item['status'] == 'fetch_failed']
    if failed_checks:
        errors.extend(f"{item['bankId'].upper()} source: {item['error']}" for item in failed_checks)
    if updated:
        payload = {
            'generatedAt': checked_at,
            'checkedAt': checked_at,
            'status': 'ready',
            'source': source,
            'decisions': [prior_decisions[key] for key in sorted(prior_decisions)],
            'checks': checks,
            **({'error': '; '.join(errors)} if errors else {}),
        }
    elif prior:
        payload = {**prior, 'checkedAt': checked_at, 'status': 'cached', 'checks': checks, 'error': '; '.join(errors)}
    else:
        payload = {'generatedAt': checked_at, 'checkedAt': checked_at, 'status': 'fetch_failed', 'source': source, 'decisions': [], 'checks': checks, 'error': '; '.join(errors)}
    atomic_write(path, payload)
    print(f"POLICY_DECISIONS {'OK' if updated else 'FAILED'} {' '.join(updated)}", flush=True)
    return payload


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.parse_args()
    collect_policy_decisions()
