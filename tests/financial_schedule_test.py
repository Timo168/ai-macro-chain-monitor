"""Release scheduling works independently of the browser and hides children."""
import importlib.util,json,pathlib,tempfile,unittest
from datetime import datetime,timezone,timedelta
from unittest.mock import patch
import sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import industry_schedule as schedule

class ReleaseScheduling(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.data=pathlib.Path(self.temp.name)
  self.patch=patch.object(schedule,'DATA',self.data);self.patch.start()
  self.current=datetime(2026,10,2,tzinfo=timezone.utc)
  self.release={'entity':'DELL','fiscalYear':2027,'quarter':3,'publishedAt':'2026-10-01','url':'https://investors.delltechnologies.com/actual-report'}
  (self.data/'release-discovery.json').write_text(json.dumps({'entities':{'DELL':{'status':'ready','releases':[self.release]}}}),encoding='utf-8')
 def tearDown(self):self.patch.stop();self.temp.cleanup()
 def call(self,state=None,**kwargs):
  state=state if state is not None else {}
  with patch.object(schedule,'run_background',return_value=type('Result',(),{'returncode':0})()) as run:
   schedule.financial_release_checks(state,self.current,**kwargs)
   return state,run.call_args_list
 def test_discovery_precedes_ingestion_and_new_release_triggers_adapter(self):
  state,calls=self.call()
  self.assertIn('industry_releases.py',calls[0].args[0][1]);self.assertIn('industry_hardware.py',calls[1].args[0][1])
  self.assertIn('--force',calls[1].args[0]);self.assertEqual(state['financialReleases']['ingestionAttempts']['DELL']['releaseKey'],schedule.release_key(self.release))
  self.assertEqual(calls[1].args[0][-2:],['--entity','DELL'])
 def test_confirmed_ingestion_avoids_recollecting_same_report(self):
  (self.data/'hardware.json').write_text(json.dumps({'ingestedReleases':[self.release]}),encoding='utf-8')
  _,calls=self.call();self.assertEqual(len(calls),1)
 def test_retry_backoff_avoids_repeat_requests_before_due(self):
  state={'financialReleases':{'lastAttemptAt':self.current.isoformat(),'ingestionAttempts':{'DELL':{'releaseKey':schedule.release_key(self.release),'lastAttemptAt':self.current.isoformat(),'failureCount':4}}}}
  _,calls=self.call(state);self.assertEqual(len(calls),0)
 def test_source_failure_does_not_trigger_a_guessed_future_report(self):
  (self.data/'release-discovery.json').write_text(json.dumps({'entities':{'DELL':{'status':'fetch_failed','releases':[]}}}),encoding='utf-8')
  state,calls=self.call();self.assertEqual(len(calls),1);self.assertEqual(state['financialReleases']['sourceFailures'],['DELL'])
 def test_daily_collector_does_not_run_twice(self):
  _,calls=self.call(daily_scripts={'industry_hardware.py'});self.assertEqual(len(calls),1)
 def test_new_report_starts_its_own_retry_count(self):
  state={'financialReleases':{'lastAttemptAt':self.current.isoformat(),'ingestionAttempts':{'DELL':{'releaseKey':'older-report','lastAttemptAt':self.current.isoformat(),'failureCount':10}}}}
  state,calls=self.call(state);self.assertEqual(len(calls),1);self.assertEqual(state['financialReleases']['ingestionAttempts']['DELL']['failureCount'],1)
 def test_windows_child_startup_flags_and_no_visible_console(self):
  with patch.object(schedule.subprocess,'run') as run:
   schedule.run_background(['python','collector.py'])
   self.assertEqual(run.call_args.kwargs['creationflags'],schedule.CREATE_NO_WINDOW)
   self.assertEqual(run.call_args.kwargs['startupinfo'],schedule.WINDOWS_STARTUPINFO)
   self.assertEqual(run.call_args.kwargs['stdout'],schedule.subprocess.DEVNULL)
 def test_reference_collectors_precede_research_and_use_hidden_runner(self):
  with patch.object(schedule,'run_background',return_value=type('Result',(),{'returncode':0})()) as run:
   schedule.refresh_research()
   self.assertEqual([pathlib.Path(c.args[0][1]).name for c in run.call_args_list],['research_market.py','research_alfred.py','build-investment-research.mjs'])
 def test_reference_timeout_still_builds_conclusion_with_last_cached_values(self):
  success=type('Result',(),{'returncode':0})()
  with patch.object(schedule,'run_background',side_effect=[TimeoutError('source timeout'),success,success]) as run:
   schedule.refresh_research();self.assertEqual(len(run.call_args_list),3)

 def write_company_release(self,entity,published='2026-07-27',url=None,ingested=None):
  url=url or ('https://ir.amkor.com/news-releases/actual-quarter' if entity=='AMKR' else 'https://www.entegris.com/en/home/about-us/news/actual-quarter.html')
  release={'entity':entity,'fiscalYear':2026,'quarter':2,'publishedAt':published,'url':url}
  (self.data/'release-discovery.json').write_text(json.dumps({'entities':{entity:{'status':'ready','releases':[release]}}}),encoding='utf-8')
  if ingested is not None:
   filename='packaging-evidence.json' if entity=='AMKR' else 'materials-evidence.json'
   (self.data/filename).write_text(json.dumps({'ingestedReleases':[ingested]}),encoding='utf-8')
  return release

 def test_new_packaging_and_materials_reports_trigger_their_own_adapters(self):
  for entity,script in [('AMKR','industry_packaging.py'),('ENTG','industry_materials.py')]:
   with self.subTest(entity=entity):
    release=self.write_company_release(entity)
    state,calls=self.call()
    self.assertEqual([pathlib.Path(c.args[0][1]).name for c in calls],['industry_releases.py',script])
    self.assertIn('--force',calls[-1].args[0])
    self.assertEqual(state['financialReleases']['ingestionAttempts'][entity]['releaseKey'],schedule.release_key(release))

 def test_amkor_publication_time_precision_does_not_reingest_verified_quarter(self):
  release=self.write_company_release('AMKR',published='2026-07-27T16:03:28-04:00')
  self.write_company_release('AMKR',published=release['publishedAt'],ingested={**release,'publishedAt':'2026-07-27'})
  _,calls=self.call()
  self.assertEqual([pathlib.Path(c.args[0][1]).name for c in calls],['industry_releases.py'])

 def test_entegris_verified_corporate_alias_does_not_reingest_ir_report(self):
  release=self.write_company_release('ENTG',published='2026-08-04')
  self.write_company_release('ENTG',published=release['publishedAt'],ingested={**release,'url':'https://investor.entegris.com/news/news-details/2026/actual-quarter/default.aspx','sourceAliases':[release['url']]})
  _,calls=self.call()
  self.assertEqual([pathlib.Path(c.args[0][1]).name for c in calls],['industry_releases.py'])

 def test_release_alias_does_not_hide_a_different_quarter_or_publication(self):
  for edits in ({'quarter':1},{'publishedAt':'2026-08-03'},{'sourceAliases':[]}):
   with self.subTest(edits=edits):
    release=self.write_company_release('ENTG',published='2026-08-04')
    ingested={**release,'url':'https://investor.entegris.com/news/news-details/2026/actual-quarter/default.aspx','sourceAliases':[release['url']],**edits}
    self.write_company_release('ENTG',published=release['publishedAt'],ingested=ingested)
    _,calls=self.call()
    self.assertIn('industry_materials.py',calls[-1].args[0][1])

 def test_new_collectors_use_hidden_windows_process_and_no_shell(self):
  for script in ('industry_packaging.py','industry_materials.py'):
   with self.subTest(script=script),patch.object(schedule.subprocess,'run') as run:
    schedule.run_background([sys.executable,str(schedule.ROOT/'scripts'/script),'--force'])
    options=run.call_args.kwargs
    for stream in ('stdin','stdout','stderr'):
     self.assertEqual(options[stream],schedule.subprocess.DEVNULL)
    self.assertFalse(options.get('shell',False))
    if sys.platform=='win32':
     self.assertTrue(options['creationflags'] & schedule.subprocess.CREATE_NO_WINDOW)
     self.assertTrue(options['startupinfo'].dwFlags & schedule.subprocess.STARTF_USESHOWWINDOW)
     self.assertEqual(options['startupinfo'].wShowWindow,schedule.subprocess.SW_HIDE)

if __name__=='__main__':unittest.main()
