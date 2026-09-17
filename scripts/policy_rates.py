"""Collect comparable central-bank policy rates from the BIS public SDMX API.

The display cache is intentionally monthly end-of-period data.  It lets the
calendar compare policy settings across countries without pretending that
different central banks announce decisions at the same time of day.
"""
import argparse
import csv
import hashlib
import io
import json
import os
import pathlib
from datetime import datetime, timedelta, timezone

from collect import DATA, download

SOURCE_URL = 'https://data.bis.org/topics/CBPOL'
# Ten years covers the selectable comparison windows while keeping BIS's
# metadata-heavy CSV request bounded for unattended scheduled runs.
API_URL = 'https://stats.bis.org/api/v1/data/WS_CBPOL/M.US+JP+KR+XM+GB+CA+AU+NZ+CH+CN+RU+IN+BR+ZA?startPeriod=2016-01&format=csvfile'
SERIES = {
    'US': {'id': 'fed', 'name': '美联储', 'country': '美国', 'shortName': 'FOMC', 'sourceUrl': 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'},
    'JP': {'id': 'boj', 'name': '日本银行', 'country': '日本', 'shortName': 'BOJ', 'sourceUrl': 'https://www.boj.or.jp/en/mopo/mpmsche_minu/'},
    'KR': {'id': 'bok', 'name': '韩国银行', 'country': '韩国', 'shortName': 'BOK', 'sourceUrl': 'https://www.bok.or.kr/eng/main/contents.do?menuNo=400020'},
    'XM': {'id': 'ecb', 'name': '欧洲央行', 'country': '欧元区', 'shortName': 'ECB', 'sourceUrl': 'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html'},
    'GB': {'id': 'boe', 'name': '英格兰银行', 'country': '英国', 'shortName': 'BoE', 'sourceUrl': 'https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates'},
    'CA': {'id': 'boc', 'name': '加拿大银行', 'country': '加拿大', 'shortName': 'BoC', 'sourceUrl': 'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/'},
    'AU': {'id': 'rba', 'name': '澳大利亚储备银行', 'country': '澳大利亚', 'shortName': 'RBA', 'sourceUrl': 'https://www.rba.gov.au/monetary-policy/int-rate-decisions/'},
    'NZ': {'id': 'rbnz', 'name': '新西兰储备银行', 'country': '新西兰', 'shortName': 'RBNZ', 'sourceUrl': 'https://www.rbnz.govt.nz/monetary-policy/monetary-policy-decisions'},
    'CH': {'id': 'snb', 'name': '瑞士国家银行', 'country': '瑞士', 'shortName': 'SNB', 'sourceUrl': 'https://www.snb.ch/en/the-snb/mandates-goals/monetary-policy/decisions'},
    'CN': {'id': 'pboc', 'name': '中国人民银行', 'country': '中国', 'shortName': 'PBoC', 'sourceUrl': 'https://www.pbc.gov.cn/'},
    'RU': {'id': 'cbr', 'name': '俄罗斯银行', 'country': '俄罗斯', 'shortName': 'CBR', 'sourceUrl': 'https://cbr.ru/eng/hd_base/KeyRate/'},
    'IN': {'id': 'rbi', 'name': '印度储备银行', 'country': '印度', 'shortName': 'RBI', 'sourceUrl': 'https://www.rbi.org.in/Scripts/Annualpolicy.aspx'},
    'BR': {'id': 'bcb', 'name': '巴西中央银行', 'country': '巴西', 'shortName': 'BCB', 'sourceUrl': 'https://www.bcb.gov.br/en/monetarypolicy/committee'},
    'ZA': {'id': 'sarb', 'name': '南非储备银行', 'country': '南非', 'shortName': 'SARB', 'sourceUrl': 'https://www.resbank.co.za/en/home/what-we-do/monetary-policy/monetary-policy-committee'},
}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def atomic_write(path: pathlib.Path, payload: dict):
    temporary = path.with_suffix('.tmp.json')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    os.replace(temporary, path)


def parse_policy_rates(raw: bytes):
    rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    required = {'FREQ', 'REF_AREA', 'TIME_PERIOD', 'OBS_VALUE', 'TITLE'}
    if not rows or not required.issubset(rows[0]):
        raise ValueError('BIS policy-rate CSV header changed')
    result = []
    for area, meta in SERIES.items():
        selected = [row for row in rows if row.get('FREQ') == 'M' and row.get('REF_AREA') == area and row.get('OBS_VALUE', '').strip()]
        points = []
        seen = set()
        for row in selected:
            period = row['TIME_PERIOD']
            if len(period) != 7 or period[4] != '-' or period in seen:
                raise ValueError(f'Invalid or duplicate BIS month for {area}')
            try:
                datetime.strptime(period + '-01', '%Y-%m-%d')
            except ValueError as exc:
                raise ValueError(f'Invalid BIS month for {area}') from exc
            seen.add(period)
            value = float(row['OBS_VALUE'])
            if not -50 < value < 100:
                raise ValueError(f'Invalid BIS rate for {area}')
            points.append({'date': period + '-01', 'value': value})
        points.sort(key=lambda point: point['date'])
        if len(points) < 24:
            raise ValueError(f'BIS policy-rate history too short for {area}')
        result.append({
            **meta,
            'sourceArea': area,
            'sourceTitle': selected[-1]['TITLE'],
            'observations': points,
            'latestObservationDate': points[-1]['date'],
            'latestValue': points[-1]['value'],
            'status': 'ready',
        })
    return result


def collect_policy_rates(force=False, import_file=None):
    path = DATA / 'policy-rates.json'
    prior = json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
    checked_at = utc_now()
    expected_ids = {meta['id'] for meta in SERIES.values()}
    prior_ids = {item.get('id') for item in (prior or {}).get('series', [])}
    if not force and prior and prior.get('checkedAt') and prior_ids == expected_ids and prior.get('source', {}).get('apiUrl') == API_URL:
        previous = datetime.fromisoformat(prior['checkedAt'])
        if datetime.now(timezone.utc) - previous < timedelta(hours=20):
            return prior
    try:
        raw = pathlib.Path(import_file).read_bytes() if import_file else download(API_URL)
        digest = hashlib.sha256(raw).hexdigest()
        archive = DATA / 'versions' / 'POLICY_RATES'
        archive.mkdir(parents=True, exist_ok=True)
        raw_path = archive / f'{digest}.csv'
        if not raw_path.exists():
            raw_path.write_bytes(raw)
        series = parse_policy_rates(raw)
        payload = {
            'generatedAt': checked_at,
            'checkedAt': checked_at,
            'status': 'ready',
            'source': {'name': 'BIS 中央银行政策利率', 'url': SOURCE_URL, 'apiUrl': API_URL, 'frequency': '月度期末', 'unit': '年利率，%'},
            'series': series,
            'archive': {'sha256': digest, 'path': f'data/versions/POLICY_RATES/{digest}.csv'},
        }
        atomic_write(path, payload)
        print('POLICY_RATES OK', ', '.join(f"{item['sourceArea']} {item['latestObservationDate']}" for item in series), flush=True)
        return payload
    except Exception as exc:
        if prior:
            payload = {**prior, 'checkedAt': checked_at, 'status': 'cached', 'error': str(exc)}
            for item in payload.get('series', []):
                item['status'] = 'cached'
            atomic_write(path, payload)
            print('POLICY_RATES FAILED; retained cache', flush=True)
            return payload
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--import-file')
    args = parser.parse_args()
    collect_policy_rates(args.force, args.import_file)
