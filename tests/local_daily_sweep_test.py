import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import industry_schedule as schedule


class LocalDailySweepTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path=Path(temp.name)/'scheduler.json'
        self.now=datetime(2026,11,14,13,tzinfo=timezone.utc)
        self.scripts=schedule.DAILY_SCRIPTS[:3]
        self.enterContext(patch.object(schedule,'DAILY_SCRIPTS',self.scripts))
        self.discover=self.enterContext(patch.object(schedule,'financial_release_checks',return_value=[]))
        self.collect=self.enterContext(patch.object(schedule,'daily_collector',return_value=None))

    def run_sweep(self,state,times):
        with patch.object(schedule.time,'monotonic',side_effect=times):
            return schedule.local_daily_sweep(self.path,state,self.now,100)

    def restore(self):
        return json.loads(self.path.read_text(encoding='utf-8'))

    def test_budget_stops_before_next_step_and_resume_uses_actual_results(self):
        state={'collectorVersion':15}
        self.collect.return_value='adapter failed'
        self.assertFalse(self.run_sweep(state,[5,20,101]))
        state=self.restore()
        self.assertEqual(state['collectorVersion'],15)
        self.assertNotIn('lastAttemptAt',state)
        self.assertEqual(state['localDailySweep']['finished'],{'discovery':[],self.scripts[0]:['adapter failed']})
        self.collect.return_value=None
        self.assertTrue(self.run_sweep(state,[0,15]))
        self.discover.assert_called_once()
        self.assertEqual([call.args[0] for call in self.collect.call_args_list],list(self.scripts))
        self.assertEqual(self.restore()['localDailySweep']['finished'][self.scripts[0]],['adapter failed'])

    def test_interrupted_step_is_retried_and_never_assumed_complete(self):
        self.collect.side_effect=[None,KeyboardInterrupt()]
        with self.assertRaises(KeyboardInterrupt):
            self.run_sweep({},[0,1,2])
        state=self.restore()
        self.assertEqual(list(state['localDailySweep']['finished']),['discovery',self.scripts[0]])
        self.collect.reset_mock(side_effect=True)
        self.assertTrue(self.run_sweep(state,[3,4]))
        self.assertEqual([call.args[0] for call in self.collect.call_args_list],list(self.scripts[1:]))

    def test_scheduler_commits_daily_completion_only_after_all_steps_return(self):
        self.path.write_text('{"collectorVersion":15}',encoding='utf-8')
        with patch.object(schedule,'DATA',self.path.parent),patch.object(schedule,'retry_monthly_revenue') as auxiliary:
            with patch.object(schedule.time,'monotonic',side_effect=[1,2,101]):
                schedule.run(build_research=False,local_deadline=100)
            first=self.restore()
            self.assertEqual(first['collectorVersion'],15)
            self.assertNotIn('lastAttemptAt',first)
            self.collect.return_value='source unavailable'
            with patch.object(schedule.time,'monotonic',side_effect=[1,2,101]):
                schedule.run(build_research=False,local_deadline=100)
            final=self.restore()
            self.assertNotIn('localDailySweep',final)
            self.assertEqual(final['collectorVersion'],16)
            self.assertIn('lastAttemptAt',final)
            self.assertEqual(final['dailyFailures'],['source unavailable']*2)
            auxiliary.assert_not_called()
        self.discover.assert_called_once()

    def test_new_code_or_broken_progress_restarts_without_claiming_success(self):
        self.assertFalse(self.run_sweep({},[0,1,101]))
        record=self.restore()['localDailySweep']
        for changes in [{'version':'obsolete'},{'finished':{'discovery':'invalid'}},
                        {'finished':{self.scripts[0]:[]}}, {'startedAt':'bad date'}]:
            with self.subTest(changes=changes):
                self.collect.reset_mock()
                self.assertTrue(self.run_sweep({'localDailySweep':{**record,**changes}},[0,1,2,3]))
                self.assertEqual([call.args[0] for call in self.collect.call_args_list],list(self.scripts))

    def test_unreadable_local_state_restarts_without_marking_any_collector_done(self):
        for bad_state in ['{','[]']:
            with self.subTest(bad_state=bad_state):
                self.path.write_text(bad_state,encoding='utf-8')
                with patch.object(schedule,'DATA',self.path.parent),patch.object(schedule.time,'monotonic',return_value=101):
                    schedule.run(build_research=False,local_deadline=100)
                recovered=self.restore()
                self.assertNotIn('lastAttemptAt',recovered)
                self.assertEqual(recovered['localDailySweep']['finished'],{})
                self.collect.assert_not_called()


if __name__=='__main__':
    unittest.main()
