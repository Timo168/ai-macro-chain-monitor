import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from industry_project_capacity_cleanview import SPECS, collect_cleanview, parse_public_capacity

CHECKED = "2026-11-12T04:00:00Z"
FETCHED = "2026-11-12T03:00:00Z"


def page(spec=SPECS[0], value="240 MW", *, name=None, owner="Meta", href=None, heading=None,
         date="November 11, 2026", extra="", definition=True):
    name = spec["name"] if name is None else name
    href = spec["path"] if href is None else href
    heading = f"Data centers in {spec['state']}" if heading is None else heading
    meaning = "Power capacity is the electricity a campus is built to draw from the grid." if definition else ""
    return f'''<h1>{heading}</h1><p>Last updated {date}.</p><p>{meaning}</p>
      <table><thead><tr><th>#</th><th>Campus</th><th>Developer</th><th>County</th><th>Operating capacity</th></tr></thead>
      <tbody><tr><td>1</td><td><a href="{href}">{name}</a></td><td>{owner}</td><td>{spec['county']}</td><td>{value}</td></tr></tbody></table>{extra}'''


class PublicCapacityParserTests(unittest.TestCase):
    def test_exact_operating_capacity_and_date(self):
        result = parse_public_capacity(page(), SPECS[0], CHECKED)
        self.assertEqual(result["valueMw"], 240)
        self.assertEqual(result["asOfDate"], "2026-11-11")
        self.assertEqual(result["publishedAt"], "2026-11-11")
        self.assertEqual(result["status"], "ready")

    def test_range_stays_a_bound_not_point(self):
        result = parse_public_capacity(page(SPECS[1], "Under 200 MW"), SPECS[1], CHECKED)
        self.assertIsNone(result["valueMw"])
        self.assertEqual(result["upperBoundMw"], 200)
        self.assertEqual(result["valueQualifier"], "less_than")

    def test_does_not_read_google_or_pagewide_mw(self):
        result = parse_public_capacity(page(name="Google Mesa", extra="<p>Meta Mesa 5000 MW</p><script>Meta Mesa 9000 MW</script>"), SPECS[0], CHECKED)
        self.assertIsNone(result["valueMw"])
        self.assertEqual(result["status"], "not_published")

    def test_does_not_read_full_buildout_table(self):
        future_table = page(value="999 MW").split("<table>")[1].replace("Operating capacity", "Full build-out")
        result = parse_public_capacity(page(extra="<table>" + future_table), SPECS[0], CHECKED)
        self.assertEqual(result["valueMw"], 240)

    def test_rejects_identity_or_definition_changes(self):
        for kwargs in ({"owner": "Google"}, {"href": "/data-centers/arizona/google-mesa"},
                       {"heading": "Data centers in Texas"}, {"definition": False}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                parse_public_capacity(page(**kwargs), SPECS[0], CHECKED)

    def test_empty_never_becomes_zero(self):
        for value in ("", "—", "On paid plans"):
            with self.subTest(value=value):
                result = parse_public_capacity(page(value=value), SPECS[0], CHECKED)
                self.assertIsNone(result["valueMw"])
                self.assertEqual(result["status"], "not_published")

    def test_unrecognized_or_invalid_value_fails(self):
        for value in ("0 MW", "-1 MW", "nan MW", "200–999 MW", "240 IT MW"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_public_capacity(page(value=value), SPECS[0], CHECKED)

    def test_future_or_missing_date_fails(self):
        for date in ("November 13, 2026", "unknown"):
            with self.subTest(date=date), self.assertRaises(ValueError):
                parse_public_capacity(page(date=date), SPECS[0], CHECKED)


class PublicCapacityCollectionTests(unittest.TestCase):
    def setUp(self):
        self.projects = [{"id": spec["projectId"], "status": "operational", "powerCapacityMw": None, "isEstimated": False} for spec in SPECS]

    def fetched(self, url):
        spec = next(spec for spec in SPECS if spec["url"] == url)
        return page(spec, "240 MW" if spec == SPECS[0] else "Under 200 MW").encode(), FETCHED, "raw-sha"

    def test_collects_only_two_facility_evidences_and_preserves_official(self):
        before = copy.deepcopy(self.projects)
        result, sources = collect_cleanview(self.projects, CHECKED, self.fetched)
        self.assertEqual(self.projects, before)
        self.assertEqual(len(sources), 2)
        for project in result:
            self.assertEqual(project["status"], "operational")
            self.assertFalse(project["isEstimated"])
            self.assertIsNone(project["powerCapacityMw"])
            evidence = project["capacityEvidence"][0]
            self.assertEqual(evidence["capacityKind"], "facility_power")
            self.assertEqual(evidence["sourceType"], "institutional_estimate")
            self.assertEqual(evidence["lastSuccessfulAt"], FETCHED)

    def test_failure_keeps_both_point_and_bound_with_original_date(self):
        result, _ = collect_cleanview(self.projects, CHECKED, self.fetched)
        def fail(_):
            raise OSError("network unavailable")
        cached, sources = collect_cleanview(result, "2026-11-13T04:00:00Z", fail)
        for old_project, project in zip(result, cached):
            old, evidence = old_project["capacityEvidence"][0], project["capacityEvidence"][0]
            self.assertEqual(evidence["status"], "cached")
            for field in ("valueMw", "upperBoundMw", "asOfDate", "publishedAt", "lastSuccessfulAt", "fetchedAt", "version"):
                self.assertEqual(evidence.get(field), old.get(field))
        self.assertTrue(all(s["status"] == "cached" for s in sources))

    def test_initial_failure_has_no_fabricated_date_or_zero(self):
        def fail(_):
            raise OSError("network unavailable")
        result, _ = collect_cleanview(self.projects, CHECKED, fail)
        for project in result:
            evidence = project["capacityEvidence"][0]
            self.assertEqual(evidence["status"], "fetch_failed")
            self.assertIsNone(evidence["valueMw"])
            self.assertIsNone(evidence["asOfDate"])

    def test_removed_ranking_row_keeps_last_success(self):
        result, _ = collect_cleanview(self.projects, CHECKED, self.fetched)
        def removed(url):
            spec = next(s for s in SPECS if s["url"] == url)
            return page(spec, name="Another campus").encode(), FETCHED, "new-raw"
        cached, _ = collect_cleanview(result, CHECKED, removed)
        self.assertTrue(all(p["capacityEvidence"][0]["status"] == "cached" for p in cached))

    def test_retry_bypasses_failed_raw_cache_and_recovers(self):
        def fail(_):
            raise OSError("network unavailable")
        failed, _ = collect_cleanview(self.projects, CHECKED, fail)
        calls = []
        def recover(url, **kwargs):
            calls.append(kwargs)
            return self.fetched(url)
        recovered, _ = collect_cleanview(failed, CHECKED, recover)
        self.assertEqual(calls, [{"force": True}, {"force": True}])
        self.assertTrue(all(p["capacityEvidence"][0]["status"] == "ready" for p in recovered))

    def test_changed_capacity_retains_original_revision(self):
        result, _ = collect_cleanview(self.projects, CHECKED, self.fetched)
        def revised(url):
            spec = next(s for s in SPECS if s["url"] == url)
            return page(spec, "250 MW", date="November 12, 2026").encode(), FETCHED, "revised-raw"
        updated, _ = collect_cleanview(result, CHECKED, revised)
        self.assertEqual(updated[0]["capacityEvidence"][0]["valueMw"], 250)
        self.assertEqual(updated[0]["capacityEvidenceHistory"][0]["valueMw"], 240)
        self.assertEqual(updated[1]["capacityEvidenceHistory"][0]["upperBoundMw"], 200)


if __name__ == "__main__":
    unittest.main()
