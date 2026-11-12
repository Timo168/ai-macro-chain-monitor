import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import industry_schedule as schedule


class ProjectCapacityScheduleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.now = datetime(2026, 11, 12, 8, tzinfo=timezone.utc)
        self.state = {'lastAttemptAt': self.now.isoformat(), 'collectorVersion': 16}
        self.write_snapshot()
        self.data_patch = patch.object(schedule, 'DATA', self.folder)
        self.data_patch.start()

    def tearDown(self):
        self.data_patch.stop()
        self.temp.cleanup()

    def write_snapshot(self, sources=None, audit=True):
        (self.folder/'projects.json').write_text(json.dumps({'projects': [{'id': 'Temple', 'capacityAudit': {'checkedAt': self.now.isoformat()} if audit else None}], 'sources': sources or []}), encoding='utf-8')

    def test_new_capacity_sources_run_even_when_daily_sweep_is_fresh(self):
        with patch.object(schedule, 'run_background', return_value=SimpleNamespace(returncode=0)) as run:
            schedule.refresh_project_capacity(self.state, self.now)
            self.assertEqual(run.call_count, 1)
            self.assertTrue(run.call_args.args[0][-1].endswith('industry_projects.py'))
            self.assertEqual(self.state['projectCapacity']['status'], 'ready')
            schedule.refresh_project_capacity(self.state, self.now+timedelta(minutes=15))
            self.assertEqual(run.call_count, 1)

    def test_daily_collection_is_not_repeated(self):
        with patch.object(schedule, 'run_background') as run:
            schedule.refresh_project_capacity(self.state, self.now, daily_collected=True)
            run.assert_not_called()
            self.assertEqual(self.state['projectCapacity']['collectorVersion'], schedule.PROJECT_CAPACITY_COLLECTOR_VERSION)

    def test_upstream_failure_keeps_last_success_and_retries_with_backoff(self):
        prior = (self.now-timedelta(days=1)).isoformat()
        self.state['projectCapacity'] = {'lastSuccessfulAt': prior}
        self.write_snapshot([{'id': 'EPOCH.AI', 'status': 'fetch_failed'}])
        with patch.object(schedule, 'run_background', return_value=SimpleNamespace(returncode=0)) as run:
            schedule.refresh_project_capacity(self.state, self.now)
            self.assertEqual(self.state['projectCapacity']['lastSuccessfulAt'], prior)
            self.assertEqual(self.state['projectCapacity']['status'], 'cached')
            schedule.refresh_project_capacity(self.state, self.now+timedelta(minutes=10))
            self.assertEqual(run.call_count, 1)
            self.write_snapshot()
            schedule.refresh_project_capacity(self.state, self.now+timedelta(minutes=16))
            self.assertEqual(run.call_count, 2)
            self.assertEqual(self.state['projectCapacity']['status'], 'ready')

    def test_old_snapshot_does_not_complete_new_adapter_installation(self):
        self.write_snapshot(audit=False)
        with patch.object(schedule, 'run_background', return_value=SimpleNamespace(returncode=0)):
            schedule.refresh_project_capacity(self.state, self.now)
        self.assertEqual(self.state['projectCapacity']['status'], 'cached')


if __name__ == '__main__':
    unittest.main()
