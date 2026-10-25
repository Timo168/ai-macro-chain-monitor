"""Daily observations must catch up after publication, including stale HTTP 200s."""
import pathlib,sys,unittest
from datetime import datetime,timezone
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import schedule

def stamp(value):return datetime.fromisoformat(value)

class MacroScheduleTests(unittest.TestCase):
    def setUp(self):
        self.due=stamp('2026-10-23T21:15:00+00:00')
        self.now=stamp('2026-10-23T22:00:00+00:00')
        self.entry={'releaseId':18,'status':'ok','sourceUrl':'https://fred.stlouisfed.org/releases/calendar?rid=18','events':[{'scheduledAt':self.due.isoformat()}]}
    def series(self,last='2026-10-21',checked='2026-10-23T21:20:00+00:00',status='ready'):
        return {'status':status,'checkedAt':checked,'observations':[{'date':last,'value':4.96}]}
    def plan(self,key='DGS10',series=None,state=None,now=None,entry=None):
        return schedule.release_plan(key,{'frequency':'daily'},series or self.series(),entry or self.entry,state if state is not None else {},now or self.now)
    def test_rate_http_success_with_old_observation_is_retried(self):
        needed,info=self.plan()
        self.assertTrue(needed)
        self.assertEqual(info['state'],'awaiting_source')
        self.assertEqual(info['expectedObservationDate'],'2026-10-22')
    def test_up_to_date_rate_stops_retrying_before_next_release(self):
        needed,info=self.plan(series=self.series(last='2026-10-22'))
        self.assertFalse(needed);self.assertEqual(info['state'],'waiting_release')
    def test_bounded_backoff_avoids_repeated_fetches(self):
        state={'attempts':{'DGS10_'+self.due.isoformat():3}}
        needed,info=self.plan(state=state)
        self.assertFalse(needed);self.assertEqual(info['retryNotBeforeAt'],'2026-10-23T23:20:00+00:00')
    def test_h15_uses_prior_business_day_not_release_day(self):
        for publication,expected in [('2026-10-26T21:15:00+00:00','2026-10-23'),('2026-10-13T21:15:00+00:00','2026-10-09'),('2026-11-27T22:15:00+00:00','2026-11-25'),('2026-04-06T21:15:00+00:00','2026-04-02'),('2027-01-04T22:15:00+00:00','2026-12-31')]:
            with self.subTest(publication=publication):
                self.assertEqual(schedule.expected_date('DFII10',stamp(publication)),expected)
    def test_future_calendar_event_does_not_fetch_before_publication(self):
        entry={**self.entry,'events':[{'scheduledAt':'2026-10-23T23:15:00+00:00'}]}
        needed,info=self.plan(entry=entry)
        self.assertFalse(needed);self.assertIsNone(info['expectedObservationDate'])
    def test_brent_retries_without_inventing_same_day_expectation(self):
        state={};entry={**self.entry,'releaseId':212}
        needed,info=self.plan(key='DCOILBRENTEU',entry=entry,state=state)
        self.assertTrue(needed);self.assertIsNone(info['expectedObservationDate'])
        needed,info=self.plan(key='DCOILBRENTEU',entry=entry,state=state,series=self.series(last='2026-10-22'))
        self.assertFalse(needed);self.assertEqual(info['state'],'waiting_release')
    def test_brent_post_release_retry_window_is_bounded(self):
        needed,info=self.plan(key='DCOILBRENTEU',entry={**self.entry,'releaseId':212},now=stamp('2026-10-24T06:00:00+00:00'))
        self.assertFalse(needed);self.assertEqual(info['state'],'waiting_release')
    def test_missing_calendar_has_daily_fallback(self):
        needed,info=self.plan(entry={**self.entry,'events':[]},series=self.series(checked='2026-10-22T21:20:00+00:00'))
        self.assertTrue(needed);self.assertEqual(info['state'],'calendar_unavailable')
    def test_http_failure_retains_retry_even_if_old_date_was_current(self):
        needed,_=self.plan(series=self.series(last='2026-10-22',status='cached'))
        self.assertTrue(needed)
    def test_actual_gap_is_not_presented_as_a_fifteen_minute_promise(self):
        with patch.dict(schedule.os.environ,{'MACRO_CHECK_MINUTES':'15'}):
            state={};meta=schedule.cadence_metadata(self.now,'2026-10-23T17:00:00+00:00',state,'github_actions')
        self.assertEqual(meta['targetIntervalMinutes'],15)
        self.assertEqual(meta['actualIntervalMinutes'],300)
        self.assertEqual(meta['cadenceStatus'],'delayed')
        self.assertTrue(meta['nextCheckIsEstimate'])
        self.assertEqual(meta['nextCheckAt'],'2026-10-24T03:00:00+00:00')
        self.assertEqual(state['recentIntervalMinutes'],[300])
    def test_first_run_has_unknown_cadence(self):
        meta=schedule.cadence_metadata(self.now,None,{},'github_actions')
        self.assertIsNone(meta['actualIntervalMinutes']);self.assertEqual(meta['cadenceStatus'],'unknown')
    def test_failed_source_list_includes_unchanged_cache_and_excludes_unconfigured(self):
        sources={'checked_ok':{'status':'ready'},'not_checked_cache':{'status':'cached'},'not_checked_failed':{'status':'fetch_failed'},'not_configured':{'status':'not_configured'},'unpublished':{'status':'not_published'}}
        self.assertEqual(schedule.failed_sources(sources),['not_checked_cache','not_checked_failed'])

if __name__=='__main__':unittest.main()
