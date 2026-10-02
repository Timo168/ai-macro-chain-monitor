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

if __name__=='__main__':unittest.main()
