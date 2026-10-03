import sys,unittest,json,tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import industry_supply_evidence as supply

class SupplyTest(unittest.TestCase):
 def test_namespace(self):
  self.assertTrue(supply.allowed('https://d1io3yog0oux5.cloudfront.net/a/equinix/db/1.pdf'))
  for url in ['http://investor.equinix.com/a','https://user@investor.equinix.com/a','https://d1io3yog0oux5.cloudfront.net/other-company.pdf','https://investor.equinix.com.evil.test/a']:self.assertFalse(supply.allowed(url))
 def test_anet_scope(self):
  raw=b'<h1>Arista Networks, Inc. Reports Second Quarter 2026 Financial Results</h1><p>SANTA CLARA, Calif.- August 4, 2026 -- Revenue of $3.036 billion. GAAP gross margin of 63.1%.</p>'
  row=supply.parse_anet(raw);self.assertEqual(row['end'],'2026-06-30');self.assertEqual(row['revenue'],30.36);self.assertEqual(row['publishedAt'],'2026-08-04')
  with self.assertRaises(ValueError):supply.parse_anet(raw.replace(b'GAAP gross margin',b'Non-GAAP gross margin'))
 def test_future_or_wrong_issuer(self):
  with self.assertRaises(ValueError):supply.parse_anet(b'<h1>Arista Reports Fourth Quarter 2099 Financial Results</h1>')
 def test_pdf_date_and_current_gaap_table_column(self):
  text='Arista Networks, Inc. Reports Second Quarter 2026 Financial Results 2026-08-04 Revenue of $3.036 billion. Reconciliation Three Months Ended June 30, 2026 2025 GAAP gross margin 62.9% 65.2% Non-GAAP gross margin 63.4% 65.6%'
  fake=type('Page',(),{'extract_text':lambda self:text})()
  with patch.object(supply,'PdfReader',return_value=type('Reader',(),{'pages':[fake]})()):
   row=supply.parse_anet(b'%PDF-fake');self.assertEqual(row['publishedAt'],'2026-08-04');self.assertEqual(row['gross_margin'],62.9)
 def test_older_operating_table_keeps_mw_not_cost(self):
  text='xScale Capacity (MW) Capacity Under Development (1) $2,196 192 132 Previously Opened Data Centers JV Open Open $2,640 253 233 Total Portfolio(1) (2) $4,836 446 365'
  fake=type('Page',(),{'extract_text':lambda self:text})()
  with patch.object(supply,'PdfReader',return_value=type('Reader',(),{'pages':[fake]})()):self.assertEqual(supply.parse_eqix_capacity(b'pdf')['operational_capacity'],253)
 def test_packaging_plan_is_not_actual_production(self):
  raw=b'<title>ASE Launches Automated 310mm Panel-Level Packaging</title><h1>Menu</h1><h1>ASE Launches Automated 310mm Panel-Level Packaging</h1>May 26, 2026<p>The new panel line is expected to enter production in the first half of 2027.</p>'
  event=supply.parse_ase_event(raw,supply.ASE_EVENTS[1]);self.assertEqual(event['observationNature'],'forecast');self.assertNotIn('value',event);self.assertEqual(event['date'],'2026-05-26')
  with self.assertRaises(ValueError):supply.parse_ase_event(raw.replace(b'2027',b'2026'),supply.ASE_EVENTS[1])
 def test_failure_keeps_original_observation_and_configured_empty_states(self):
  with tempfile.TemporaryDirectory(prefix='supply-failure-') as folder:
   path=Path(folder);original={'metricId':'EQIX.operational_capacity','periodEnd':'2026-06-30','value':408,'version':'original-source','sourceUrl':supply.EQIX_INDEX,'fetchedAt':'2026-07-29T00:00:00Z'}
   (path/'supply-evidence.json').write_text(json.dumps({'definitions':[],'series':{'EQIX.operational_capacity':{'status':'ready','observations':[original]}}}),encoding='utf-8');results=[]
   with patch.object(supply,'DATA',path),patch.object(supply,'fetch_source',side_effect=RuntimeError('official offline')),patch.object(supply,'candidates',return_value=[]),patch.object(supply,'persist',side_effect=lambda result,target:results.append(result)),patch('builtins.print'):
    supply.run()
   result=results[0];self.assertEqual(result['series']['EQIX.operational_capacity']['status'],'cached');self.assertEqual(result['series']['EQIX.operational_capacity']['observations'],[original]);self.assertEqual(result['series']['ANET.company_revenue']['status'],'fetch_failed');self.assertEqual(result['series']['ANET.company_revenue']['observations'],[]);self.assertEqual(len(result['definitions']),4)
 def test_capacity_columns(self):
  text='xScale Phase Capacity (MW)\nCapacity Under Development (1) 2,157$ 196 182\nPreviously Opened Capacity 4,469$ 408 396\nTotal Portfolio(1) (2) 6,626$ 604 577'
  fake=type('Page',(),{'extract_text':lambda self:text})()
  with patch.object(supply,'PdfReader',return_value=type('Reader',(),{'pages':[fake]})()):
   row=supply.parse_eqix_capacity(b'pdf');self.assertEqual(row['operational_capacity'],408);self.assertEqual(row['development_capacity'],196);self.assertNotEqual(row['operational_capacity'],row['opened_cost_million'])
  fake=type('Page',(),{'extract_text':lambda self:text.replace('604','1604')})()
  with patch.object(supply,'PdfReader',return_value=type('Reader',(),{'pages':[fake]})()):
   with self.assertRaises(ValueError):supply.parse_eqix_capacity(b'pdf')
 def test_index_never_invents_future_reports(self):
  raw=b'<div><p>Q2 2026 Quarter Ended Jun 30, 2026</p><a href="https://investor.equinix.com/news-events/press-releases/detail/1114">Earnings Release</a><a href="https://d1io3yog0oux5.cloudfront.net/a/equinix/db/Q2+26+Earnings+Presentation.pdf">Earnings Presentation</a></div>'
  self.assertEqual(supply.eqix_candidates(raw)[0]['end'],'2026-06-30')
  self.assertEqual(supply.eqix_candidates(raw.replace(b'Q2+26',b'Q4+99')),[])

if __name__=='__main__':unittest.main()
