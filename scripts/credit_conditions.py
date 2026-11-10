"""Parsers and cadence for public Federal Reserve credit research data."""
import csv
import io
import math
import urllib.request
from datetime import datetime, timedelta

EBP_URL = 'https://www.federalreserve.gov/econres/notes/feds-notes/ebp_csv.csv'
EBP_PAGE = 'https://www.federalreserve.gov/econres/notes/feds-notes/updating-the-recession-risk-and-the-excess-bond-premium-20161006.html'
SLOOS_IDS = ('DRTSCILM', 'DRTSCIS')


def download_ebp():
    """Fetch in-process so this source never starts a console subprocess."""
    request=urllib.request.Request(EBP_URL,headers={'User-Agent':'Mozilla/5.0 (compatible; AI-Macro-Chain-Monitor/1.0)'})
    with urllib.request.urlopen(request,timeout=65) as response:
        return response.read()


def parse_ebp(raw):
    """Use the EBP component in percentage points, never GZ spread or recession odds."""
    rows = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
    if not rows.fieldnames or 'date' not in rows.fieldnames or 'ebp' not in rows.fieldnames:
        raise ValueError('Unexpected Fed EBP CSV header')
    points = []
    seen = set()
    for row in rows:
        date = row['date'].strip()
        parsed = datetime.strptime(date, '%Y-%m-%d')
        if parsed.day != 1 or date in seen:
            raise ValueError('EBP must have one observation per calendar month')
        seen.add(date)
        value = row['ebp'].strip()
        number = None if value in ('', '.', 'NA', 'NaN') else float(value)
        if number is not None and (not math.isfinite(number) or not -100 < number < 100):
            raise ValueError('Invalid EBP percentage-point value')
        points.append({'date': date, 'value': number})
    if not points or not any(p['value'] is not None for p in points):
        raise ValueError('Empty Fed EBP history')
    return sorted(points, key=lambda p: p['date'])


def source_check_plan(key, series, now):
    """No exact release time is invented for research/monthly or date-only feeds.

    EBP usually follows the fourth business day, but the Fed explicitly allows
    blackout and source-data delays. Check daily, and more often in early-month
    release windows. SLOOS actual publication times use its FRED calendar.
    """
    failed = series.get('status') in ('cached', 'fetch_failed')
    hours = 0.5 if failed else 6 if key == 'DHHNGSP' or now.day <= 10 else 24
    checked = datetime.fromisoformat(series.get('checkedAt') or '2000-01-01T00:00:00+00:00')
    interval = timedelta(hours=hours)
    source = EBP_PAGE if key == 'EBP' else 'https://fred.stlouisfed.org/releases/calendar?rid=342'
    return now - checked >= interval, {
        'state': 'source_check',
        'nextCheckAt': max(now, checked + interval).isoformat(),
        'calendarSource': source,
        'calendarStatus': 'source_dependent' if key == 'EBP' else 'date_only',
        'checkIntervalMinutes': int(interval.total_seconds() / 60),
    }
