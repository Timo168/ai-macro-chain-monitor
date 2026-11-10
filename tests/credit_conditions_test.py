"""Public credit indicators: source parsing, revisions, cadence and source failures."""
import json
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime
from unittest.mock import patch

ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import collect
import schedule
from credit_conditions import EBP_URL, parse_ebp, source_check_plan


class CreditParserTests(unittest.TestCase):
    def test_ebp_column_is_not_gz_spread_or_probability(self):
        raw=b'date,gz_spread,ebp,est_prob\n2026-09-01,1.5,-0.3,0.1\n2026-10-01,1.7,0,0.2\n2026-11-01,2,.,0.3\n'
        self.assertEqual(parse_ebp(raw),[{'date':'2026-09-01','value':-0.3},{'date':'2026-10-01','value':0.0},{'date':'2026-11-01','value':None}])

    def test_rejects_bad_schema_duplicate_month_and_infinite_value(self):
        for raw in [b'date,gz_spread\n2026-09-01,1.5\n', b'date,ebp\n2026-09-01,1\n2026-09-01,2\n', b'date,ebp\n2026-09-02,1\n', b'date,ebp\n2026-09-01,inf\n',b'date,ebp\n2026-09-01,.\n']:
            with self.subTest(raw=raw),self.assertRaises(ValueError):parse_ebp(raw)

    def test_official_sample_fixture_has_three_points_and_correct_units(self):
        fixture=json.loads((ROOT/'tests/fixtures/credit-source-samples.json').read_text())
        for key,entry in fixture['series'].items():
            with self.subTest(key=key):
                self.assertEqual(len(entry['samples']),3)
                self.assertEqual(len(entry['sourceSha256']),64)
                self.assertTrue(entry['sourceUrl'].startswith(('https://fred.stlouisfed.org/','https://www.federalreserve.gov/')))
        self.assertEqual(fixture['series']['EBP']['unit'],'percentage points')
        self.assertEqual(fixture['series']['DRTSCILM']['frequency'],'quarterly')


class CreditScheduleTests(unittest.TestCase):
    def test_sloos_uses_survey_quarter_not_prior_quarter(self):
        self.assertEqual(schedule.RIDS[191],['DRTSCILM','DRTSCIS'])
        for stamp,expected in [('2026-11-02T19:00:00+00:00','2026-10-01'),('2026-02-02T19:00:00+00:00','2026-01-01')]:
            self.assertEqual(schedule.expected_date('DRTSCILM',datetime.fromisoformat(stamp)),expected)

    def test_date_only_fred_calendar_is_preserved_without_fake_clock(self):
        html='''All times are US Central Time<div id="release-dates-pager"><table><tr><td colspan="2"><span>Monday November 02, 2026</span></td></tr><tr><td colspan="2"><a href="/release?rid=191">SLOOS</a></td></tr></table></div>'''
        with patch.object(schedule,'download',return_value=html.encode()):
            result=schedule.fetch_calendar(191,datetime.fromisoformat('2026-11-10T10:00:00+00:00'))
        self.assertEqual(result['events'][0]['scheduledDate'],'2026-11-02')
        self.assertNotIn('scheduledAt',result['events'][0])

    def test_date_only_sloos_retries_old_quarter_and_handles_fresh_data(self):
        entry={'status':'ok','sourceUrl':'https://fred.stlouisfed.org/releases/calendar?rid=191','events':[{'scheduledDate':'2026-11-02'}]}
        now=datetime.fromisoformat('2026-11-02T22:00:00+00:00')
        current={'status':'ready','checkedAt':'2026-11-02T20:00:00+00:00','observations':[{'date':'2026-10-01','value':1.7}]}
        needed,info=schedule.date_only_release_plan('DRTSCILM',current,entry,now)
        self.assertFalse(needed)
        self.assertEqual(info['state'],'source_check')
        self.assertEqual(info['expectedObservationDate'],'2026-10-01')
        self.assertNotIn('nextReleaseAt',info)
        old={**current,'checkedAt':'2026-11-02T12:00:00+00:00','observations':[{'date':'2026-07-01','value':2}]}
        needed,info=schedule.date_only_release_plan('DRTSCILM',old,entry,now)
        self.assertTrue(needed)
        self.assertEqual(info['state'],'awaiting_source')

    def test_ebp_monthly_research_is_polled_not_falsely_scheduled(self):
        now=datetime.fromisoformat('2026-11-10T20:00:00+00:00')
        current={'checkedAt':'2026-11-10T19:00:00+00:00','status':'ready'}
        needed,info=source_check_plan('EBP',current,now)
        self.assertFalse(needed)
        self.assertEqual(info['checkIntervalMinutes'],360)
        self.assertNotIn('nextReleaseAt',info)
        self.assertTrue(source_check_plan('EBP',{**current,'status':'cached'},now)[0])

    def test_gas_calendar_has_correct_release_id_and_date_only_check(self):
        self.assertEqual(schedule.RIDS[342],['DHHNGSP'])
        needed,info=schedule.date_only_release_plan('DHHNGSP',{}, {'events':[{'scheduledDate':'2026-11-12'}]},datetime.fromisoformat('2026-11-10T20:00:00+00:00'))
        self.assertTrue(needed)
        self.assertEqual(info['nextReleaseDate'],'2026-11-12')
        self.assertIsNone(info['expectedObservationDate'])


class CreditCollectorTests(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.root=pathlib.Path(directory.name)
        for name,value in [('DATA',self.root),('REGISTRY',[i for i in collect.REGISTRY if i['id']=='EBP'])]:
            p=patch.object(collect,name,value);p.start();self.addCleanup(p.stop)

    def test_fetch_preserves_official_ebp_source_and_historical_revision(self):
        with patch.object(collect,'download_ebp',return_value=b'date,ebp\n2026-09-01,-0.3\n2026-10-01,-0.2\n') as request:
            before=collect.collect(selected=['EBP'])['series']['EBP']
        self.assertEqual(request.call_count,1)
        with patch.object(collect,'download_ebp',return_value=b'date,ebp\n2026-09-01,-0.35\n2026-10-01,-0.2\n'):
            after=collect.collect(selected=['EBP'])['series']['EBP']
        self.assertEqual(after['lastChange']['kind'],'revision')
        self.assertEqual(after['lastChange']['revised'],1)
        self.assertGreater(after['revisionCount'],before['revisionCount'])
        self.assertEqual(after['sourceUrl'],EBP_URL)
        self.assertIsNone(after['sourcePublishedAt'])
        self.assertEqual(len(list((self.root/'versions/EBP').glob('*.csv'))),2)

    def test_first_failure_and_failure_after_success_are_distinct(self):
        with patch.object(collect,'download_ebp',side_effect=RuntimeError('HTTP 503')):
            first=collect.collect(selected=['EBP'])['series']['EBP']
        self.assertEqual(first['status'],'fetch_failed');self.assertEqual(first['observations'],[])
        with patch.object(collect,'download_ebp',return_value=b'date,ebp\n2026-09-01,-0.3\n'):
            success=collect.collect(selected=['EBP'])['series']['EBP']
        with patch.object(collect,'download_ebp',side_effect=RuntimeError('HTTP 503')):
            cached=collect.collect(selected=['EBP'])['series']['EBP']
        self.assertEqual(cached['status'],'cached')
        for key in ('observations','fetchedAt','revision'):
            self.assertEqual(cached[key],success[key])

    def test_official_file_regression_retains_successful_cache(self):
        with patch.object(collect,'download_ebp',return_value=b'date,ebp\n2026-09-01,-0.3\n2026-10-01,-0.2\n'):
            before=collect.collect(selected=['EBP'])['series']['EBP']
        with patch.object(collect,'download_ebp',return_value=b'date,ebp\n2026-09-01,-0.3\n'):
            after=collect.collect(selected=['EBP'])['series']['EBP']
        self.assertEqual(after['status'],'cached');self.assertEqual(before['observations'],after['observations'])


if __name__=='__main__':unittest.main()
