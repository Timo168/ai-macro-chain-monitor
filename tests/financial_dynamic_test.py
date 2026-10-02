"""Official-release adapters: changing URLs/quarters, dated columns, and failure lineage."""
import io,json,pathlib,sys,tempfile,unittest,hashlib
from types import SimpleNamespace
from unittest.mock import patch,MagicMock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import industry_common as common
import industry_collect as companies
import industry_hardware as hardware
import industry_releases as releases

STAMP='2026-10-01T01:00:00+00:00'

def table(headers,rows,caption='Three Months Ended (in millions, except percentages)'):
 return '<table><tr><td>'+caption+'</td></tr><tr>'+''.join('<td>'+h+'</td>' for h in headers)+'</tr>'+''.join('<tr>'+''.join('<td>'+str(v)+'</td>' for v in row)+'</tr>' for row in rows)+'</table>'

def dell_fixture():
 # Actual official statement shape: current/prior quarter followed by a percent
 # change and year-to-date columns. Only the first two amount columns are used.
 dates=['October 31, 2025','November 1, 2024']
 return ('<h2>Dell Technologies Delivers Third Quarter Fiscal 2026 Financial Results</h2>'+table(dates,[['Total net revenue',30000,25000,20,80000,70000],['Gross margin',6000,5000,20,17000,16000]])+table(dates,[['AI-Optimized Servers',10000,5000,100,20000,10000],['Traditional Servers and Networking',6000,4500,33,12000,9000],['Storage',4000,3800,5,10000,9500]])).encode()

def amd_fixture():
 headers=['September 27, 2025','June 28, 2025','September 28, 2024']
 return (table(headers,[['Net Revenue:'],['Data Center Segment',5000,4000,3000],['Total net revenue',9000,8000,7000],['Operating Income:'],['Data Center Segment',1200,1000,700]])+table(headers,[['Net revenue',9000,8000,7000],['Gross margin','53%','52%','51%']])).encode()

def nvidia_fixture():
 return ('<h1>NVIDIA Announces Financial Results for First Quarter Fiscal 2027</h1><p>The quarter ended April 26, 2026. Data Center revenue was $75.2 billion.</p><table><tr><td>GAAP</td></tr><tr><td>($ in millions, except earnings per share)</td><td>Q1 FY27</td><td>Q4 FY26</td><td>Q1 FY26</td></tr><tr><td>Revenue</td><td>81615</td><td>70000</td><td>40000</td></tr><tr><td>Gross margin</td><td>74.9%</td><td>73%</td><td>70%</td></tr></table>').encode()

class DynamicFinancialTests(unittest.TestCase):
 def test_unknown_release_url_and_quarter_are_added_without_new_code(self):
  item={'entity':'NVDA','fiscalYear':2027,'quarter':3,'publishedAt':'2026-09-25','url':'https://nvidianews.nvidia.com/news/a-new-official-release-id','title':'Third Quarter Fiscal 2027'}
  with patch.object(companies,'discovered_candidates',side_effect=lambda entity:[item] if entity=='NVDA' else []):items=companies.sources()
  self.assertTrue(any(row['year']==2027 and row['q']==3 and row['url']==item['url'] for row in items))
  self.assertFalse(any(row['entity']=='GOOG' and row['year']==2026 and row['q']>2 for row in items))

 def test_confirmed_url_overrides_bootstrap_for_same_fiscal_quarter(self):
  item={'entity':'AMD','fiscalYear':2026,'quarter':2,'publishedAt':'2026-08-04','url':'https://ir.amd.com/news-events/press-releases/detail/9000/new-earnings-id'}
  with patch.object(companies,'discovered_candidates',return_value=[item]):items=hardware.hardware_sources('AMD')
  q2=[row for row in items if row['year']==2026 and row['q']==2]
  self.assertEqual(len(q2),1);self.assertEqual(q2[0]['url'],item['url'])

 def test_external_and_unpublished_candidates_are_never_requested(self):
  safe={'entity':'AMD','fiscalYear':2026,'quarter':2,'publishedAt':'2026-08-04','url':'https://ir.amd.com/news-events/press-releases/detail/9000/results'}
  for bad in [dict(safe,url='https://ir.amd.com.evil.test/results'),dict(safe,url='http://ir.amd.com/results'),dict(safe,publishedAt='2099-08-04'),dict(safe,publishedAt=None),dict(safe,quarter=5),dict(safe,entity='NVDA')]:
   self.assertFalse(companies.valid_candidate(bad,'AMD'))
  self.assertTrue(companies.valid_candidate(safe,'AMD'))

 def test_dell_dated_quarter_columns_ignore_percentage_and_ytd(self):
  result=hardware.parse_dell_release(dell_fixture(),2026,3)
  self.assertEqual(result['periods'],['2025-10-31','2024-11-01'])
  self.assertEqual(result['values']['revenue'],[30000,25000])
  self.assertEqual(result['values']['ai_server_revenue'],[10000,5000])

 def test_dell_refuses_mismatched_segment_dates_fiscal_year_and_units(self):
  payload=dell_fixture()
  for bad in [payload.replace(b'October 31, 2025',b'July 31, 2025',1),payload.replace(b'Fiscal 2026',b'Fiscal 2025'),payload.replace(b'in millions',b'in billions')]:
   with self.assertRaises(ValueError):hardware.parse_dell_release(bad,2026,3)

 def test_nvidia_uses_actual_52_week_date_and_validates_fiscal_identity(self):
  values,end=companies.extract_nvidia(nvidia_fixture(),2027,1)
  self.assertEqual(end,'2026-04-26');self.assertEqual(values['revenue'],[81615,40000]);self.assertEqual(values['datacenter_revenue'],[75200])
  with self.assertRaises(ValueError):companies.extract_nvidia(nvidia_fixture(),2027,2)
  with self.assertRaises(ValueError):companies.extract_nvidia(nvidia_fixture().replace(b'April 26, 2026',b'July 26, 2026'),2027,1)

 def test_nvidia_fourth_quarter_and_fiscal_year_title_is_supported(self):
  payload=nvidia_fixture().replace(b'First Quarter Fiscal 2027',b'Fourth Quarter and Fiscal 2026').replace(b'April 26, 2026',b'January 25, 2026').replace(b'Q1 FY27',b'Q4 FY26').replace(b'Q1 FY26',b'Q4 FY25')
  _,end=companies.extract_nvidia(payload,2026,4)
  self.assertEqual(end,'2026-01-25')

 def test_pdf_actual_quarter_and_unit_must_match_candidate(self):
  text='Alphabet Announces Second Quarter 2026 Results\nfinancial results for the quarter ended June 30, 2026.\n(in millions)\nRevenues 100 150\n'
  reader=SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda:text)])
  with patch.object(companies,'PdfReader',return_value=reader):
   self.assertEqual(companies.extract_pdf(b'pdf','GOOG',2026,2)['revenue'],[150,100])
   with self.assertRaises(ValueError):companies.extract_pdf(b'pdf','GOOG',2026,3)

 def test_html_pdf_attachment_is_official_and_unique(self):
  url='https://abc.xyz/investor/events/event-details/'
  good='<a href="https://s206.q4cdn.com/479360582/files/earnings-release.pdf">Earnings release</a>'
  with patch.object(companies,'fetch',return_value=(b'%PDF payload',STAMP,'hash')) as fetched:
   raw,document_url,_,_=companies.release_pdf(good.encode(),'GOOG',url)
   self.assertTrue(raw.startswith(b'%PDF'));self.assertIn('/479360582/',document_url);self.assertEqual(fetched.call_count,1)
  for bad in [good.replace('/479360582/','/other-company/'),good.replace('s206.q4cdn.com','example.com'),good+good.replace('earnings-release.pdf','other-earnings-release.pdf')]:
   with self.assertRaises(ValueError):companies.release_pdf(bad.encode(),'GOOG',url)

 def test_forced_failed_refresh_keeps_original_values_and_fetch_time(self):
  item={'entity':'NVDA','year':2027,'q':1,'publishedAt':'2026-05-27','url':'https://nvidianews.nvidia.com/news/current-quarter'}
  with tempfile.TemporaryDirectory(prefix='financial-dynamic-') as temp,patch.object(companies,'DATA',pathlib.Path(temp)),patch.object(companies,'FORCE',True):
   with patch.object(companies,'fetch',return_value=(nvidia_fixture(),STAMP,'original-version')):first=companies.load_one(item)
   with patch.object(companies,'fetch',side_effect=RuntimeError('upstream offline')):second=companies.load_one(item)
   self.assertEqual(second['status'],'cached');self.assertEqual(second['values'],first['values']);self.assertEqual(second['fetchedAt'],STAMP);self.assertEqual(second['parsedAt'],first['parsedAt']);self.assertEqual(second['publishedAt'],item['publishedAt'])

 def test_direct_official_source_failure_keeps_parsed_cache_and_uses_hidden_fallback(self):
  item={'entity':'NVDA','year':2027,'q':1,'publishedAt':'2026-05-27','url':'https://nvidianews.nvidia.com/news/current-quarter'}
  with tempfile.TemporaryDirectory(prefix='official-source-failure-') as temp:
   folder=pathlib.Path(temp)
   with patch.object(companies,'DATA',folder),patch.object(releases,'DATA',folder),patch.object(companies,'FORCE',True):
    with patch.object(companies,'fetch',return_value=(nvidia_fixture(),STAMP,'verified-hash')):first=companies.load_one(item)
    session=MagicMock();session.__enter__.return_value=session;session.get.side_effect=RuntimeError('official HTTP 403')
    with patch.object(releases.requests,'Session',return_value=session),patch.object(releases,'fetch',side_effect=RuntimeError('fallback source failure')) as fallback:second=companies.load_one(item)
    self.assertFalse(session.trust_env);session.get.assert_called_once_with(item['url'],timeout=20);fallback.assert_called_once_with(item['url'],force=True)
    self.assertEqual(second['status'],'cached');self.assertEqual(second['fetchedAt'],first['fetchedAt']);self.assertEqual(second['values'],first['values']);self.assertEqual(second['parsedAt'],first['parsedAt'])

 def test_force_only_refreshes_latest_fiscal_release(self):
  older={'entity':'AMD','year':2026,'q':1,'url':'https://ir.amd.com/old-release'}
  newer={'entity':'AMD','year':2026,'q':2,'url':'https://ir.amd.com/new-release'}
  with patch.object(hardware,'hardware_sources',return_value=[older,newer]),patch.object(hardware,'FORCE',True):items=hardware.targeted_sources('AMD',{'AMD'})
  self.assertEqual([row['_force'] for row in items],[False,True])
  with patch.object(hardware,'hardware_sources') as unrequested:self.assertEqual(hardware.targeted_sources('DELL',{'AMD'}),[])
  unrequested.assert_not_called()

 def test_old_publication_metadata_uses_real_date_and_never_quarter_end(self):
  item={'entity':'NVDA','year':2027,'q':1,'url':'https://nvidianews.nvidia.com/news/current-quarter'}
  dated=nvidia_fixture().replace(b'<h1>',b'<meta property="article:published_time" content="2026-05-20T16:20:00-04:00"><h1>')+b'<p>Next quarter guidance ends July 26, 2026.</p>'
  self.assertEqual(companies.source_publication(item,dated,'2026-04-26'),'2026-05-20T16:20:00-04:00')
  self.assertIsNone(companies.source_publication(item,nvidia_fixture(),'2026-04-26'))
  bad=nvidia_fixture().replace(b'The quarter ended',b'SANTA CLARA, Calif. - Results for the quarter ended')
  self.assertIsNone(companies.source_publication(item,bad,'2026-04-26'))

 def test_cached_publication_backfill_keeps_original_fetch_parse_and_values(self):
  item={'entity':'NVDA','year':2027,'q':1,'url':'https://nvidianews.nvidia.com/news/current-quarter'}
  raw=nvidia_fixture().replace(b'<h1>',b'<meta property="article:published_time" content="2026-05-20T16:20:00-04:00"><h1>');digest=hashlib.sha256(raw).hexdigest()
  prior={**item,'parserVersion':'3','values':{'revenue':[81615,40000]},'start':None,'end':'2026-04-26','fetchedAt':STAMP,'parsedAt':STAMP,'checkedAt':common.now(),'version':digest,'status':'ready','publishedAt':None}
  with tempfile.TemporaryDirectory(prefix='publication-backfill-') as temp:
   folder=pathlib.Path(temp);(folder/'parsed').mkdir();(folder/'raw').mkdir();(folder/'raw'/(digest+'.html')).write_bytes(raw)
   (folder/'parsed'/(hashlib.sha256(item['url'].encode()).hexdigest()+'.json')).write_text(json.dumps(prior),encoding='utf-8')
   with patch.object(companies,'DATA',folder),patch.object(companies,'FORCE',False),patch.object(companies,'fetch') as fetched:record=companies.load_one(item)
   fetched.assert_not_called();self.assertEqual(record['publishedAt'],'2026-05-20T16:20:00-04:00')
   for key in ('fetchedAt','parsedAt','values','version'):self.assertEqual(record[key],prior[key])

 def test_hardware_dynamic_ingestion_preserves_units_and_success_ledger(self):
  dell={'entity':'DELL','year':2026,'q':3,'url':'https://investors.delltechnologies.com/news-releases/news-release-details/new-id','publishedAt':'2025-11-25'}
  amd={'entity':'AMD','year':2025,'q':3,'url':'https://ir.amd.com/news-events/press-releases/detail/9000/new-id','publishedAt':'2025-11-04'}
  def response(url,**kwargs):
   if url==dell['url']:return dell_fixture(),STAMP,'dell-hash'
   if url==amd['url']:return amd_fixture(),STAMP,'amd-hash'
   raise RuntimeError('no TSM fixture')
  with tempfile.TemporaryDirectory(prefix='hardware-dynamic-') as temp:
   folder=pathlib.Path(temp)
   with patch.object(hardware,'DATA',folder),patch.object(common,'DATA',folder),patch.object(hardware,'hardware_sources',side_effect=lambda entity:[dell if entity=='DELL' else amd]),patch.object(hardware,'fetch',side_effect=response):hardware.run()
   result=json.loads((folder/'hardware.json').read_text(encoding='utf-8'))
   self.assertEqual(result['series']['DELL.ai_server_revenue']['observations'][-1]['value'],100)
   self.assertEqual(result['series']['AMD.datacenter_revenue']['observations'][-1]['value'],50)
   self.assertEqual({r['entity'] for r in result['ingestedReleases']},{'DELL','AMD'})
   ledger=next(r for r in result['ingestedReleases'] if r['entity']=='DELL');self.assertEqual(ledger['quarter'],3);self.assertEqual(ledger['fiscalYear'],2026);self.assertEqual(ledger['publishedAt'],'2025-11-25');self.assertEqual(ledger['periodEnd'],'2025-10-31')
   before=result['series']['DELL.ai_server_revenue']['observations']
   with patch.object(hardware,'DATA',folder),patch.object(common,'DATA',folder),patch.object(hardware,'hardware_sources',return_value=[amd]),patch.object(hardware,'fetch',side_effect=response) as targeted:hardware.run(['AMD'])
   scoped=json.loads((folder/'hardware.json').read_text(encoding='utf-8'))
   self.assertEqual(scoped['series']['DELL.ai_server_revenue'],result['series']['DELL.ai_server_revenue']);self.assertEqual([call.args[0] for call in targeted.call_args_list],[amd['url']])
   with patch.object(hardware,'DATA',folder),patch.object(common,'DATA',folder),patch.object(hardware,'hardware_sources',side_effect=lambda entity:[dell if entity=='DELL' else amd]),patch.object(hardware,'fetch',side_effect=RuntimeError('offline')):hardware.run()
   cached=json.loads((folder/'hardware.json').read_text(encoding='utf-8'))
   self.assertEqual(cached['series']['DELL.ai_server_revenue']['status'],'cached');self.assertEqual(cached['series']['DELL.ai_server_revenue']['observations'],before);self.assertEqual(cached['ingestedReleases'],scoped['ingestedReleases']);self.assertTrue(all(r['status']=='fetch_failed' for r in cached['sourceRuns']))

 def test_calculated_cash_flow_retains_cached_input_status(self):
  record={'entity':'MSFT','year':2026,'q':4,'url':'https://www.microsoft.com/en-us/investor/earnings/fy-2026-q4/press-release-webcast','publishedAt':'2026-07-29','start':'2026-04-01','end':'2026-06-30','values':{'revenue':[100,90],'capex':[20,15],'operating_cash_flow':[40,35]},'fetchedAt':STAMP,'version':'verified','status':'cached','checkedAt':STAMP,'parsedAt':STAMP,'error':'offline'}
  with tempfile.TemporaryDirectory(prefix='company-cached-derived-') as temp:
   folder=pathlib.Path(temp)
   with patch.object(companies,'DATA',folder),patch.object(common,'DATA',folder),patch.object(companies,'sources',return_value=[record]),patch.object(companies,'load_one',return_value=record):companies.run(['MSFT'])
   result=json.loads((folder/'companies.json').read_text(encoding='utf-8'))
   self.assertEqual(result['series']['MSFT.free_cash_flow']['status'],'cached')
   self.assertAlmostEqual(result['series']['MSFT.free_cash_flow']['observations'][-1]['value'],0.2)
   self.assertEqual(result['series']['MSFT.free_cash_flow']['fetchedAt'],STAMP)
   self.assertEqual(result['series']['MSFT.capex_ratio']['status'],'cached')

if __name__=='__main__':unittest.main()
