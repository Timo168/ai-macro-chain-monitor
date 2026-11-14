"""Check Dell amounts against the dated quarter columns in its earnings releases."""
import math

from industry_collect import html_tables, row_numbers
from industry_dell_source import requested_period, validate_report
from industry_hardware import dates


def verify(definition, point, raw):
    kind = definition['id'].split('.')[1]
    period = requested_period(point['sourceUrl'])
    assert period, 'Unrecognized Dell fiscal release'
    validate_report(raw, point['sourceUrl'], period)
    tables = html_tables(raw)[1]
    if kind == 'inventory':
        table = next(t for t in tables if row_numbers(t, 'Inventories'))
    elif kind in ('revenue', 'gross_margin'):
        table = next(t for t in tables if row_numbers(t, 'Total net revenue') and row_numbers(t, 'Gross margin'))
    else:
        table = next(t for t in tables if row_numbers(t, 'Servers and networking') or row_numbers(t, 'AI-optimized servers'))
    header = ' '.join(' '.join(row) for row in table[:8]).lower()
    assert 'millions' in header, 'Missing USD million table header'
    # In Q4 the last columns are full years and can have the same end dates.
    ends = dates(table)[:2]
    column = ends.index(point['periodEnd'])
    if kind != 'inventory':
        assert 'three months ended' in header
        assert point['fiscalPeriod'] == f'FY{period[0] - column} Q{period[1]}'
    items = point['originalItems']

    def amount(label, key):
        value = row_numbers(table, label)[column]
        assert value == items[key], (definition['id'], key, point['periodEnd'])
        return value

    if kind == 'gross_margin':
        assert definition['unit'] == '%'
        expected = amount('Gross margin', 'Gross profit USD million') / amount('Total net revenue', 'Revenue USD million') * 100
    else:
        assert definition['unit'] == '亿美元' and definition['currency'] == 'USD'
        labels = {'inventory': 'Inventories', 'revenue': 'Total net revenue',
                  'storage_revenue': 'Storage', 'ai_server_revenue': 'AI-optimized servers',
                  'server_revenue': 'Traditional servers and networking',
                  'servers_networking_revenue': 'Servers and networking'}
        label = labels[kind]
        if kind == 'servers_networking_revenue' and not row_numbers(table, label):
            combined = amount('AI-optimized servers', 'ai_server_million') + amount('Traditional servers and networking', 'traditional_server_million')
            assert combined == items[label + ' USD million']
            expected = combined / 100
        else:
            expected = amount(label, label + ' USD million') / 100
    assert math.isclose(expected, point['value'], rel_tol=1e-10, abs_tol=1e-10), (definition['id'], expected, point['value'])
    return 'matched dated Dell fiscal table, original line amounts and unit conversion'
