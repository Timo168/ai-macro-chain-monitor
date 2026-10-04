"""Synthetic Entegris fixtures preserve GAAP, units, dates and quarterly flows."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import industry_materials as materials


def source(unit='thousands', cash_label='Acquisition of property, plant and equipment', cash_amount='(45,600)', cash_header='Three months ended'):
    return f'''<title>Entegris Reports Results for Second Quarter of 2025</title>
    <span class="evergreen-news-date-text">July 30, 2025</span>
    <p>Entegris, Inc. reports the Company's second quarter ended June 28, 2025.</p>
    <table><tr><td>Quarterly Financial Results Summary (in {unit})</td></tr>
    <tr><td>GAAP Results</td><td>Jun 28, 2025</td><td>Jun 29, 2024</td><td>Mar 29, 2025</td></tr>
    <tr><td>Net sales</td><td>780,000</td><td>700,000</td><td>760,000</td></tr>
    <tr><td>Gross margin - as a % of net sales</td><td>43.2%</td><td>39.1%</td><td>40.1%</td></tr>
    <tr><td>Non-GAAP Results</td><td></td><td></td><td></td></tr>
    <tr><td>Gross margin - as a % of net sales</td><td>99.9%</td><td>99.9%</td><td>99.9%</td></tr></table>
    <table><tr><td>Condensed Consolidated Statements of Cash Flows (in {unit})</td></tr>
    <tr><td></td><td>{cash_header}</td><td>Six months ended</td></tr>
    <tr><td></td><td>Jun 28, 2025</td><td>Jun 28, 2025</td></tr>
    <tr><td>{cash_label}</td><td>{cash_amount}</td><td>(88,800)</td></tr></table>'''.encode()


class MaterialsEvidenceTest(unittest.TestCase):
    def test_current_gaap_and_quarterly_cash_exclude_ytd_adjusted(self):
        row = materials.parse_release_html(source(), as_of='2025-08-01')
        self.assertEqual(row['revenueMillion'], 780)
        self.assertEqual(row['revenueOriginalUnit'], 'USD thousand')
        self.assertEqual(row['grossMargin'], 43.2)
        self.assertEqual(row['capexMillion'], 45.6)
        self.assertEqual(row['periodStart'], '2025-03-30')
        self.assertEqual(row['periodEnd'], '2025-06-28')

    def test_millions_is_not_scaled_like_thousands(self):
        row = materials.parse_release_html(source(unit='millions', cash_amount='(45.6)').replace(b'780,000', b'780.0'), as_of='2025-08-01')
        self.assertEqual(row['revenueMillion'], 780)
        self.assertEqual(row['capexMillion'], 45.6)
        self.assertEqual(row['capexOriginalUnit'], 'USD million')

    def test_legacy_ppe_label_is_actual_not_a_different_metric(self):
        row = materials.parse_release_html(source(cash_label='Acquisition of property and equipment'), as_of='2025-08-01')
        self.assertEqual(row['capexMillion'], 45.6)

    def test_split_parentheses_and_empty_html_cells(self):
        raw = source().replace(b'<td>(45,600)</td>', b'<td>(45,600</td><td>)</td>')
        raw = raw.replace(b'<td>Jun 28, 2025</td><td>Jun 28, 2025</td>', b'<td></td><td>Jun 28, 2025</td><td></td><td>Jun 28, 2025</td>')
        row = materials.parse_release_html(raw, as_of='2025-08-01')
        self.assertEqual(row['capexMillion'], 45.6)

    def test_only_ytd_column_is_missing_not_zero_or_full_quarter(self):
        row = materials.parse_release_html(source(cash_header='Six months ended'), as_of='2025-08-01')
        self.assertIsNone(row['capexMillion'])
        self.assertEqual(row['revenueMillion'], 780)

    def test_missing_current_amount_never_shifts_prior_or_ytd(self):
        with self.assertRaises(ValueError):
            materials.parse_release_html(source().replace(b'<td>780,000</td>', '<td>—</td>'.encode()), as_of='2025-08-01')
        row = materials.parse_release_html(source(cash_amount='—'), as_of='2025-08-01')
        self.assertIsNone(row['capexMillion'])

    def test_future_wrong_title_wrong_period_and_unit_are_rejected(self):
        changes = [
            (b'July 30, 2025', b'July 30, 2099'),
            (b'Entegris Reports Results for Second', b'Other Company Reports Results for Second'),
            (b'Jun 28, 2025</td><td>Jun 29, 2024', b'Jun 29, 2024</td><td>Jun 28, 2025'),
            (b'Mar 29, 2025', b'Mar 29, 2023'),
            (b'in thousands', b'in unknown units'),
        ]
        for old, new in changes:
            with self.subTest(change=new), self.assertRaises(ValueError):
                materials.parse_release_html(source().replace(old, new), as_of='2025-08-01')

    def test_positive_cash_payment_is_invalid(self):
        with self.assertRaises(ValueError):
            materials.parse_release_html(source(cash_amount='45,600'), as_of='2025-08-01')

    def test_ytd_first_or_wrong_cash_date_does_not_enter_actual_quarter(self):
        for raw in [source().replace(b'<td>Three months ended</td><td>Six months ended</td>',
                                    b'<td>Six months ended</td><td>Three months ended</td>'),
                    source().replace(b'<td>Jun 28, 2025</td><td>Jun 28, 2025</td>',
                                    b'<td>Jun 29, 2024</td><td>Jun 28, 2025</td>')]:
            with self.assertRaises(ValueError):
                materials.parse_release_html(raw, as_of='2025-08-01')

    def test_url_namespace_and_future_discovery(self):
        for url in ['https://investor.entegris.com.evil.test/news/news-details/a',
                    'https://user@investor.entegris.com/news/news-details/a',
                    'https://s205.q4cdn.com/another-company/files/a.pdf',
                    'http://www.entegris.com/en/home/about-us/news/x']:
            self.assertFalse(materials.allowed(url))
        raw = b'''<div class="item"><span class="date">Published July 30, 2025</span><a href="https://investor.entegris.com/news/news-details/2025/q2">Entegris Reports Results for Second Quarter of 2025</a></div>
        <div class="item"><span class="date">Published July 30, 2099</span><a href="https://investor.entegris.com/news/news-details/2099/q2">Entegris Reports Results for Second Quarter of 2099</a></div>'''
        jobs = materials.discover_releases(raw, as_of='2025-08-01')
        self.assertEqual([(x['fiscalYear'], x['quarter']) for x in jobs], [(2025, 2)])

    def test_pdf_reads_gaap_current_and_quarterly_cash(self):
        text = '''Entegris Reports Results for Second Quarter of 2025
        BILLERICA, Mass., July 30, 2025 Entegris, Inc. Company's second quarter ended June 28, 2025.
        Quarterly Financial Results Summary (in millions) GAAP Results Jun 28, 2025 Jun 29, 2024 Mar 29, 2025
        Net sales $780.0 $700.0 $760.0 Gross margin - as a % of net sales 43.2% 39.1% 40.1%
        Non-GAAP Results Gross margin - as a % of net sales 99.9%
        Condensed Consolidated Statements of Cash Flows (in millions) Three months ended Six months ended Jun 28, 2025 Jun 28, 2025
        Acquisition of property, plant and equipment (45.6) (88.8) Segment Information'''
        fake = type('Page', (), {'extract_text': lambda self: text})()
        with patch.object(materials, 'PdfReader', return_value=type('Reader', (), {'pages': [fake]})()):
            row = materials.parse_release_pdf(b'%PDF-fixture', as_of='2025-08-01')
        self.assertEqual(row['capexMillion'], 45.6)
        self.assertEqual(row['revenueMillion'], 780)
        self.assertEqual(row['grossMargin'], 43.2)

    def test_failed_collection_keeps_last_success_and_configured_states(self):
        original = {'periodEnd': '2025-06-28', 'value': 7.8, 'version': 'old-source-version', 'fetchedAt': '2025-07-30T00:00:00+00:00'}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / 'materials-evidence.json').write_text(json.dumps({'series': {'ENTG.company_revenue': {'observations': [original], 'fetchedAt': original['fetchedAt']}}}), encoding='utf-8')
            with patch.object(materials, 'DATA', path), patch.object(materials, 'BASELINE', []), patch.object(materials, 'fetch_source', side_effect=RuntimeError('offline')), \
                    patch.object(materials, 'persist'), patch('builtins.print'):
                result = materials.run()
        self.assertEqual(result['series']['ENTG.company_revenue']['observations'], [original])
        self.assertEqual(result['series']['ENTG.company_revenue']['status'], 'cached')
        self.assertEqual(result['series']['ENTG.company_revenue']['fetchedAt'], original['fetchedAt'])
        self.assertEqual(result['series']['ENTG.capex']['status'], 'fetch_failed')
        self.assertEqual(len(result['definitions']), 3)

    def test_cached_raw_bytes_are_checksum_verified(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); rawdir = root / 'raw'; rawdir.mkdir()
            digest = hashlib.sha256(b'official bytes').hexdigest()
            (rawdir / (digest + '.html')).write_bytes(b'altered bytes')
            meta = {'file': digest + '.html', 'hash': digest, 'fetchedAt': materials.now()}
            (rawdir / (hashlib.sha256(materials.INDEX.encode()).hexdigest() + '.meta.json')).write_text(json.dumps(meta), encoding='utf-8')
            with patch.object(materials, 'DATA', root), self.assertRaises(ValueError):
                materials.fetch_source(materials.INDEX)

    def test_failed_latest_discovery_cannot_claim_current_even_with_history(self):
        url = next(u for u in materials.BASELINE if 'Second-Quarter-of-2025/' in u)
        def fetch(target, force=False):
            if target == materials.INDEX:
                raise RuntimeError('latest archive check offline')
            raw = source()
            return raw, '2025-07-30T00:00:00+00:00', hashlib.sha256(raw).hexdigest()
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(materials, 'DATA', Path(folder)), patch.object(materials, 'BASELINE', [url]), \
                    patch.object(materials, 'fetch_source', side_effect=fetch), patch.object(materials, 'persist'), patch('builtins.print'):
                result = materials.run()
        self.assertTrue(all(s['status'] == 'cached' for s in result['series'].values()))
        self.assertTrue(all(len(s['observations']) == 1 for s in result['series'].values()))
        self.assertTrue(any(s['status'] == 'fetch_failed' for s in result['sources']))


if __name__ == '__main__':
    unittest.main()
