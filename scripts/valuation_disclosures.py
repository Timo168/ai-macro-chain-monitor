"""Issuer EPS history for valuation, using actual quarterly release links.

Quarterly diluted EPS has its own share denominator. It is never presented as
historical shares outstanding, net income / market cap, or a price forecast.
"""
import json
import re
from datetime import date

from industry_common import DATA
from industry_collect import html_tables
import industry_packaging as packaging
import industry_materials as materials

VERSION = 'issuer-valuation-eps-1.1.0'


def first_value(row):
    """Read the first actual cell, never skip a missing current value."""
    cells = row[1:]
    if cells and cells[0] == '':
        cells = cells[1:]  # issuer summary's single spacer column
    if cells and cells[0] == '$':
        cells = cells[1:]
    if not cells or cells[0].strip() in ('', '-', '—', '–', 'N/A'):
        raise ValueError('Current actual EPS / income column is missing')
    if cells[0] == '(':
        if len(cells) < 3 or cells[2] != ')':
            raise ValueError('Actual negative number has malformed parentheses')
        return -materials.parse_number(cells[1])
    return materials.parse_number(cells[0])


def parse_eps(raw, entity, point):
    soup, tables = html_tables(raw)
    if entity == 'AMKR':
        end = date.fromisoformat(point['periodEnd'])
        identity = packaging.parse_release(raw, {'year': end.year, 'quarter': (end.month - 1) // 3 + 1,
                                                 'end': point['periodEnd'], 'url': point['sourceUrl']})
        candidates = [t for t in tables if any(r and r[0] == 'Earnings per diluted share' for r in t)]
        if len(candidates) != 1:
            raise ValueError('Amkor actual diluted EPS summary not unique')
        table = candidates[0]
        headers = re.findall(r'Q([1-4])\s+(20\d\d)', ' '.join(' '.join(r) for r in table[:4]))
        if not headers or headers[0] != (str(identity['quarter']), str(identity['year'])):
            raise ValueError('Amkor actual first-quarter column mismatch')
        value = first_value(next(r for r in table if r and r[0] == 'Earnings per diluted share'))
        if not re.search(r'\$ in millions, except per share data', ' '.join(' '.join(r) for r in table[:4])):
            raise ValueError('Amkor summary currency and income unit unverified')
        income = first_value(next(r for r in table if r and r[0] == 'Net income attributable to Amkor')) * 1e6
        published = identity['publishedAt']
    elif entity == 'ENTG':
        candidates = [t for t in tables if any(r and r[0] == 'GAAP Results' for r in t)]
        if len(candidates) != 1:
            raise ValueError('Entegris GAAP actual results table not unique')
        table = candidates[0]
        table = table[next(i for i, row in enumerate(table) if row and row[0] == 'GAAP Results'):]
        if len(table[0]) < 2 or materials.parse_date(table[0][1]) != point['periodEnd']:
            raise ValueError('Entegris actual first-quarter date mismatch')
        # Headline GAAP rows precede the Non-GAAP section. Never search forward
        # into guidance or take the next year's/quarter's available EPS column.
        actual = table[:next((i for i, row in enumerate(table) if row and row[0] == 'Non-GAAP Results'), len(table))]
        rows = [r for r in actual if r and re.fullmatch(r'Diluted earnings(?: \(loss\))? per common share', r[0])]
        if len(rows) != 1 or len(rows[0]) < 2:
            raise ValueError('Entegris GAAP actual diluted EPS missing')
        value = materials.parse_number(rows[0][1])
        summary_element = next(t for t in soup.find_all('table') if any(r and r[0] == 'GAAP Results' for r in materials.html_rows(t)))
        _, scale = materials.table_unit(summary_element)
        income_rows = [r for r in actual if r and r[0] in ('Net income', 'Net income (loss)')]
        if len(income_rows) != 1 or len(income_rows[0]) != 4:
            raise ValueError('Entegris current GAAP net income not unique')
        income = materials.parse_number(income_rows[0][1]) * scale * 1e6
        # Identity / publication was source-validated by the operating collector;
        # this parser additionally requires the same release title and issuer.
        title = ' '.join(h.get_text(' ', strip=True) for h in soup.find_all(['title', 'h1', 'h2']))
        text = ' '.join(soup.get_text(' ', strip=True).split())
        identity = materials.release_identity(title, text, point['publishedAt'][:10])
        if identity['periodEnd'] != point['periodEnd']:
            raise ValueError('Entegris actual fiscal period mismatch')
        published = point['publishedAt']
    else:
        raise ValueError('Issuer EPS parser not configured')
    if abs(value) > 100:
        raise ValueError('EPS outside parser verification bounds')
    return {'periodEnd': point['periodEnd'], 'publishedAt': published, 'value': value,
            'currency': 'USD', 'unit': 'USD per diluted share', 'sourceUrl': point['sourceUrl'],
            'netIncome': income, 'parserVersion': VERSION, 'basis': 'official_reported_quarter_diluted_eps'}


def collect_eps(entity, previous=None):
    previous = previous or {}
    name = {'AMKR': 'packaging-evidence.json', 'ENTG': 'materials-evidence.json'}.get(entity)
    if not name:
        return {'status': 'not_configured', 'observations': []}
    path = DATA / name
    if not path.exists():
        return {**previous, 'status': 'cached' if previous.get('observations') else 'not_configured',
                'error': 'Official operating disclosures have not been collected'}
    payload = json.loads(path.read_text(encoding='utf-8'))
    source = payload.get('series', {}).get(entity + '.company_revenue', {})
    rows = {(p['periodEnd'], p.get('availableAt', p['publishedAt'])): p for p in previous.get('observations', [])}
    errors = []
    fetch = packaging.fetch_source if entity == 'AMKR' else materials.fetch_source
    for point in source.get('observations', []):
        try:
            raw, fetched, version = fetch(point['sourceUrl'])
            parsed = parse_eps(raw, entity, point)
            prior = max((p for p in rows.values() if p['periodEnd'] == parsed['periodEnd']), key=lambda p: p.get('availableAt', p['publishedAt']), default=None)
            # Original release dates cannot make a later detected numeric
            # revision appear known in the past. Keep both historical versions.
            changed = prior and (prior['value'] != parsed['value'] or prior.get('netIncome') not in (None, parsed['netIncome']))
            available = fetched if changed else prior.get('availableAt', prior['publishedAt']) if prior else parsed['publishedAt']
            row = {**parsed, 'availableAt': available, 'isRestated': bool(changed or prior and prior.get('isRestated')), 'fetchedAt': fetched, 'version': version}
            rows[(parsed['periodEnd'], available)] = row
        except Exception as error:
            errors.append(point['periodEnd'] + ': ' + str(error)[:150])
    # A source collection failure remains visible even when parsing cached pages
    # succeeds, so an old latest release cannot masquerade as newly confirmed.
    if source.get('status') not in ('ready', 'reviewed'):
        errors.append(source.get('error') or 'Official operating source currently uses cached disclosures')
    return {'status': 'cached' if rows and errors else 'fetch_failed' if errors else 'ready' if rows else 'unpublished',
            'observations': [rows[k] for k in sorted(rows)], 'error': '; '.join(errors[:3]) or None,
            'method': 'Four actual publicly released quarterly GAAP diluted EPS values; each quarterly EPS uses its own diluted share denominator and issuer rounding. Not adjusted EPS. Detected revisions are usable only from their retrieval date.'}
