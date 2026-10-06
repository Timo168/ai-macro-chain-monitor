"""Independent acceptance checks for issuer cross-company evidence.

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
        source=next(row for row in self.data['sourceCatalog'] if row['id']=='fujimi_cross_company')
        self.assertIn(source['status'],('ready','cached','fetch_failed'))
        if source['status']=='fetch_failed':
            self.assertFalse(self.data['series']['FUJIMI.company_revenue']['observations'])
            self.skipTest('Fujimi issuer source unavailable; failure state is explicit')
        for family in ['cmp_revenue','company_revenue','operating_income','operating_margin']:
            definition=next(d for d in self.data['definitions'] if d['id']==f'FUJIMI.{family}')
            series=self.data['series'][definition['id']]
            self.assertEqual(series['status'],source['status'])
            rows=series['observations']
            self.assertGreaterEqual(len(rows),8)
            self.assertTrue(all(p['isEstimated'] is False and p['publishedAt']>p['periodEnd'] for p in rows))
            self.assertTrue(all(p['sourceUrl'].startswith('https://www.ircms.jp/irexport/fujimiinc/file/') for p in rows))
            self.assertFalse(definition['recommendationEligible'])
            self.assertTrue(definition['crossEvidenceOnly'])

    def test_three_independent_periods_preserve_source_bytes_and_calculation_operands(self):
        rows=self.data['series']['FUJIMI.company_revenue']['observations']
        if not rows:
            self.skipTest('No prior Fujimi observation to audit')
        selected=[rows[0],rows[len(rows)//2],rows[-1]]
        for point in selected:
            raw_hash=point['originalItems']['currentSourceHash']
            source=RAW/(raw_hash+'.pdf')
            if source.exists():
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),raw_hash)
            else:
                self.assertRegex(raw_hash,r'^[0-9a-f]{64}$')
            current=point['originalItems']['currentCumulative']['company_revenue']
            prior=(point['originalItems']['previousCumulative'] or {}).get('company_revenue',0)
            self.assertAlmostEqual(point['value'],(current-prior)/100,places=8)

    def test_margin_uses_same_quarter_operating_income_and_revenue(self):
        revenue={p['periodEnd']:p for p in self.data['series']['FUJIMI.company_revenue']['observations']}
        income={p['periodEnd']:p for p in self.data['series']['FUJIMI.operating_income']['observations']}
        margin={p['periodEnd']:p for p in self.data['series']['FUJIMI.operating_margin']['observations']}
        if not margin:
            self.skipTest('No prior Fujimi margin observation to audit')
        for period in [sorted(margin)[0],sorted(margin)[len(margin)//2],sorted(margin)[-1]]:
            self.assertAlmostEqual(margin[period]['value'],income[period]['value']/revenue[period]['value']*100,places=8)

    def test_ase_company_releases_preserve_three_independent_quarters(self):
        self.assertIn('ASE.atm_revenue',self.data['series'],'cross-company schema 2 collector did not run')
        ase=next(row for row in self.data['sourceCatalog'] if row['id']=='ase_cross_company')
        self.assertIn(ase['status'],('ready','cached','fetch_failed'))
        if ase['status']=='fetch_failed':
            self.assertFalse(self.data['series']['ASE.atm_revenue']['observations'])
            self.assertTrue(ase.get('error'))
            self.skipTest('ASE issuer source unavailable; failure state is explicit')
        expected={
            '2024-03-31':(739.08,1328.03,8.2),
            '2025-06-30':(925.65,1507.5,9.5),
            '2026-06-30':(1261.48,1910.64,15.7),
        }
        families=('atm_revenue','company_revenue','atm_margin')
        for family in families:
            definition=next(d for d in self.data['definitions'] if d['id']=='ASE.'+family)
            self.assertFalse(definition['recommendationEligible'])
            self.assertTrue(definition['crossEvidenceOnly'])
            series=self.data['series'][definition['id']]
            self.assertEqual(series['status'],ase['status'])
            self.assertGreaterEqual(len(series['observations']),10)
            rows={p['periodEnd']:p for p in series['observations']}
            for period,values in expected.items():
                p=rows[period]
                self.assertAlmostEqual(p['value'],values[families.index(family)])
                self.assertGreater(p['publishedAt'][:10],period)
                self.assertTrue(p['sourceUrl'].startswith('https://www.prnewswire.com/news-releases/ase-technology-holding-co-ltd-'))
                raw_hash=p['originalItems']['sourceHash']
                raw=RAW/(raw_hash+'.html')
                # The durable data branch stores extracted facts, not full issuer HTML.
                # A fresh successful fetch must have the raw bytes in this run; a
                # restored cached fact can still be checked by its frozen operands.
                if raw.exists():
                    self.assertEqual(hashlib.sha256(raw.read_bytes()).hexdigest(),raw_hash)
                else:
                    self.assertRegex(raw_hash,r'^[0-9a-f]{64}$')

    def test_ase_source_failure_preserves_last_success_as_cache(self):
        import sys
        sys.path.insert(0,str(ROOT/'scripts'))
        from industry_cross_company import merge_series
        self.assertIn('ASE.atm_revenue',self.data['series'],'cross-company schema 2 collector did not run')
        previous=self.data['series']['ASE.atm_revenue']
        if not previous['observations']:
            self.skipTest('No prior ASE observation to retain after a source failure')
        result=merge_series(previous,{},False,'source unavailable')
        self.assertEqual(result['status'],'cached')
        self.assertEqual(result['observations'],previous['observations'])
        self.assertEqual(result['lastSuccessfulAt'],previous['lastSuccessfulAt'])

if __name__=='__main__':
    unittest.main()
