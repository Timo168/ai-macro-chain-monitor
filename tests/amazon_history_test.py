"""Amazon historical URL repair, quarter columns, provenance and retry behavior."""
import hashlib,json,pathlib,sys,tempfile,unittest
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import industry_collect as companies
import industry_common as common
import industry_schedule as schedule

STAMP='2026-11-10T00:00:00+00:00'

class AmazonHistoryTests(unittest.TestCase):
 def test_reviewed_history_uses_actual_old_directory_and_preserves_new_directory(self):
  with patch.object(companies,'discovered_candidates',return_value=[]):
   sources={(item['year'],item['q']):item for item in companies.sources() if item['entity']=='AMZN'}
  for year in (2024,2025):
   for quarter in (1,2,3):
    self.assertEqual(sources[year,quarter]['url'],f'https://s2.q4cdn.com/299287126/files/doc_financials/{year}/q{quarter}/AMZN-Q{quarter}-{year}-Earnings-Release.pdf')
  self.assertIn('/doc_earnings/2025/q4/earnings-result/',sources[2025,4]['url'])
  self.assertIn('/doc_earnings/2026/q2/earnings-result/',sources[2026,2]['url'])

 def test_quarterly_gross_cash_purchases_ignore_ytd_ttm_and_incentives(self):
  # Facts independently sampled from Amazon's 2024 Q1/Q2/Q3 release PDFs.
  # The first pair is prior/current quarter, followed by YTD/TTM columns.
  cases=[(1,'March 31','first','(14,207) (14,925) (62,901) (53,447)',14925,14207),
         (2,'June 30','second','(11,455) (17,620) (25,662) (32,545) (58,632) (59,612)',17620,11455),
         (3,'September 30','third','(12,479) (22,620) (38,141) (55,165) (54,733) (69,753)',22620,12479)]
  for quarter,end,word,values,current,prior in cases:
   with self.subTest(quarter=quarter):
    text=f'Amazon.com announces {word} quarter results\nfinancial results for its quarter ended {end}, 2024.\nConsolidated Statements of Cash Flows\n(in millions)\nThree Months Ended\nPurchases of property and equipment {values}\nProceeds from property and equipment sales and incentives 1,181 1,342\nTotal net sales 100 200\n'
    with patch.object(companies,'PdfReader',return_value=SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda:text)])):
     actual=companies.extract_pdf(b'%PDF','AMZN',2024,quarter)
     self.assertEqual(actual['capex'],[-current,-prior])
     with self.assertRaises(ValueError):companies.extract_pdf(b'%PDF','AMZN',2025,quarter)

 def test_failed_parsed_cache_is_retried_without_faking_success(self):
  item={'entity':'AMZN','year':2025,'q':3,'url':'https://s2.q4cdn.com/299287126/files/doc_financials/2025/q3/AMZN-Q3-2025-Earnings-Release.pdf'}
  prior={**item,'parserVersion':'3','values':{'revenue':[180169,158877],'capex':[-35095,-22620]},'start':'2025-07-01','end':'2025-09-30','publishedAt':'2025-10-30','fetchedAt':STAMP,'parsedAt':STAMP,'checkedAt':common.now(),'version':'original-hash','status':'cached'}
  with tempfile.TemporaryDirectory() as folder:
   data=pathlib.Path(folder);(data/'parsed').mkdir()
   (data/'parsed'/(hashlib.sha256(item['url'].encode()).hexdigest()+'.json')).write_text(json.dumps(prior),encoding='utf-8')
   with patch.object(companies,'DATA',data),patch.object(companies,'FORCE',False),patch.object(companies,'fetch',side_effect=RuntimeError('offline')) as fetch:
    result=companies.load_one(item)
   fetch.assert_called_once();self.assertEqual(result['status'],'cached')
   for key in ('values','fetchedAt','parsedAt','version','publishedAt'):self.assertEqual(result[key],prior[key])

 def test_merge_backfills_quarters_and_preserves_existing_latest_and_revision_ledger(self):
  url='https://s2.q4cdn.com/299287126/files/doc_financials/2025/q3/AMZN-Q3-2025-Earnings-Release.pdf'
  record={'entity':'AMZN','year':2025,'q':3,'url':url,'documentUrl':url,'publishedAt':'2025-10-30','start':'2025-07-01','end':'2025-09-30','values':{'revenue':[180169,158877],'capex':[-35095,-22620]},'fetchedAt':STAMP,'version':'report-hash','status':'ready','checkedAt':STAMP}
  current=common.observation('AMZN.capex','2026-06-30',542.08,'https://example.com/latest','2026-08-01T00:00:00+00:00','latest-hash','2026-04-01','FY2026 Q2',published='2026-07-30')
  with tempfile.TemporaryDirectory() as folder:
   data=pathlib.Path(folder);(data/'companies.json').write_text(json.dumps({'definitions':[{'id':'AMZN.capex','entity':'AMZN'}],'series':{'AMZN.capex':{'observations':[current],'status':'ready'}}}),encoding='utf-8')
   with patch.object(companies,'DATA',data),patch.object(common,'DATA',data),patch.object(companies,'sources',return_value=[record]),patch.object(companies,'load_one',return_value=record):companies.run(['AMZN'])
   result=json.loads((data/'companies.json').read_text(encoding='utf-8'));points={p['periodEnd']:p for p in result['series']['AMZN.capex']['observations']}
   self.assertEqual(points['2024-09-30']['value'],226.20);self.assertEqual(points['2025-09-30']['value'],350.95)
   self.assertEqual(points['2026-06-30'],current)
   point=points['2024-09-30'];self.assertEqual(point['periodStart'],'2024-07-01');self.assertEqual(point['publishedAt'],'2025-10-30')
   self.assertEqual(point['sourceUrl'],url);self.assertEqual(point['originalValue'],-22620);self.assertEqual(point['originalUnit'],'USD million')
   self.assertEqual(point['originalItems']['column'],'prior-year comparable quarter');self.assertTrue((data/'industry.sqlite').exists())

class AmazonRepairScheduling(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.data=pathlib.Path(self.temp.name)
  self.patch=patch.object(schedule,'DATA',self.data);self.patch.start()
  self.current=datetime(2026,11,10,tzinfo=timezone.utc)
 def tearDown(self):self.patch.stop();self.temp.cleanup()
 def write_complete(self):
  points=[{'periodEnd':period,'value':10,'sourceUrl':'https://example.com/report','version':'hash','fetchedAt':STAMP} for period in schedule.AMAZON_HISTORY_PERIODS]
  (self.data/'companies.json').write_text(json.dumps({'series':{'AMZN.capex':{'observations':points}}}),encoding='utf-8')
 def test_missing_history_triggers_only_amazon_even_when_daily_and_latest_are_current(self):
  state={'collectorVersion':16,'lastAttemptAt':STAMP,'financialReleases':{'lastAttemptAt':STAMP}}
  def repair(*args,**kwargs):self.write_complete();return SimpleNamespace(returncode=0)
  with patch.object(schedule,'run_background',side_effect=repair) as run:
   self.assertEqual(schedule.repair_amazon_history(state,self.current),[])
   self.assertEqual(run.call_args.args[0][-2:],['--entity','AMZN'])
   self.assertEqual(pathlib.Path(run.call_args.args[0][1]).name,'industry_collect.py')
  with patch.object(schedule,'run_background') as repeated:schedule.repair_amazon_history(state,self.current+timedelta(hours=1))
  repeated.assert_not_called();self.assertEqual(state['historyRepairs']['amazon-cash-purchases-2024-v1']['status'],'ready')
 def test_failure_keeps_missing_state_and_bounded_retry(self):
  state={}
  with patch.object(schedule,'now',return_value=STAMP),patch.object(schedule,'run_background',side_effect=TimeoutError('offline')) as run:
   failures=schedule.repair_amazon_history(state,self.current)
   self.assertTrue(failures);self.assertEqual(run.call_count,1)
   schedule.repair_amazon_history(state,self.current+timedelta(minutes=5));self.assertEqual(run.call_count,1)
   schedule.repair_amazon_history(state,self.current+timedelta(minutes=16));self.assertEqual(run.call_count,2)
  self.assertEqual(state['historyRepairs']['amazon-cash-purchases-2024-v1']['status'],'partial_cache')
 def test_daily_collection_does_not_collect_company_twice(self):
  with patch.object(schedule,'run_background') as run:schedule.repair_amazon_history({},self.current,daily_collected=True)
  run.assert_not_called()

if __name__=='__main__':unittest.main()
