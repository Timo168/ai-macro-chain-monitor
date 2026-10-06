"""Independent acceptance checks for Fujimi cross-company evidence.

The collector is executed earlier in the workflow.  These checks read its
published fact file and the checksum-addressed raw PDFs instead of invoking the
collector parser again.
"""
import hashlib
import json
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data'/'industry'/'cross-company-evidence.json'
RAW=ROOT/'data'/'industry'/'raw'

class CrossCompanyEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DATA.exists():
            raise unittest.SkipTest('cross-company collector has not produced a local data cache')
        cls.data=json.loads(DATA.read_text(encoding='utf-8'))

    def test_four_fujimi_series_have_continuous_actual_history(self):
        for family in ['cmp_revenue','company_revenue','operating_income','operating_margin']:
            definition=next(d for d in self.data['definitions'] if d['id']==f'FUJIMI.{family}')
            series=self.data['series'][definition['id']]
            self.assertEqual(series['status'],'ready')
            rows=series['observations']
            self.assertGreaterEqual(len(rows),8)
            self.assertTrue(all(p['isEstimated'] is False and p['publishedAt']>p['periodEnd'] for p in rows))
            self.assertTrue(all(p['sourceUrl'].startswith('https://www.ircms.jp/irexport/fujimiinc/file/') for p in rows))
            self.assertFalse(definition['recommendationEligible'])
            self.assertTrue(definition['crossEvidenceOnly'])

    def test_three_independent_periods_preserve_source_bytes_and_calculation_operands(self):
        rows=self.data['series']['FUJIMI.company_revenue']['observations']
        selected=[rows[0],rows[len(rows)//2],rows[-1]]
        for point in selected:
            raw_hash=point['originalItems']['currentSourceHash']
            source=RAW/(raw_hash+'.pdf')
            self.assertTrue(source.exists(),point['periodEnd'])
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),raw_hash)
            current=point['originalItems']['currentCumulative']['company_revenue']
            prior=(point['originalItems']['previousCumulative'] or {}).get('company_revenue',0)
            self.assertAlmostEqual(point['value'],(current-prior)/100,places=8)

    def test_margin_uses_same_quarter_operating_income_and_revenue(self):
        revenue={p['periodEnd']:p for p in self.data['series']['FUJIMI.company_revenue']['observations']}
        income={p['periodEnd']:p for p in self.data['series']['FUJIMI.operating_income']['observations']}
        margin={p['periodEnd']:p for p in self.data['series']['FUJIMI.operating_margin']['observations']}
        for period in [sorted(margin)[0],sorted(margin)[len(margin)//2],sorted(margin)[-1]]:
            self.assertAlmostEqual(margin[period]['value'],income[period]['value']/revenue[period]['value']*100,places=8)

    def test_ase_is_explicitly_unconfigured_or_failed_not_ready(self):
        ase=next(row for row in self.data['sourceCatalog'] if row['id']=='ase_cross_company')
        self.assertIn(ase['status'],['not_configured','fetch_failed'])
        self.assertNotEqual(ase['status'],'ready')

if __name__=='__main__':
    unittest.main()
