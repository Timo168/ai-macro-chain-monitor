"""Historical bootstrap integrity and live-source priority checks."""
import copy
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from industry_bootstrap import restore_bootstrap


def actual_point(value=123):
    return {'metricId': 'MU.company_revenue', 'periodStart': '2026-02-27', 'periodEnd': '2026-05-28',
            'value': value, 'originalValue': 12300000000, 'publishedAt': '2026-06-25',
            'fetchedAt': '2026-09-30T12:00:00+00:00', 'sourceUrl': 'https://www.sec.gov/Archives/edgar/example-index.html',
            'version': 'original-revision', 'isEstimated': False, 'isRestated': False,
            'formula': 'actual fiscal quarter USD / 100000000',
            'originalItems': {'rawSourceFacts': '[{"val":12300000000}]'}}


def sample_seed():
    return {'definitions': [{'id': 'MU.company_revenue', 'family': 'company_revenue', 'valueType': 'reported'}],
            'series': {'MU.company_revenue': {'observations': [actual_point()], 'status': 'ready',
                        'fetchedAt': '2026-09-30T12:00:00+00:00', 'lastSuccessfulAt': '2026-09-30T12:00:00+00:00',
                        'checkedAt': '2026-09-30T12:01:00+00:00'}},
            'researchReports': [{'id': 'IEA.energy_ai_2026', 'publisher': 'IEA', 'modelUseAllowed': True,
                'modelRole': 'scenario_only', 'observationNature': 'forecast',
                'sourceUrl': 'https://www.iea.org/reports/key-questions-on-energy-and-ai/executive-summary',
                'publishedAt': '2026-04-16', 'fetchedAt': '2026-09-30T12:00:00+00:00',
                'lastSuccessfulAt': '2026-09-30T12:00:00+00:00', 'version': 'report-revision',
                'facts': [{'period': '2025', 'value': 485, 'nature': 'estimate'},
                          {'period': '2030', 'value': 950, 'nature': 'forecast'}], 'status': 'ready'}]}


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='industry-bootstrap-')
        self.folder = pathlib.Path(self.temp.name)
        self.seed = sample_seed()
        self.current = {'generatedAt': '2026-10-01T00:00:00+00:00',
                        'definitions': [{'id': 'MU.company_revenue', 'methodology': 'current definition wins'}],
                        'series': {'MU.company_revenue': {'observations': [], 'status': 'fetch_failed',
                                   'checkedAt': '2026-10-01T00:00:00+00:00', 'error': 'official source offline'}},
                        'researchReports': [{'id': 'IEA.energy_ai_2026', 'facts': [], 'status': 'fetch_failed', 'error': 'official report offline'}]}
        self.write_seed()

    def tearDown(self):
        self.temp.cleanup()

    def write_seed(self, seed=None, series_ids=None, report_ids=None):
        raw = json.dumps(self.seed if seed is None else seed, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        (self.folder / 'sample.json').write_bytes(raw)
        manifest = {'schemaVersion': '1', 'files': {'sample.json': {'sha256': hashlib.sha256(raw).hexdigest(),
                    'seriesIds': ['MU.company_revenue'] if series_ids is None else series_ids,
                    'reportIds': ['IEA.energy_ai_2026'] if report_ids is None else report_ids}}}
        (self.folder / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')

    def restore(self, current=None):
        return restore_bootstrap('sample.json', self.current if current is None else current, self.folder)

    def test_verified_history_preserves_all_original_point_times_values_and_revision(self):
        original = copy.deepcopy(self.current)
        result = self.restore()
        series = result['series']['MU.company_revenue']
        self.assertEqual(series['status'], 'cached')
        self.assertEqual(series['observations'], self.seed['series']['MU.company_revenue']['observations'])
        for field in ['fetchedAt', 'lastSuccessfulAt', 'checkedAt']:
            self.assertEqual(series[field], self.seed['series']['MU.company_revenue'][field])
        self.assertEqual(series['error'], 'official source offline')
        self.assertEqual(series['bootstrapSourceCheckAt'], '2026-10-01T00:00:00+00:00')
        self.assertIn('已核验历史缓存', series['note'])
        self.assertEqual(result['generatedAt'], original['generatedAt'])
        self.assertEqual(result['definitions'], original['definitions'])
        self.assertEqual(self.current, original)

    def test_any_current_valid_numeric_data_wins_even_when_current_status_cached(self):
        current = copy.deepcopy(self.current)
        current['series']['MU.company_revenue'] = {'observations': [actual_point(456)], 'status': 'cached', 'note': 'latest live version'}
        result = self.restore(current)
        self.assertEqual(result['series']['MU.company_revenue'], current['series']['MU.company_revenue'])

    def test_actual_zero_is_valid_live_data_and_not_replaced(self):
        current = copy.deepcopy(self.current)
        current['series']['MU.company_revenue']['observations'] = [actual_point(0)]
        self.assertEqual(self.restore(current)['series']['MU.company_revenue']['observations'][0]['value'], 0)

    def test_null_only_current_series_is_restored_and_original_gaps_remain(self):
        current = copy.deepcopy(self.current)
        current['series']['MU.company_revenue']['observations'] = [actual_point(None)]
        seed = copy.deepcopy(self.seed)
        missing = actual_point(None)
        missing['periodEnd'] = '2026-02-26'
        missing['periodStart'] = '2025-11-28'
        seed['series']['MU.company_revenue']['observations'].insert(0, missing)
        self.write_seed(seed)
        rows = self.restore(current)['series']['MU.company_revenue']['observations']
        self.assertIsNone(rows[0]['value'])
        self.assertEqual(rows[1]['value'], 123)

    def test_tampered_bytes_rejected_and_current_left_unchanged(self):
        original = copy.deepcopy(self.current)
        path = self.folder / 'sample.json'
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'sha256'):
            self.restore()
        self.assertEqual(self.current, original)

    def test_unknown_file_and_path_traversal_rejected(self):
        with self.assertRaisesRegex(ValueError, '未知文件'):
            restore_bootstrap('unknown.json', self.current, self.folder)
        for filename in ['../sample.json', '..\\sample.json', 'C:sample.json', 'manifest.json']:
            with self.assertRaises(ValueError):
                restore_bootstrap(filename, self.current, self.folder)

    def test_manifest_unknown_metric_or_report_id_rejected(self):
        self.write_seed(series_ids=[])
        with self.assertRaisesRegex(ValueError, '未允许'):
            self.restore()
        self.write_seed(report_ids=[])
        with self.assertRaisesRegex(ValueError, '未允许'):
            self.restore()

    def test_illegal_seed_or_current_series_container_rejected(self):
        seed = copy.deepcopy(self.seed)
        seed['series'] = []
        self.write_seed(seed)
        with self.assertRaisesRegex(ValueError, 'series'):
            self.restore()
        self.write_seed()
        current = copy.deepcopy(self.current)
        current['series']['MU.company_revenue'] = []
        with self.assertRaisesRegex(ValueError, 'series'):
            self.restore(current)

    def test_forecast_is_restored_only_in_reports_without_changing_its_identity(self):
        result = self.restore()
        report = result['researchReports'][0]
        seed_report = self.seed['researchReports'][0]
        self.assertEqual(report['status'], 'cached')
        self.assertEqual(report['facts'], seed_report['facts'])
        self.assertEqual(report['modelRole'], 'scenario_only')
        self.assertEqual(report['publishedAt'], seed_report['publishedAt'])
        self.assertEqual(report['fetchedAt'], seed_report['fetchedAt'])
        self.assertEqual(report['version'], seed_report['version'])
        self.assertEqual(set(result['series']), {'MU.company_revenue'})

    def test_forecast_or_estimate_cannot_be_injected_into_actual_series(self):
        for mutate in [lambda seed: seed['definitions'][0].update(valueType='guidance'),
                       lambda seed: seed['series']['MU.company_revenue']['observations'][0].update(nature='forecast'),
                       lambda seed: seed['series']['MU.company_revenue']['observations'][0].update(isEstimated=True)]:
            seed = copy.deepcopy(self.seed)
            mutate(seed)
            self.write_seed(seed)
            with self.assertRaisesRegex(ValueError, 'researchReports'):
                self.restore()

    def test_successful_current_report_facts_have_priority(self):
        current = copy.deepcopy(self.current)
        current['researchReports'][0] = {'id': 'IEA.energy_ai_2026', 'facts': [{'value': 999, 'nature': 'forecast'}], 'status': 'ready', 'version': 'new-live-report'}
        result = self.restore(current)
        self.assertEqual(result['researchReports'], current['researchReports'])

    def test_missing_definition_restored_but_report_without_allowed_scenario_use_rejected(self):
        result = self.restore({'series': {}, 'researchReports': []})
        self.assertEqual(result['definitions'], self.seed['definitions'])
        self.assertEqual(len(result['researchReports']), 1)
        seed = copy.deepcopy(self.seed)
        seed['researchReports'][0]['modelUseAllowed'] = False
        self.write_seed(seed)
        with self.assertRaisesRegex(ValueError, '情景'):
            self.restore()


if __name__ == '__main__':
    unittest.main()
