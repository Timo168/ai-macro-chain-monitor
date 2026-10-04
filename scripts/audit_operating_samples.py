"""Independently audit 3 official raw-file points for every operating-sample metric.

No requests, model calls, subprocesses, or imports from the collector parsers.
Only source facts and SHA256 references are published, never report bodies.
"""
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data' / 'industry'
METRICS = {
    'packaging-evidence.json': ['AMKR.advanced_products_revenue', 'AMKR.company_revenue',
                                'AMKR.gross_margin', 'AMKR.materials_cost_share', 'AMKR.capex'],
    'materials-evidence.json': ['ENTG.company_revenue', 'ENTG.gross_margin', 'ENTG.capex'],
}


def source_bytes(url, expected_hash=None):
    meta_path = DATA / 'raw' / (hashlib.sha256(url.encode()).hexdigest() + '.meta.json')
    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    raw = (DATA / 'raw' / meta['file']).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    assert digest == meta['hash'], 'Archived official byte checksum mismatch'
    if expected_hash:
        assert digest == expected_hash, 'Saved observation source version differs from raw bytes'
    assert not raw.startswith(b'%PDF'), 'Selected audit point is PDF: add independent PDF audit before claiming success'
    return BeautifulSoup(raw, 'html.parser'), digest


def rows(table):
    return [[cell.get_text(' ', strip=True) for cell in row.find_all(['td', 'th'], recursive=False)]
            for row in table.find_all('tr') if not row.find('table')]


def first_amount(row):
    values = [x for x in row[1:] if x.strip() and x.strip() != '$']
    assert values and values[0].strip() not in ['—', '–', '-'], 'Current column is missing'
    value = values[0].strip().replace('$', '').replace(',', '').replace('%', '')
    if value.startswith('(') and not value.endswith(')'):
        assert len(values) > 1 and values[1].strip() == ')', 'Unpaired financial parentheses'
        value += ')'
    negative = value.startswith('(') and value.endswith(')')
    return float(value.strip('()')) * (-1 if negative else 1)


def named_row(table, label):
    matches = [row for row in rows(table) if row and re.fullmatch(label, row[0], re.I)]
    assert len(matches) == 1, 'Requested report row not unique'
    return matches[0]


def amkor_cash(soup, year, quarter):
    candidates = [table for table in soup.find_all('table')
                  if any(row and row[0] == 'Payments for property, plant and equipment' for row in rows(table))]
    assert len(candidates) == 1
    table = candidates[0]
    text = ' '.join(table.get_text(' ', strip=True).split())
    assert 'In thousands' in text
    span = ['Three Months', 'Six Months', 'Nine Months', 'Years'][quarter - 1]
    assert span.lower() in text.lower()
    assert re.search(r'\b20\d\d\b', text)[0] == str(year)
    value = first_amount(named_row(table, 'Payments for property, plant and equipment'))
    assert value <= 0
    return -value


def amkor(metric, point, soup):
    fiscal = re.fullmatch(r'FY(\d{4}) Q([1-4])', point['fiscalPeriod'])
    year, quarter = map(int, fiscal.groups())
    if metric == 'AMKR.capex':
        current = amkor_cash(soup, year, quarter)
        evidence = [{'sourceUrl': point['sourceUrl'], 'quarterlyBasis': f'{quarter * 3} months YTD',
                     'sourceValue': current, 'sourceUnit': 'USD thousand'}]
        base = 0
        if quarter > 1:
            inputs = point['originalItems']
            baseline, digest = source_bytes(inputs['baseUrl'], inputs['baseVersion'])
            base = amkor_cash(baseline, year, quarter - 1)
            assert base == inputs['baseYtdThousandUsd']
            evidence.append({'sourceUrl': inputs['baseUrl'], 'sourceByteSha256': digest,
                             'quarterlyBasis': f'{(quarter - 1) * 3} months YTD',
                             'sourceValue': base, 'sourceUnit': 'USD thousand'})
        assert current >= base
        return (current - base) / 100000, 'Adjacent same-fiscal-year actual YTD PPE difference / 100000', evidence
    label = {'AMKR.advanced_products_revenue': r'Advanced products\s*\(1\)',
             'AMKR.company_revenue': 'Total net sales', 'AMKR.gross_margin': 'Gross margin',
             'AMKR.materials_cost_share': 'Materials'}[metric]
    table = next(table for table in soup.find_all('table')
                 if any(row and re.fullmatch(r'Advanced products\s*\(1\)', row[0]) for row in rows(table)))
    text = ' '.join(table.get_text(' ', strip=True).split())
    assert re.findall(r'Q([1-4])\s+(20\d\d)', text)[0] == (str(quarter), str(year))
    assert 'Net sales (in millions)' in text
    amount = first_amount(named_row(table, label))
    percent = metric in ['AMKR.gross_margin', 'AMKR.materials_cost_share']
    return amount if percent else amount / 100, 'Actual first fiscal-quarter column; percentage unchanged or USD million / 100', []


def date_from_cell(cell):
    for fmt in ['%b %d, %Y', '%B %d, %Y']:
        try:
            return datetime.strptime(cell, fmt).date().isoformat()
        except ValueError:
            pass
    raise AssertionError('Official column date unrecognized')


def entg(metric, point, soup):
    cash = metric == 'ENTG.capex'
    if cash:
        table = next(table for table in soup.find_all('table')
                     if 'Condensed Consolidated Statements of Cash Flows' in table.get_text())
    else:
        table = next(table for table in soup.find_all('table')
                     if any(row and row[0] == 'GAAP Results' for row in rows(table)))
    table_rows = rows(table)
    if cash:
        index = next(i for i, row in enumerate(table_rows) if 'Three months ended' in row)
        groups = [x for x in table_rows[index] if x]
        assert groups[0] == 'Three months ended', 'YTD must not occupy the current quarter column'
        dates = next([x for x in row if re.fullmatch(r'[A-Z][a-z]+ \d{1,2}, 20\d\d', x)]
                     for row in table_rows[index + 1:index + 4]
                     if any(re.fullmatch(r'[A-Z][a-z]+ \d{1,2}, 20\d\d', x) for x in row))
        assert date_from_cell(dates[0]) == point['periodEnd']
        row = named_row(table, r'Acquisition of property,(?: plant and equipment)|Acquisition of property and equipment')
        amount = first_amount(row)
        assert amount <= 0
    else:
        index = next(i for i, row in enumerate(table_rows) if row and row[0] == 'GAAP Results')
        assert date_from_cell(table_rows[index][1]) == point['periodEnd']
        end = next((i for i, row in enumerate(table_rows[index + 1:], index + 1) if row and row[0] == 'Non-GAAP Results'), len(table_rows))
        label = 'Gross margin - as a % of net sales' if metric.endswith('gross_margin') else 'Net sales'
        matches = [r for r in table_rows[index:end] if r and r[0] == label]
        assert len(matches) == 1
        amount = first_amount(matches[0])
    if metric.endswith('gross_margin'):
        return amount, 'GAAP actual current-quarter percentage; adjusted and guidance excluded', []
    text = ' '.join(table.get_text(' ', strip=True).split())
    unit = re.search(r'\bin (thousands|millions)\b', text[:800], re.I)
    if not unit and not cash:
        # These official summary tables place the unit in the preceding caption.
        caption = table.find_previous(string=re.compile(r'\(in (thousands|millions), except percentages and per share data\)', re.I))
        assert caption is not None, 'Actual GAAP summary unit caption missing'
        unit = re.search(r'\bin (thousands|millions)\b', str(caption), re.I)
    assert unit, 'Source table unit unverified'
    divisor = 100000 if unit[1].lower() == 'thousands' else 100
    return (-amount if cash else amount) / divisor, f'Actual three-month current column; USD {unit[1]} / {divisor}; cash outflow sign normalized' if cash else f'GAAP actual current-quarter revenue; USD {unit[1]} / {divisor}', []


def run():
    checks = []
    for filename, metrics in METRICS.items():
        data = json.loads((DATA / filename).read_text(encoding='utf-8'))
        for metric in metrics:
            observations = data['series'][metric]['observations']
            assert len(observations) >= 3
            for index in [0, len(observations) // 2, len(observations) - 1]:
                point = observations[index]
                soup, digest = source_bytes(point['sourceUrl'], point.get('sourceDocumentVersion'))
                value, rule, operands = (amkor if metric.startswith('AMKR.') else entg)(metric, point, soup)
                assert abs(value - point['value']) < 1e-8, (metric, point['periodEnd'], value, point['value'])
                checks.append({'metricId': metric, 'periodEnd': point['periodEnd'], 'fiscalPeriod': point['fiscalPeriod'],
                               'storedValue': point['value'], 'recomputedValue': value, 'passed': True, 'rule': rule,
                               'sourceUrl': point['sourceUrl'], 'sourceByteSha256': digest, 'observationVersion': point['version'],
                               'publishedAt': point['publishedAt'], 'fetchedAt': point['fetchedAt'], 'additionalOperands': operands})
    result = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'checked': len(checks), 'passed': len(checks),
              'method': 'Independently re-read actual official source-file rows, dated columns, amount units and cash-flow operands; no collector parser reuse',
              'scope': 'Issuer operating samples. Amkor advanced products include non-AI uses; profitability and cash PPE are company-wide. Entegris is consolidated, not AI-only or the entire materials market.',
              'points': checks}
    output = ROOT / 'docs' / 'industry' / 'operating-samples-verification.json'
    output.write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(f'Official operating-sample points independently verified: {len(checks)}')


if __name__ == '__main__':
    run()
