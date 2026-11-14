import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import pages_watchdog as watch


class PagesWatchdogTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name)
        self.now = datetime(2026, 11, 14, 12, tzinfo=timezone.utc)
        self.stale = self.now - timedelta(hours=2)

    def test_fresh_published_check_never_accesses_actions(self):
        with patch.object(watch, 'published_check', return_value=self.now), patch.object(watch, 'gh_api') as api:
            self.assertEqual(watch.check(self.folder, self.now), 'published_recently')
            api.assert_not_called()

    def test_incomplete_local_record_recovers_on_fresh_published_check(self):
        for saved in ('{', '{}', 'null'):
            path = self.folder / 'pages-watchdog.json'
            path.write_text(saved, encoding='utf-8')
            with patch.object(watch, 'published_check', return_value=self.now), patch.object(watch, 'gh_api') as api:
                self.assertEqual(watch.check(self.folder, self.now), 'published_recently')
                api.assert_not_called()
            self.assertEqual(json.loads(path.read_text())['consecutiveErrors'], 0)

    def test_older_snapshot_waits_for_queued_audit_and_recently_finished_jobs(self):
        old_run = {'status':'completed', 'updated_at':self.stale.isoformat()}
        with patch.object(watch, 'published_check', return_value=self.stale):
            with patch.object(watch, 'gh_api', side_effect=[{'workflow_runs':[old_run]}, {'workflow_runs':[{'status':'queued'}]}]) as api:
                self.assertEqual(watch.check(self.folder, self.now), 'cloud_recent_or_active')
                self.assertEqual(api.call_count, 2)
            with patch.object(watch, 'gh_api', return_value={'workflow_runs':[{'status':'completed','updated_at':self.now.isoformat()}]}) as api:
                self.assertEqual(watch.check(self.folder, self.now), 'cloud_recent_or_active')
                self.assertEqual(api.call_count, 1)

    def test_stalled_dispatches_once_and_does_not_upload_data(self):
        with patch.object(watch, 'published_check', return_value=self.stale), patch.object(watch, 'gh_api', side_effect=[{'workflow_runs':[]}, {'workflow_runs':[]}, {}]) as api:
            self.assertEqual(watch.check(self.folder, self.now), 'requested')
            self.assertEqual(watch.check(self.folder, self.now + timedelta(minutes=15)), 'cooldown')
            api.assert_called_with('actions/workflows/deploy.yml/dispatches', '--method', 'POST', '-f', 'ref=main')
            self.assertEqual(api.call_count,3)
        with watch.exclusive(self.folder/'pages-watchdog.lock'):
            with patch.object(watch, 'published_check') as source:
                self.assertEqual(watch.check(self.folder, self.now + timedelta(hours=1)), 'already_checking')
                source.assert_not_called()

    def test_failed_or_uncertain_requests_back_off_and_recover(self):
        t = self.now
        for i, delay in enumerate((30,60,120,120)):
            errors = [FileNotFoundError('no gh'),RuntimeError('no login'),subprocess.TimeoutExpired(['gh'],18),OSError('offline')]
            with patch.object(watch, 'published_check', return_value=self.stale), patch.object(watch,'gh_api',side_effect=errors[i]):
                self.assertTrue(watch.check(self.folder,t).startswith('check_failed'))
                self.assertEqual(watch.check(self.folder,t+timedelta(minutes=15)),'cooldown')
            state=json.loads((self.folder/'pages-watchdog.json').read_text())
            t+=timedelta(minutes=delay)
            self.assertEqual(state['nextAttemptAt'],t.isoformat())
        with patch.object(watch, 'published_check',return_value=t):
            self.assertEqual(watch.check(self.folder,t),'published_recently')
        self.assertEqual(json.loads((self.folder/'pages-watchdog.json').read_text())['consecutiveErrors'],0)

    def test_cli_runs_without_prompts_and_fails_on_an_unknown_status(self):
        with patch.object(subprocess, 'run') as run:
            run.return_value.returncode=1
            with self.assertRaises(RuntimeError):
                watch.gh_api('actions/workflows/deploy.yml/runs')
            _, kwargs=run.call_args
            self.assertEqual(kwargs['stdin'],subprocess.DEVNULL)
            self.assertEqual(kwargs['env']['GH_PROMPT_DISABLED'],'1')
            self.assertEqual(kwargs['creationflags'],getattr(subprocess,'CREATE_NO_WINDOW',0))
            self.assertEqual(kwargs['timeout'],18)


if __name__ == '__main__':
    unittest.main()
