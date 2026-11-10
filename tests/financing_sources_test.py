"""Financing series keep publication cadence and failure/cached state distinct."""
import json
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import collect
import schedule

IDS = ('DGS2', 'DTWEXBGS', 'T10Y2Y')


class FinancingScheduleTests(unittest.TestCase):
    def test_two_year_treasury_shares_h15_and_prior_business_day(self):
        self.assertIn('DGS2', schedule.RIDS[18])
        self.assertEqual(schedule.expected_date('DGS2', datetime.fromisoformat('2026-11-09T21:15:00+00:00')), '2026-11-06')

    def test_h10_targets_previous_week_even_when_release_moves_to_tuesday(self):
        self.assertEqual(schedule.RIDS[17], ['DTWEXBGS'])
        for release, expected in [('2026-11-09', '2026-11-06'), ('2026-09-08', '2026-09-04'), ('2026-07-06', '2026-07-02'), ('2026-04-06', '2026-04-03')]:
            with self.subTest(release=release):
                self.assertEqual(schedule.expected_date('DTWEXBGS', datetime.fromisoformat(release+'T21:15:00+00:00')), expected)

    def test_dollar_daily_observations_are_not_marked_stale_during_publication_week(self):
        entry={'releaseId':17, 'status':'ok', 'events':[{'scheduledAt':'2026-11-09T21:15:00+00:00'}, {'scheduledAt':'2026-11-16T21:15:00+00:00'}]}
        current={'checkedAt':'2026-11-12T21:30:00+00:00','status':'ready','observations':[{'date':'2026-11-06','value':121.8803}]}
        needed,info=schedule.release_plan('DTWEXBGS', {'frequency':'daily'}, current, entry, {}, datetime.fromisoformat('2026-11-13T01:00:00+00:00'))
        self.assertFalse(needed)
        self.assertEqual(info['state'], 'waiting_release')
        self.assertEqual(info['expectedObservationDate'], '2026-11-06')
        self.assertEqual(info['expectedDateBasis'], 'previous_business_week')

    def test_dollar_stale_http_success_retries_after_release(self):
        entry={'releaseId':17, 'status':'ok', 'events':[{'scheduledAt':'2026-11-09T21:15:00+00:00'}]}
        current={'checkedAt':'2026-11-09T21:20:00+00:00','status':'ready','observations':[{'date':'2026-10-30','value':120}]}
        needed,info=schedule.release_plan('DTWEXBGS', {'frequency':'daily'}, current, entry, {}, datetime.fromisoformat('2026-11-09T22:00:00+00:00'))
        self.assertTrue(needed)
        self.assertEqual(info['state'], 'awaiting_source')

    def test_spread_checks_have_no_fabricated_release_time(self):
        now=datetime.fromisoformat('2026-11-09T22:00:00+00:00')
        series={'checkedAt':'2026-11-09T21:30:00+00:00','status':'ready'}
        needed,info=schedule.spread_check_plan(series,now)
        self.assertFalse(needed)
        self.assertEqual(info['calendarStatus'],'date_only')
        self.assertEqual(info['checkIntervalMinutes'],60)
        self.assertNotIn('nextReleaseAt',info)
        self.assertTrue(schedule.spread_check_plan({**series,'status':'cached'},now)[0])


class FinancingCollectorTests(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.root=pathlib.Path(directory.name)
        for target,value in [('DATA',self.root),('REGISTRY',[item for item in collect.REGISTRY if item['id'] in IDS])]:
            patcher=patch.object(collect,target,value);patcher.start();self.addCleanup(patcher.stop)
        patcher=patch.dict(collect.os.environ,{'FRED_API_KEY':''});patcher.start();self.addCleanup(patcher.stop)

    def test_success_imports_only_requested_official_series_and_preserves_missing(self):
        raw=b'observation_date,DGS2\n2026-11-05,4.46\n2026-11-06,4.51\n2026-11-09,.\n'
        with patch.object(collect,'download',return_value=raw) as request:
            result=collect.collect(selected=['DGS2'])
        self.assertEqual(request.call_args.args[0],'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2')
        self.assertEqual(list(result['series']),['DGS2'])
        series=result['series']['DGS2']
        self.assertEqual(series['status'],'ready')
        self.assertIsNone(series['sourcePublishedAt'])
        self.assertIsNone(series['observations'][-1]['value'])
        self.assertEqual(series['observations'][1]['value'],4.51)

    def test_first_fetch_failure_has_no_observation_or_success_timestamp(self):
        with patch.object(collect,'download',side_effect=RuntimeError('upstream unavailable')):
            result=collect.collect(selected=['DTWEXBGS'])
        series=result['series']['DTWEXBGS']
        self.assertEqual(series['status'],'fetch_failed')
        self.assertEqual(series['observations'],[])
        self.assertIsNone(series['fetchedAt'])

    def test_failure_keeps_last_success_revision_and_observations(self):
        raw=b'observation_date,T10Y2Y\n2026-11-06,0.35\n2026-11-09,0.32\n'
        with patch.object(collect,'download',return_value=raw):
            first=collect.collect(selected=['T10Y2Y'])['series']['T10Y2Y']
        with patch.object(collect,'download',side_effect=RuntimeError('upstream unavailable')):
            failed=collect.collect(selected=['T10Y2Y'])['series']['T10Y2Y']
        self.assertEqual(failed['status'],'cached')
        for key in ('observations','revision','fetchedAt','lastChange'):
            self.assertEqual(failed[key],first[key])
        self.assertIn('unavailable',failed['error'])


if __name__=='__main__':unittest.main()
