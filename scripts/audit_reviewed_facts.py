"""Small, version-bound public-source extracts for historical audit samples."""
import hashlib
import json
from functools import lru_cache
from pathlib import Path


def evidence_key(definition, point):
    # Fetch timestamps may change even when the dated inputs do not.
    fields = ('periodStart', 'periodEnd', 'fiscalPeriod', 'sourceUrl', 'version',
              'publishedAt', 'sourceDocumentVersion', 'originalValue', 'originalItems',
              'formula', 'originalUnit', 'originalCurrency', 'reportingScope', 'value')
    identity = {key: point.get(key) for key in fields}
    identity.update(metricId=definition['id'], unit=definition['unit'], currency=definition.get('currency'))
    data = json.dumps(identity, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
    return hashlib.sha256(data).hexdigest()


@lru_cache(None)
def facts():
    path = Path(__file__).resolve().parents[1] / 'docs/industry/reviewed-audit-facts.json'
    return {(fact['metricId'], report['periodEnd']): (report, fact)
            for report in json.loads(path.read_text(encoding='utf-8'))['reports'] for fact in report['facts']}


def reviewed_fact(definition, point):
    match = facts().get((definition['id'], point['periodEnd']))
    if match is None:
        return None
    report, fact = match
    if fact['evidenceKey'] != evidence_key(definition, point):
        return None
    assert point['sourceUrl'] == report['observationSourceUrl']
    assert point.get('fiscalPeriod') == report.get('fiscalPeriod')
    if fact['sourceUnit'] == '%':
        expected = fact['current']
        assert definition['unit'] == '%' and definition.get('currency') is None
    elif definition['id'] == 'AMKR.capex':
        base = fact.get('base', 0)
        assert fact['sourceUnit'] == 'USD thousand'
        assert point['originalItems']['baseYtdThousandUsd'] == base
        assert point['originalItems']['currentYtdThousandUsd'] == fact['current']
        if base:
            assert point['originalItems']['baseUrl'] == fact['baseSourceUrl']
        expected = (fact['current'] - base) / 100000
    else:
        assert fact['sourceUnit'] == definition['currency'] + ' million'
        sign = -1 if definition['id'] == 'ENTG.capex' else 1
        expected = sign * fact['current'] / 100
    assert expected == point['value'], (definition['id'], expected, point['value'])
    return 'reviewed official dated table: ' + report['reviewedSourceUrl'] + ' | ' + fact['row'] + ' | ' + fact['sourceUnit']
