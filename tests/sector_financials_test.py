"""Source semantics and failure-boundary tests for actual sector financials."""
import json
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import industry_sector_financials as adapter


def fact(start, end, value, *, tag='RevenueFromContractWithCustomerExcludingAssessedTax', filed='2026-07-30', accession='0000000000-26-000001', form='10-Q'):
    return {'start': start, 'end': end, 'val': value, 'tag': tag, 'filed': filed, 'accn': accession, 'form': form, 'fy': 2026, 'fp': 'Q2'}


def payload(revenue, cost=None, gross=None, cik=723125):
    tags = {'RevenueFromContractWithCustomerExcludingAssessedTax': {'units': {'USD': revenue}}}
    if cost is not None:
        tags['CostOfRevenue'] = {'units': {'USD': cost}}
    if gross is not None:
        tags['GrossProfit'] = {'units': {'USD': gross}}
    return json.dumps({'cik': cik, 'facts': {'us-gaap': tags}}).encode()


class SectorFinancialTests(unittest.TestCase):
    def test_extracts_actual_quarter_and_never_treats_ytd_as_quarter(self):
        rows = adapter.quarterly_flows([
            fact('2026-01-01', '2026-03-31', 100, filed='2026-05-01', accession='a'),
            fact('2026-01-01', '2026-06-30', 230, accession='b'),
            fact('2026-04-01', '2026-06-30', 130, accession='b'),
        ], '2026-10-01')
        self.assertEqual([row['value'] for row in rows], [100, 130])
        self.assertEqual(rows[-1]['basis'], 'reported_quarter')
        self.assertEqual(rows[-1]['start'], '2026-04-01')

    def test_q4_requires_same_fiscal_start_and_adjacent_nine_months(self):
        rows = adapter.quarterly_flows([
            fact('2025-01-01', '2025-09-30', 900, filed='2025-11-01', accession='a'),
            fact('2025-01-01', '2025-12-31', 1300, filed='2026-02-01', accession='b', form='10-K'),
        ], '2026-10-01')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['value'], 400)
        self.assertEqual(rows[0]['start'], '2025-10-01')
        self.assertEqual(rows[0]['publishedAt'], '2026-02-01')
        self.assertEqual(len(rows[0]['inputs']), 2)
        bad = [fact('2025-07-01', '2025-09-30', 400, filed='2025-11-01'),
               fact('2025-01-01', '2025-12-31', 1300, filed='2026-02-01', form='10-K')]
        self.assertEqual(len(adapter.quarterly_flows(bad, '2026-10-01')), 1)
        self.assertEqual(adapter.quarterly_flows(bad, '2026-10-01')[0]['end'], '2025-09-30')

    def test_revisions_take_latest_available_filing_without_future_leakage(self):
        rows = adapter.quarterly_flows([
            fact('2026-04-01', '2026-06-30', 100, filed='2026-07-30', accession='a'),
            fact('2026-04-01', '2026-06-30', 110, filed='2026-08-15', accession='b'),
            fact('2026-04-01', '2026-06-30', 150, filed='2026-11-01', accession='c'),
        ], '2026-10-01')
        self.assertEqual(rows[0]['value'], 110)
        self.assertEqual(rows[0]['accession'], 'b')

    def test_later_comparison_does_not_remove_base_known_at_annual_publication(self):
        rows = adapter.quarterly_flows([
            fact('2025-01-01', '2025-09-30', 900, filed='2025-11-01', accession='base-known'),
            fact('2025-01-01', '2025-09-30', 910, filed='2026-09-01', accession='later-comparison'),
            fact('2025-01-01', '2025-12-31', 1300, filed='2026-02-01', accession='annual', form='10-K'),
        ], '2026-10-01')
        self.assertEqual(rows[0]['value'], 400)
        self.assertEqual(rows[0]['inputs'][1]['accn'], 'base-known')

    def test_missing_or_annual_only_source_does_not_invent_quarters(self):
        self.assertEqual(adapter.quarterly_flows([fact('2025-01-01', '2025-12-31', 1000, form='10-K')], '2026-10-01'), [])
        self.assertEqual(adapter.quarterly_flows([fact('2026-06-01', '2026-06-30', 100)], '2026-10-01'), [])
        self.assertEqual(adapter.quarterly_flows([fact('2026-04-01', '2026-06-30', None)], '2026-10-01'), [])

    def test_gaap_margin_from_same_filing_cost_preserves_original_items(self):
        r = fact('2026-04-01', '2026-06-30', 1000000000)
        c = fact('2026-04-01', '2026-06-30', 600000000, tag='CostOfRevenue')
        result = adapter.parse_sec_companyfacts(payload([r], [c]), 'MU', '2026-10-01')
        self.assertEqual(result['gross_margin'][0]['value'], 40)
        obs = adapter.sec_observations('MU', 'gross_margin', result['gross_margin'], '2026-10-01T00:00:00+00:00', 'raw-hash')[0]
        self.assertEqual(obs['value'], 40)
        self.assertEqual(obs['publishedAt'], '2026-07-30')
        self.assertEqual(obs['filingDate'], '2026-07-30')
        self.assertEqual(obs['originalItems']['revenue_usd'], 1000000000)
        self.assertIn('0000723125.json', obs['originalItems']['source_api_url'])
        self.assertIn('-index.html', obs['sourceUrl'])
        self.assertEqual(len(json.loads(obs['originalItems']['rawSourceFacts'])), 2)

    def test_does_not_mix_revised_revenue_and_old_cost_accession(self):
        r = fact('2026-04-01', '2026-06-30', 100, accession='revised')
        c = fact('2026-04-01', '2026-06-30', 60, accession='old', tag='CostOfRevenue')
        self.assertEqual(adapter.parse_sec_companyfacts(payload([r], [c]), 'MU', '2026-10-01')['gross_margin'], [])

    def test_cik_mismatch_rejected(self):
        with self.assertRaisesRegex(ValueError, 'CIK'):
            adapter.parse_sec_companyfacts(payload([fact('2026-04-01', '2026-06-30', 100)], cik=123), 'MU', '2026-10-01')

    def test_semantic_scope_is_company_total_and_native_currency(self):
        d = adapter.financial_definition('MU', 'company_revenue')
        self.assertEqual(d['family'], 'company_revenue')
        self.assertEqual(d['directness'], 'company_total')
        self.assertIn('非AI', d['nameZh'])
        self.assertEqual(d['scope'], 'consolidated_company_not_ai_only')
        self.assertEqual(adapter.financial_definition('ETN', 'gross_margin')['id'], 'ETN.company_gross_margin')
        self.assertEqual(adapter.financial_definition('TSM', 'company_revenue')['currency'], 'TWD')

    def test_tsm_actual_pdf_anchor_refuses_guidance_and_wrong_period(self):
        text = 'July 16, 2026 -- TSMC today announced consolidated revenue of NT$1,270.38 billion for the second quarter ended June 30, 2026. Gross margin for the quarter was 67.7%. Revenue is expected to be US$50 billion; Gross profit margin is expected between 90% and 95%.'
        reader = SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: text)])
        with patch.object(adapter, 'PdfReader', return_value=reader):
            row = adapter.parse_tsm_release(b'fake pdf', 2026, 2)
            self.assertEqual(row['revenueBillionTwd'], 1270.38)
            self.assertEqual(row['grossMargin'], 67.7)
            self.assertEqual(row['publishedAt'], '2026-07-16')
            with self.assertRaisesRegex(ValueError, '季度'):
                adapter.parse_tsm_release(b'fake pdf', 2026, 1)
        split_year = text.replace('July 16, 2026 --', 'July 16, 202 6 --')
        with patch.object(adapter, 'PdfReader', return_value=SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: split_year)])):
            self.assertEqual(adapter.parse_tsm_release(b'fake pdf', 2026, 2)['publishedAt'], '2026-07-16')
        with patch.object(adapter, 'PdfReader', return_value=SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: text.replace('Gross margin for the quarter was 67.7%.', ''))])):
            with self.assertRaisesRegex(ValueError, '锚点'):
                adapter.parse_tsm_release(b'fake pdf', 2026, 2)

    def test_failure_preserves_cache_and_never_turns_missing_to_zero(self):
        prior = {'observations': [{'periodEnd': '2026-06-30', 'value': 100}], 'fetchedAt': '2026-07-30T00:00:00+00:00', 'status': 'ready'}
        cached = adapter.restore_failure(prior, 'source unavailable', '2026-10-01T00:00:00+00:00')
        self.assertEqual(cached['status'], 'cached')
        self.assertEqual(cached['observations'], prior['observations'])
        self.assertEqual(cached['lastSuccessfulAt'], prior['fetchedAt'])
        failed = adapter.restore_failure(None, 'source unavailable', '2026-10-01T00:00:00+00:00')
        self.assertEqual(failed['status'], 'fetch_failed')
        self.assertEqual(failed['observations'], [])

    def test_full_build_source_failure_keeps_all_previous_metric_observations(self):
        defs = [adapter.financial_definition(entity, family) for entity in ['MU', 'ETN', 'VRT', 'TSM'] for family in ['company_revenue', 'gross_margin']]
        prior = {'series': {d['id']: {'observations': [{'periodEnd': '2026-06-30', 'value': 123}], 'fetchedAt': '2026-07-30T00:00:00+00:00'} for d in defs}}
        def failing_source(url, force=False):
            raise RuntimeError('offline')
        result = adapter.build(source_fetch=failing_source, prior=prior, as_of='2026-10-01')
        self.assertEqual(len(result['series']), 8)
        for series in result['series'].values():
            self.assertEqual(series['status'], 'cached')
            self.assertEqual(series['observations'], [{'periodEnd': '2026-06-30', 'value': 123}])
            self.assertEqual(series['lastSuccessfulAt'], '2026-07-30T00:00:00+00:00')


if __name__ == '__main__':
    unittest.main()
