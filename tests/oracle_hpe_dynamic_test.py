"""Dynamic Oracle/HPE reports: period, unit, total-column and cache boundaries."""
import copy,json,pathlib,sys,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import industry_oracle as oracle
import industry_extended as extended

STAMP='2026-10-02T00:00:00+00:00'
ORACLE_URL='https://investor.oracle.com/files/content_files/1q27-pressrelease-September_FINAL.pdf'
HPE_URL=extended.HPE_HISTORY[-1]['url']
RELEASE={'entity':'ORCL','fiscalYear':2027,'quarter':1,'publishedAt':'2026-09-10','url':ORACLE_URL}
# Numeric facts and headings extracted from the official FY2027 Q1 appendix (pages 5, 9, 10).
ORACLE_PAGES=[
 'ORACLE CORPORATION Q1 FISCAL 2027 FINANCIAL RESULTS\nCONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS\n($ in millions)\nThree Months Ended August 31,\n2026 2025\nTotal revenues 19,345 14,926\n',
 'ORACLE CORPORATION Q1 FISCAL 2027 FINANCIAL RESULTS\nFREE CASH FLOW\nNET CASH OUTLAY FOR CAPITAL EXPENDITURES\n($ in millions)\nFiscal 2026 Fiscal 2027\nQ1 Q2 Q3 Q4 TOTAL Q1 Q2 Q3 Q4 TOTAL\nGAAP Operating Cash Flow $ 8,140 $ 2,066 $ 7,151 $ 14,620 $ 31,977 $ 23,103 $ 23,103\nCapital Expenditures (8,502) (12,033) (18,635) (16,493) (55,663) (28,499) (28,499)\nNet Cash Outlay for Capital Expenditures $ 6,544 $ 12,793 $ 17,166 $ 11,223 $ 47,726 $ 17,966 $ 17,966\n',
 'ORACLE CORPORATION Q1 FISCAL 2027 FINANCIAL RESULTS\nSUPPLEMENTAL ANALYSIS OF GAAP REVENUES\n($ in millions)\nFiscal 2026 Fiscal 2027\nQ1 Q2 Q3 Q4 TOTAL Q1 Q2 Q3 Q4 TOTAL\nCloud $ 7,186 $ 7,977 $ 8,914 $ 9,913 $ 33,989 $ 11,607 $ 11,607\nTotal revenues $ 14,926 $ 16,058 $ 17,190 $ 19,184 $ 67,357 $ 19,345 $ 19,345\nCloud infrastructure 3,347 4,079 4,888 5,787 18,101 7,388 7,388\nCloud infrastructure 55% 68% 84% 93% 77% 121% 121%\n'
]
HPE_SEGMENT='For the three months ended\nJuly 31, 2026 April 30, 2026 July 31, 2025\nIn millions\nNet Revenue: Cloud & AI Change (%)\nServer 6766 5454 5000 35.3 24.1\n'
HPE_MARGIN='For the three months ended\nJuly 31, 2026 April 30, 2026 July 31, 2025\nDollars in millions\nGAAP gross profit margin 40.1% 36.5% 29.2%\n'

def reader(pages):
 return SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda text=p:text) for p in pages])

class OracleDynamicTests(unittest.TestCase):
 def test_official_q1_history_excludes_annual_totals_and_preserves_actual_fiscal_dates(self):
  parsed=oracle.parse_oracle_pages(ORACLE_PAGES,2027,1)
  self.assertEqual([r['value'] for r in parsed['operating_cash_flow']],[8140,2066,7151,14620,23103])
  self.assertEqual([r['value'] for r in parsed['capex']],[8502,12033,18635,16493,28499])
  self.assertEqual(parsed['revenue'][-1]['value'],19345)
  self.assertEqual(parsed['cloud_infrastructure_revenue'][-1]['value'],7388)
  self.assertEqual(parsed['capex'][-1]['periodStart'],'2026-06-01')
  self.assertEqual(parsed['capex'][-1]['periodEnd'],'2026-08-31')
  self.assertEqual(parsed['capex'][3]['value'],16493)
  self.assertEqual(len(parsed['revenue']),5)

 def test_unknown_next_quarter_does_not_require_a_fixed_year_list(self):
  pages=['Q2 FISCAL 2028 FINANCIAL RESULTS\nCONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS\nThree Months Ended November 30,\n2027 2026',
   'FREE CASH FLOW\n($ in millions)\nFiscal 2027 Fiscal 2028\nQ1 Q2 Q3 Q4 TOTAL Q1 Q2 Q3 Q4 TOTAL\nGAAP Operating Cash Flow 1 2 3 4 10 5 6 11\nCapital Expenditures (2) (3) (4) (5) (14) (6) (7) (13)\n',
   'SUPPLEMENTAL ANALYSIS OF GAAP REVENUES\n($ in millions)\nFiscal 2027 Fiscal 2028\nQ1 Q2 Q3 Q4 TOTAL Q1 Q2 Q3 Q4 TOTAL\nTotal revenues 10 20 30 40 100 50 60 110\n']
  result=oracle.parse_oracle_pages(pages,2028,2)
  self.assertEqual(result['capex'][-1]['value'],7)
  self.assertEqual(result['capex'][-1]['periodEnd'],'2027-11-30')
  self.assertEqual(len(result['capex']),6)

 def test_fourth_quarter_uses_q4_not_total(self):
  page='($ in millions)\nFiscal 2025 Fiscal 2026\nQ1 Q2 Q3 Q4 TOTAL Q1 Q2 Q3 Q4 TOTAL\nCapital Expenditures 1 2 3 4 10 5 6 7 8 26'
  rows=oracle.quarter_table(page,'Capital Expenditures',2026,4)
  self.assertEqual(len(rows),8);self.assertEqual(rows[-1],(2026,4,8.0))

 def test_wrong_unit_fiscal_columns_and_missing_total_boundary_are_rejected(self):
  for text in ['millions','Fiscal 2026 Fiscal 2027','Q1 Q2 Q3 Q4 TOTAL']:
   pages=[p.replace(text,'invalid') for p in ORACLE_PAGES]
   with self.assertRaises(ValueError):oracle.parse_oracle_pages(pages,2027,1)

 def test_cumulative_income_or_shifted_actual_dates_are_rejected(self):
  for wrong in ['Nine Months Ended August 31,','Three Months Ended September 30,']:
   pages=ORACLE_PAGES.copy();pages[0]=pages[0].replace('Three Months Ended August 31,',wrong)
   with self.assertRaises(ValueError):oracle.parse_oracle_pages(pages,2027,1)

 def test_non_reconciling_quarter_totals_are_rejected(self):
  with self.assertRaisesRegex(ValueError,'reconcile'):
   oracle.quarter_table(ORACLE_PAGES[1].replace('31,977','41,977'),'GAAP Operating Cash Flow',2027,1)

 def test_rounded_html_summary_does_not_replace_exact_financial_tables(self):
  with self.assertRaisesRegex(ValueError,'rounded narrative'):
   oracle.parse_oracle_html(b'<h1>Q1 FY27 results</h1><p>Total revenues $19.3 billion; cash flow $23 billion.</p>',2027,1)
  html=''.join('<table>'+''.join('<tr><td>'+line+'</td></tr>' for line in page.splitlines())+'</table>' for page in ORACLE_PAGES)
  self.assertEqual(oracle.parse_oracle_html(html.encode(),2027,1)['capex'][-1]['value'],28499)

 def test_reviewed_proof_matches_discovery_and_keeps_original_verification_timestamp(self):
  source=json.loads((pathlib.Path(__file__).resolve().parents[1]/'data/industry/oracle-reviewed.json').read_text(encoding='utf-8'))
  result=oracle.seed_history(source);release={**RELEASE,'url':'https://www.oracle.com/news/announcement/q1fy27-earnings-release-2026-09-10/'}
  proof=oracle.reviewed_proof(result,source,release)
  self.assertEqual(proof['url'],release['url']);self.assertEqual(proof['financialSourceUrl'],source['sourceUrl'])
  self.assertEqual(proof['parsedAt'],source['verifiedAt']);self.assertEqual(proof['basis'],'reviewed_history')
  for changed in [{**release,'quarter':2},{**release,'publishedAt':'2026-10-01'}]:self.assertIsNone(oracle.reviewed_proof(result,source,changed))
  result['series']['ORCL.capex']['observations'][-1]['sourceUrl']='https://other.example/file.pdf'
  self.assertIsNone(oracle.reviewed_proof(result,source,release))

 def test_report_attachment_follows_only_official_links_and_keeps_original_release_identity(self):
  release={**RELEASE,'url':'https://investor.oracle.com/news/q1-results'}
  html=b'<a href="https://evil.example/pressrelease.pdf">Financial results</a><a href="/files/content_files/1q27-pressrelease-September_FINAL.pdf">Earnings release</a>'
  with patch.object(oracle,'fetch_report',side_effect=[(html,STAMP,'htmlhash'),(b'%PDF fixture',STAMP,'pdfhash')]) as fetcher,patch.object(oracle,'PdfReader',return_value=reader(ORACLE_PAGES)):
   parsed,url,stamp,version=oracle.load_release(release,force=True)
  self.assertEqual(url,ORACLE_URL);self.assertEqual(fetcher.call_count,2)
  self.assertTrue(all(c.kwargs['force'] for c in fetcher.call_args_list))
  source=json.loads((pathlib.Path(__file__).resolve().parents[1]/'data/industry/oracle-reviewed.json').read_text(encoding='utf-8'))
  result=oracle.seed_history(source);oracle.update_history(result,parsed,release,url,stamp,version);oracle.derived_series(result)
  self.assertEqual(result['ingestedReleases'][0]['url'],release['url'])
  self.assertEqual(result['ingestedReleases'][0]['financialSourceUrl'],ORACLE_URL)
  self.assertEqual(result['series']['ORCL.capex']['observations'][-1]['value'],284.99)
  self.assertAlmostEqual(result['series']['ORCL.free_cash_flow']['observations'][-1]['value'],-53.96)
  self.assertEqual(result['series']['ORCL.capex']['observations'][-1]['publishedAt'],'2026-09-10')

 def test_domain_confusion_plain_http_and_userinfo_are_rejected(self):
  for url in ['https://investor.oracle.com.evil.example/file.pdf','http://investor.oracle.com/file.pdf','https://user@investor.oracle.com/file.pdf']:
   self.assertFalse(oracle.official_url(url))

 def test_new_report_failure_keeps_numeric_history_and_original_success_time(self):
  source=json.loads((pathlib.Path(__file__).resolve().parents[1]/'data/industry/oracle-reviewed.json').read_text(encoding='utf-8'))
  with tempfile.TemporaryDirectory() as tmp:
   target=pathlib.Path(tmp);(target/'oracle-reviewed.json').write_text(json.dumps(source),encoding='utf-8')
   prior=oracle.seed_history(source);prior['series']['ORCL.capex']['observations'][-1]['value']=290.0
   (target/'oracle.json').write_text(json.dumps(prior),encoding='utf-8');captured=[]
   with patch.object(oracle,'DATA',target),patch.object(oracle,'discovered_candidates',return_value=[RELEASE]),patch.object(oracle,'load_release',side_effect=RuntimeError('HTTP 403')),patch.object(oracle,'fetch_sec_companyfacts',side_effect=RuntimeError('SEC HTTP 403')),patch.object(oracle,'persist',side_effect=lambda result,path:captured.append(copy.deepcopy(result))):oracle.run(force=True)
  result=captured[0];series=result['series']['ORCL.capex']
  self.assertEqual(series['status'],'cached');self.assertEqual(series['observations'][-1]['value'],290)
  self.assertEqual(series['fetchedAt'],source['verifiedAt']);self.assertIn('403',series['error'])
  self.assertEqual(result['ingestedReleases'],[])

class HpeDynamicTests(unittest.TestCase):
 def parse(self,segment=HPE_SEGMENT,margin=HPE_MARGIN,release=None):
  with patch.object(extended,'PdfReader',return_value=reader([segment,margin])):
   return extended.parse_hpe_release(b'fixture',release or {'fiscalYear':2026,'quarter':3})
 def test_restated_scope_actual_end_and_three_month_start(self):
  rows=self.parse()
  self.assertEqual(rows[0]['fiscalPeriod'],'FY2026 Q3');self.assertEqual(rows[0]['periodStart'],'2026-05-01')
  self.assertEqual(rows[1]['periodStart'],'2026-02-01');self.assertEqual(rows[-1]['gross_margin'],29.2)
 def test_quarter_identity_and_cumulative_margin_are_rejected(self):
  with self.assertRaisesRegex(ValueError,'identity'):self.parse(release={'fiscalYear':2026,'quarter':4})
  with self.assertRaisesRegex(ValueError,'quarterly'):self.parse(margin=HPE_MARGIN.replace('three','nine'))
 def test_non_comparable_scope_wrong_units_and_different_margin_dates_are_rejected(self):
  for segment in [HPE_SEGMENT.replace('Cloud & AI','Legacy Server'),HPE_SEGMENT.replace('In millions','In billions')]:
   with self.assertRaises(ValueError):self.parse(segment=segment)
  with self.assertRaisesRegex(ValueError,'margin dates'):self.parse(margin=HPE_MARGIN.replace('April 30, 2026','January 31, 2026'))
 def test_dynamic_next_quarter_is_parsed_and_ingested_with_discovery_original_url(self):
  release={'entity':'HPE','fiscalYear':2026,'quarter':4,'publishedAt':'2026-12-01','url':'https://www.hpe.com/news/q4-release'}
  segment=HPE_SEGMENT.replace('July 31, 2026 April 30, 2026 July 31, 2025','October 31, 2026 July 31, 2026 October 31, 2025')
  margin=HPE_MARGIN.replace('July 31, 2026 April 30, 2026 July 31, 2025','October 31, 2026 July 31, 2026 October 31, 2025')
  with patch.object(extended,'PdfReader',return_value=reader([segment,margin])):
   rows=extended.parse_hpe_release(b'fixture',release)
  builder=extended.Builder(force=True)
  with patch.object(extended,'HPE_HISTORY',()),patch.object(extended,'hpe_candidates',return_value=[release]),patch.object(extended,'load_hpe_release',return_value=(rows,HPE_URL,STAMP,'hash')) as loader:builder.hpe()
  self.assertTrue(loader.call_args.kwargs['force'])
  self.assertEqual(builder.points['HPE.server_revenue']['2026-10-31']['value'],67.66)
  self.assertEqual(builder.ingested[0]['url'],release['url']);self.assertEqual(builder.ingested[0]['financialSourceUrl'],HPE_URL)
 def test_partial_report_failure_retains_successfully_parsed_historical_quarters(self):
  rows=self.parse();builder=extended.Builder()
  with patch.object(extended,'HPE_HISTORY',(extended.HPE_HISTORY[-1],)),patch.object(extended,'hpe_candidates',return_value=[{'entity':'HPE','fiscalYear':2026,'quarter':4,'publishedAt':'2026-12-01','url':'https://www.hpe.com/news/q4-release'}]),patch.object(extended,'load_hpe_release',side_effect=[(rows,HPE_URL,STAMP,'hash'),RuntimeError('timeout')]):
   with self.assertRaisesRegex(ValueError,'timeout'):builder.hpe()
  self.assertEqual(len(builder.points['HPE.server_revenue']),3);self.assertEqual(len(builder.ingested),1)
 def test_non_official_attachment_domain_is_rejected(self):
  release={**extended.HPE_HISTORY[-1],'url':'https://investors.hpe.com/news/q3'}
  with patch.object(extended,'fetch_hpe_report',return_value=(b'<a href="https://evil.example/earnings.pdf">Earnings release</a>',STAMP,'hash')) as fetcher:
   with self.assertRaisesRegex(ValueError,'unavailable'):extended.load_hpe_release(release)
  self.assertEqual(fetcher.call_count,1)

def sec_core_fixture(*,fy=2026,annual=True):
 tags={}
 for tag,base,total in [('RevenueFromContractWithCustomerExcludingAssessedTax',900000000,1300000000),('NetCashProvidedByUsedInOperatingActivities',300000000,450000000),('PaymentsToAcquirePropertyPlantAndEquipment',600000000,800000000)]:
  rows=[{'start':'2025-06-01','end':'2026-02-28','val':base,'filed':'2026-03-15','accn':'0001341439-26-000003','form':'10-Q','fy':fy,'fp':'Q3'}]
  if annual:rows.append({'start':'2025-06-01','end':'2026-05-31','val':total,'filed':'2026-06-15','accn':'0001341439-26-000004','form':'10-K','fy':fy,'fp':'FY'})
  tags[tag]={'units':{'USD':rows}}
 return {'cik':int(oracle.SEC_CIK),'facts':{'us-gaap':tags}}

class OracleSecFallbackTests(unittest.TestCase):
 def seed(self):
  source=json.loads((pathlib.Path(__file__).resolve().parents[1]/'data/industry/oracle-reviewed.json').read_text(encoding='utf-8'))
  return oracle.seed_history(source)
 def test_actual_q4_difference_correct_units_and_original_capex_not_overwritten(self):
  values=oracle.parse_sec_core(json.dumps(sec_core_fixture()).encode(),'2026-10-02')
  self.assertEqual(values['cash_ppe_capex'][-1]['value'],200000000)
  self.assertEqual(values['cash_ppe_capex'][-1]['start'],'2026-03-01')
  self.assertEqual(values['cash_ppe_capex'][-1]['inputs'][0]['fp'],'FY')
  self.assertEqual(values['cash_ppe_capex'][-1]['inputs'][1]['fp'],'Q3')
  result=self.seed();capex=copy.deepcopy(result['series']['ORCL.capex']);net=copy.deepcopy(result['series']['ORCL.net_capex_outlay'])
  release={'entity':'ORCL','url':'https://www.oracle.com/news/q4-fy26','fiscalYear':2026,'quarter':4,'publishedAt':'2026-06-10'}
  oracle.update_sec_core(result,values,[release],STAMP,'sec-hash')
  self.assertEqual(result['series']['ORCL.cash_ppe_capex']['observations'][-1]['value'],2.0)
  self.assertEqual(result['series']['ORCL.cash_ppe_capex']['observations'][-1]['originalValue'],200000000)
  self.assertEqual(result['series']['ORCL.capex'],capex);self.assertEqual(result['series']['ORCL.net_capex_outlay'],net)
  self.assertEqual(result['ingestedReleases'][0]['basis'],'sec_core_metrics')
  self.assertEqual(result['ingestedReleases'][0]['periodEnd'],'2026-05-31')
  self.assertEqual(result['ingestedReleases'][0]['publishedAt'],'2026-06-10')
  current=next(p for p in result['series']['ORCL.revenue']['observations'] if p['periodEnd']=='2026-05-31')
  self.assertEqual(current['publishedAt'],'2026-06-15');self.assertIn('000134143926000004',current['sourceUrl'])
  # The reviewed appendix already has a newer Q1. Fetching an older SEC Q4
  # cannot relabel that newer reviewed observation as newly fetched/ready.
  self.assertEqual(result['series']['ORCL.revenue']['status'],'cached')
  self.assertEqual(result['series']['ORCL.revenue']['fetchedAt'],'2026-09-12')
 def test_wrong_cik_or_non_usd_values_are_rejected(self):
  bad=sec_core_fixture();bad['cik']=723125
  with self.assertRaisesRegex(ValueError,'CIK'):oracle.parse_sec_core(json.dumps(bad).encode(),'2026-10-02')
  bad=sec_core_fixture()
  for table in bad['facts']['us-gaap'].values():table['units']['TWD']=table['units'].pop('USD')
  with self.assertRaisesRegex(ValueError,'unavailable'):oracle.parse_sec_core(json.dumps(bad).encode(),'2026-10-02')
 def test_filing_metadata_from_another_fy_does_not_prove_the_candidate_release(self):
  values=oracle.parse_sec_core(json.dumps(sec_core_fixture(fy=2027)).encode(),'2026-10-02');result=self.seed()
  release={'entity':'ORCL','url':'https://www.oracle.com/news/q4-fy26','fiscalYear':2026,'quarter':4,'publishedAt':'2026-06-10'}
  oracle.update_sec_core(result,values,[release],STAMP,'sec-hash')
  self.assertEqual(result['ingestedReleases'],[])
  self.assertEqual(result['series']['ORCL.cash_ppe_capex']['observations'][-1]['fiscalPeriod'],'FY2026 Q4')
 def test_annual_only_or_missing_required_cash_ppe_does_not_invent_q4(self):
  bad=sec_core_fixture()
  for table in bad['facts']['us-gaap'].values():table['units']['USD']=table['units']['USD'][1:]
  with self.assertRaisesRegex(ValueError,'unavailable'):oracle.parse_sec_core(json.dumps(bad).encode(),'2026-10-02')
  bad=sec_core_fixture();del bad['facts']['us-gaap']['PaymentsToAcquirePropertyPlantAndEquipment']
  with self.assertRaisesRegex(ValueError,'cash_ppe_capex'):oracle.parse_sec_core(json.dumps(bad).encode(),'2026-10-02')
 def test_latest_quarters_must_match_across_core_families(self):
  bad=sec_core_fixture();table=bad['facts']['us-gaap']['PaymentsToAcquirePropertyPlantAndEquipment']['units']['USD']
  table[:]=[{'start':'2025-12-01','end':'2026-02-28','val':200000000,'filed':'2026-03-15','accn':'q3','form':'10-Q','fy':2026,'fp':'Q3'}]
  with self.assertRaisesRegex(ValueError,'do not match'):oracle.parse_sec_core(json.dumps(bad).encode(),'2026-10-02')
 def test_sec_source_failure_keeps_prior_cash_ppe_and_original_fetch_time(self):
  result=self.seed();values=oracle.parse_sec_core(json.dumps(sec_core_fixture()).encode(),'2026-10-02');oracle.update_sec_core(result,values,[],STAMP,'hash');previous=copy.deepcopy(result['series']['ORCL.cash_ppe_capex'])
  with patch.object(oracle,'fetch_sec_companyfacts',side_effect=RuntimeError('HTTP 403')):error=oracle.apply_sec_fallback(result,[],force=True)
  current=result['series']['ORCL.cash_ppe_capex'];self.assertIn('403',error);self.assertEqual(current['status'],'cached')
  self.assertEqual(current['observations'],previous['observations']);self.assertEqual(current['fetchedAt'],STAMP)
  empty=self.seed()
  with patch.object(oracle,'fetch_sec_companyfacts',side_effect=RuntimeError('HTTP 403')):oracle.apply_sec_fallback(empty,[],force=True)
  self.assertEqual(empty['series']['ORCL.cash_ppe_capex']['status'],'fetch_failed');self.assertEqual(empty['series']['ORCL.cash_ppe_capex']['observations'],[])
 def test_negative_cash_ppe_is_not_silently_converted_to_an_outflow(self):
  bad=sec_core_fixture();bad['facts']['us-gaap']['PaymentsToAcquirePropertyPlantAndEquipment']['units']['USD'][-1]['val']=500000000
  with self.assertRaisesRegex(ValueError,'negative'):oracle.parse_sec_core(json.dumps(bad).encode(),'2026-10-02')

if __name__=='__main__':unittest.main()
