"""Small synthetic source fixtures test actual-quarter and source-state boundaries."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import industry_packaging as packaging


def source(quarter=2, advanced='900', ytd='(180,000)', year=2025):
    word = ['First', 'Second', 'Third', 'Fourth'][quarter - 1]
    end = ['March 31', 'June 30', 'September 30', 'December 31'][quarter - 1]
    publication = ['April 28', 'July 28', 'October 28', 'February 10'][quarter - 1]
    publication_year = year + (quarter == 4)
    header = ['Three Months', 'Six Months', 'Nine Months', 'Years'][quarter - 1]
    return f'''<title>Amkor Technology Reports Financial Results for the {word} Quarter {year}</title>
    <p>TEMPE, Ariz., {publication}, {publication_year}. Results for the quarter ended {end}, {year}.</p>
    <p>Advanced products include flip chip, memory and wafer-level processing and related test services.</p>
    <table><tr><td>Net sales (in millions)</td><td>Q{quarter} {year}</td><td>Q1 2025</td><td>Q2 2024</td></tr>
    <tr><td>Advanced products (1)</td><td>{advanced}</td><td>800</td><td>700</td></tr>
    <tr><td>Mainstream products (2)</td><td>300</td><td>200</td><td>200</td></tr>
    <tr><td>Total net sales</td><td>1,200</td><td>1,000</td><td>900</td></tr>
    <tr><td>Gross margin</td><td>16.5%</td><td>15.2%</td><td>14.1%</td></tr>
    <tr><td>Materials</td><td>43.2%</td><td>42.1%</td><td>41.0%</td></tr></table>
    <table><tr><td>For the {header} Ended</td><td>{end}, {year}</td><td>{end}, {year-1}</td></tr>
    <tr><td>In thousands</td></tr><tr><td>Payments for property, plant and equipment</td><td>{ytd}</td><td>(99,000)</td></tr></table>'''.encode()


def job(quarter=2, year=2025):
    end = ['03-31', '06-30', '09-30', '12-31'][quarter - 1]
    return {'year': year, 'quarter': quarter, 'end': f'{year}-{end}',
            'url': f'https://ir.amkor.com/news-releases/test-{year}-{quarter}'}


class PackagingEvidenceTest(unittest.TestCase):
    def test_current_quarter_units_and_company_scope(self):
        row = packaging.parse_release(source(), job())
        self.assertEqual(row['values']['advanced_products_revenue'], 900)
        self.assertEqual(row['values']['gross_margin'], 16.5)
        self.assertEqual(row['values']['materials_cost_share'], 43.2)
        self.assertEqual(row['values']['capex_ytd'], 180000)
        self.assertEqual(row['publishedAt'], '2025-07-28')

    def test_missing_current_column_cannot_shift_prior_value(self):
        # Prior columns intentionally make a plausible total if silently shifted.
        raw = source(advanced='—').replace(b'<td>800</td>', b'<td>900</td>')
        with self.assertRaises(ValueError):
            packaging.parse_release(raw, job())
        for old,new in [(b'<td>900</td>',b'<td></td>'),(b'<td>16.5%</td>',b'<td></td>'),(b'<td>(180,000)</td>',b'<td></td>')]:
            with self.subTest(missing=old),self.assertRaises(ValueError):
                packaging.parse_release(source().replace(old,new,1),job())

    def test_cash_spending_positive_sign_is_not_silently_absorbed(self):
        with self.assertRaises(ValueError):
            packaging.parse_release(source(ytd='180,000'),job())

    def test_title_unit_current_column_and_scope_must_match(self):
        for old, new in [
            (b'Net sales (in millions)', b'Net sales (in thousands)'),
            (b'Q2 2025</td>', b'Q1 2025</td>'),
            (b'for the Second Quarter 2025</title>', b'for the Third Quarter 2025</title>'),
            (b'include flip chip, memory', b'include only AI'),
            (b'16.5%', b'116.5%'),
            (b'July 28, 2025', b'July 28, 2099'),
            (b'June 30, 2025.', b'March 31, 2025.'),
        ]:
            with self.subTest(replacement=new), self.assertRaises(ValueError):
                packaging.parse_release(source().replace(old, new), job())

    def test_cash_ytd_duration_and_first_year_verified(self):
        for raw in [source().replace(b'For the Six Months Ended', b'For the Three Months Ended'),
                    source().replace(b'<td>June 30, 2025</td>', b'<td>June 30, 2024</td>')]:
            with self.assertRaises(ValueError):
                packaging.parse_release(raw, job())

    def test_positive_payment_is_not_silently_accepted_by_absolute_value(self):
        with self.assertRaises(ValueError):
            packaging.parse_release(source(ytd='180,000'), job())

    def test_discovery_filters_future_and_nonissuer_links(self):
        raw = b'''<a href="/news-releases/q2">Amkor Technology Reports Financial Results for the Second Quarter 2025</a>
        <a href="/news-releases/future">Amkor Technology Reports Financial Results for the Fourth Quarter 2099</a>
        <a href="https://evil.example/news-releases/x">Amkor Technology Reports Financial Results for the First Quarter 2025</a>'''
        self.assertEqual([(x['year'], x['quarter']) for x in packaging.release_candidates(raw)], [(2025, 2)])
        for url in ['http://ir.amkor.com/news-releases/a', 'https://user@ir.amkor.com/news-releases/a',
                    'https://ir.amkor.com.evil.test/news-releases/a', 'https://ir.amkor.com:80/news-releases/a']:
            self.assertFalse(packaging.allowed(url))

    def collect(self, folder, quarters):
        jobs = [job(q) for q in quarters]
        amounts = {1: '(100,000)', 2: '(180,000)', 3: '(160,000)', 4: '(270,000)'}
        def fetch(url, force=False):
            q = next((j['quarter'] for j in jobs if j['url'] == url), None)
            raw = source(q, ytd=amounts[q]) if q else b'<html>index</html>'
            return raw, '2026-09-01T00:00:00+00:00', hashlib.sha256(raw).hexdigest()
        with patch.object(packaging, 'DATA', Path(folder)), patch.object(packaging, 'fetch_source', side_effect=fetch), \
                patch.object(packaging, 'release_candidates', return_value=jobs), patch.object(packaging, 'persist'), patch('builtins.print'):
            return packaging.run()

    def test_ytd_difference_has_both_versions_and_units(self):
        with tempfile.TemporaryDirectory() as folder:
            result = self.collect(folder, [1, 2])
        rows = result['series']['AMKR.capex']['observations']
        self.assertEqual([p['value'] for p in rows], [1, .8])
        self.assertEqual(rows[1]['originalUnit'], 'USD thousand')
        self.assertEqual(rows[1]['originalItems']['baseUrl'], job(1)['url'])
        self.assertTrue(rows[1]['originalItems']['baseVersion'])
        self.assertEqual(result['series']['AMKR.advanced_products_revenue']['observations'][0]['value'], 9)
        self.assertTrue(all(d['researchTargets'] == ['packaging_operations'] for d in result['definitions']))

    def test_missing_base_or_negative_difference_never_invents_zero(self):
        with tempfile.TemporaryDirectory() as folder:
            result = self.collect(folder, [2])
            self.assertEqual(result['series']['AMKR.capex']['observations'], [])
            self.assertEqual(result['series']['AMKR.capex']['status'], 'no_observation')
            result = self.collect(folder, [2, 3])
            self.assertEqual(result['series']['AMKR.capex']['observations'], [])
            self.assertEqual(result['series']['AMKR.capex']['status'], 'fetch_failed')

    def test_failure_preserves_original_fetched_at_value_and_version(self):
        original = {'periodEnd': '2025-06-30', 'value': 9, 'version': 'old-source-version', 'fetchedAt': '2025-07-28T00:00:00+00:00'}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / 'packaging-evidence.json').write_text(json.dumps({'series': {'AMKR.advanced_products_revenue': {'observations': [original]}}}), encoding='utf-8')
            with patch.object(packaging, 'DATA', path), patch.object(packaging, 'fetch_source', side_effect=RuntimeError('offline')), \
                    patch.object(packaging, 'persist'), patch('builtins.print'):
                result = packaging.run()
        self.assertEqual(result['series']['AMKR.advanced_products_revenue']['observations'], [original])
        self.assertEqual(result['series']['AMKR.advanced_products_revenue']['status'], 'cached')
        self.assertEqual(result['series']['AMKR.company_revenue']['status'], 'fetch_failed')
        self.assertEqual(len(result['definitions']), 5)

    def test_cached_source_checksum_is_verified(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); rawdir = root / 'raw'; rawdir.mkdir()
            raw = b'original official source bytes'; digest = hashlib.sha256(raw).hexdigest()
            (rawdir / (digest + '.html')).write_bytes(b'tampered source')
            meta = {'file': digest + '.html', 'hash': digest, 'fetchedAt': packaging.now()}
            (rawdir / (hashlib.sha256(packaging.INDEX.encode()).hexdigest() + '.meta.json')).write_text(json.dumps(meta), encoding='utf-8')
            with patch.object(packaging, 'DATA', root), self.assertRaises(ValueError):
                packaging.fetch_source(packaging.INDEX)


if __name__ == '__main__':
    unittest.main()
