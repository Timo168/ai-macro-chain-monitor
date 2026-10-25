"""No network: a repeated download must not masquerade as new economic data."""
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import collect


class ObservationChangesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.patch = patch.object(collect, 'DATA', pathlib.Path(self.directory.name))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.conn = collect.connect()
        self.addCleanup(self.conn.close)

    def save(self, points, at):
        return collect.save(self.conn, 'DGS10', points, json.dumps(points).encode(), 'https://fred.stlouisfed.org/series/DGS10', at)

    def test_no_change_check_preserves_last_change_and_revision(self):
        points = [{'date': '2026-10-21', 'value': 5.13}]
        first = self.save(points, '2026-10-22T00:00:00Z')
        second = self.save(points, '2026-10-22T00:15:00Z')
        self.assertEqual(second['lastChange'], first['lastChange'])
        self.assertEqual(second['revision'], first['revision'])
        self.assertNotEqual(second['fetchedAt'], first['fetchedAt'])

    def test_placeholder_is_not_new_observation_and_filling_it_is(self):
        self.save([{'date': '2026-10-21', 'value': 5.13}], '2026-10-22T00:00:00Z')
        placeholder = self.save([{'date': '2026-10-21', 'value': 5.13}, {'date': '2026-10-22', 'value': None}], '2026-10-23T00:00:00Z')
        self.assertEqual(placeholder['lastChange']['at'], '2026-10-22T00:00:00Z')
        published = self.save([{'date': '2026-10-21', 'value': 5.13}, {'date': '2026-10-22', 'value': 5.1}], '2026-10-23T00:15:00Z')
        self.assertEqual(published['lastChange']['kind'], 'new_observation')
        self.assertEqual(published['lastChange']['added'], 1)

    def test_new_observation_and_revision_are_both_identified(self):
        self.save([{'date': '2026-10-21', 'value': 5.13}], '2026-10-22T00:00:00Z')
        changed = self.save([{'date': '2026-10-21', 'value': 5.12}, {'date': '2026-10-22', 'value': 5.1}], '2026-10-23T00:00:00Z')
        self.assertEqual(changed['lastChange']['kind'], 'new_and_revised')
        self.assertEqual((changed['lastChange']['added'], changed['lastChange']['revised']), (1, 1))

    def test_backfill_withdrawal_and_null_are_not_zero(self):
        self.save([{'date': '2026-10-21', 'value': 5.13}], '2026-10-22T00:00:00Z')
        backfill = self.save([{'date': '2026-10-20', 'value': 5.2}, {'date': '2026-10-21', 'value': 5.13}], '2026-10-22T00:15:00Z')
        self.assertEqual(backfill['lastChange']['kind'], 'history_backfill')
        removed = self.save([{'date': '2026-10-21', 'value': None}], '2026-10-22T00:30:00Z')
        self.assertEqual(removed['lastChange']['removed'], 1)
        self.assertEqual(removed['lastChange']['revised'], 1)
        self.assertIsNone(self.conn.execute('SELECT value FROM observations WHERE observation_date=? ORDER BY fetched_at DESC', ('2026-10-20',)).fetchone()[0])

    def test_failure_and_recovery_do_not_forge_new_observations(self):
        first = self.save([{'date': '2026-10-21', 'value': 5.13}], '2026-10-22T00:00:00Z')
        failed = collect.source_status(first.copy(), 'cached', '2026-10-22T00:15:00Z')
        self.assertEqual(failed['lastChange'], first['lastChange'])
        repeated = collect.source_status(failed.copy(), 'cached', '2026-10-22T00:30:00Z')
        self.assertEqual(repeated['statusChangedAt'], failed['statusChangedAt'])
        self.conn.execute('UPDATE snapshots SET payload=? WHERE series_id=?', (json.dumps(repeated), 'DGS10'))
        recovered = self.save(first['observations'], '2026-10-22T00:45:00Z')
        self.assertEqual(recovered['statusChange'], {'at': '2026-10-22T00:45:00Z', 'from': 'cached', 'to': 'ready'})
        self.assertEqual(recovered['lastChange'], first['lastChange'])

    def test_legacy_unchanged_snapshot_has_no_invented_change(self):
        self.conn.execute('INSERT INTO snapshots VALUES(?,?)', ('DGS10', json.dumps({'observations': [{'date': '2026-10-21', 'value': 5.13}], 'status': 'ready', 'revision': 'old'})))
        updated = self.save([{'date': '2026-10-21', 'value': 5.13}], '2026-10-22T00:00:00Z')
        self.assertIsNone(updated['lastChange'])
        self.assertEqual(updated['revision'], 'old')


if __name__ == '__main__':
    unittest.main()
