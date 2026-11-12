import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from industry_project_capacity import (EPOCH_DATA, EPOCH_TIMELINE, EPOCH_SPECS, enrich_project_capacities,
    epoch_template, failed_evidence, official_evidence, parse_csv, parse_epoch_project, retain_evidence)

NOW = "2026-11-12T04:00:00+00:00"
FETCHED = "2026-11-12T03:00:00+00:00"
TEMPLE = "META-US-TX-TEMPLE"


def page(name="Meta Temple", updated="Sep. 30, 2026"):
    return f"<html><title>{name} | Epoch AI</title><body>Updated {updated} {name}</body></html>".encode()


def directory(name="Meta Temple", current="178"):
    return [{"Name": name, "Owner": "Meta #confident", "Country": "United States", "Current power (MW)": current, "Calculations sheet": "https://docs.google.com/spreadsheets/d/example"}]


def timeline(name="Meta Temple", day="2026-09-30", it="178", facility="231"):
    return [{"Data center": name, "Date": day, "IT power (MW)": it, "Power (MW)": facility}]


class EpochParserTests(unittest.TestCase):
    def test_exact_it_and_facility_are_separate_with_dates(self):
        evidence = parse_epoch_project(TEMPLE, directory(), timeline(), page(), NOW, FETCHED, "v1")
        current = {item["capacityKind"]: item for item in evidence if item["scope"] == "current"}
        self.assertEqual(current["it_power"]["valueMw"], 178)
        self.assertEqual(current["facility_power"]["valueMw"], 231)
        self.assertEqual(current["it_power"]["asOfDate"], "2026-09-30")
        self.assertEqual(current["it_power"]["publishedAt"], "2026-09-30")
        self.assertEqual(current["it_power"]["sourceType"], "institutional_estimate")
        self.assertIn("CC-BY", current["it_power"]["license"])

    def test_future_phase_never_becomes_current_when_target_passes(self):
        rows = timeline("Meta Hyperion", "2026-04-19", "0", "0") + timeline("Meta Hyperion", "2028-01-01", "1632", "2203")
        for checked in (NOW, "2029-01-01T00:00:00+00:00"):
            evidence = parse_epoch_project("META-US-LA-HYPERION", directory("Meta Hyperion", "0"), rows, page("Meta Hyperion", "Sep. 21, 2026"), checked, FETCHED, "v1")
            self.assertTrue(all(item["valueMw"] is None for item in evidence if item["scope"] == "current"))
            planned = next(item for item in evidence if item["scope"] == "planned" and item["capacityKind"] == "it_power")
            self.assertEqual(planned["valueMw"], 1632)
            self.assertEqual(planned["asOfDate"], "2026-09-21")
            self.assertEqual(planned["targetDate"], "2028-Q1")

    def test_partial_ai_campus_scope_preserved(self):
        evidence = parse_epoch_project("META-US-TN-GALLATIN", directory("Meta Gallatin", "87"), timeline("Meta Gallatin", "2026-08-24", "87", "114"), page("Meta Gallatin", "Oct. 5, 2026"), NOW, FETCHED, "v1")
        self.assertIn("不含原有园区", evidence[0]["coverageScope"])
        self.assertEqual(evidence[0]["asOfDate"], "2026-08-24")
        self.assertEqual(evidence[0]["publishedAt"], "2026-10-05")

    def test_project_identity_owner_and_country_are_verified(self):
        for change in ({"Name": "Google Temple"}, {"Owner": "Google"}, {"Country": "Japan"}):
            rows = directory(); rows[0].update(change)
            with self.assertRaises(ValueError):
                parse_epoch_project(TEMPLE, rows, timeline(), page(), NOW, FETCHED, "v1")

    def test_wrong_page_or_future_publication_is_rejected(self):
        for raw in (page("Google Temple"), page(updated="Dec. 1, 2026"), b"<title>Meta Temple</title>No date"):
            with self.assertRaises(ValueError):
                parse_epoch_project(TEMPLE, directory(), timeline(), raw, NOW, FETCHED, "v1")

    def test_current_vs_timeline_mismatch_and_duplicate_dates_rejected(self):
        for rows in (timeline(it="152"), timeline() + timeline()):
            with self.assertRaises(ValueError):
                parse_epoch_project(TEMPLE, directory(), rows, page(), NOW, FETCHED, "v1")

    def test_invalid_numbers_and_missing_it_do_not_become_zero(self):
        for value in ("", "NaN", "Infinity", "-1"):
            with self.assertRaises(ValueError):
                parse_epoch_project(TEMPLE, directory(), timeline(it=value), page(), NOW, FETCHED, "v1")

    def test_csv_header_changes_fail_closed(self):
        with self.assertRaises(ValueError):
            parse_csv(b"Name,Power\nMeta Temple,178", ["Name", "Current power (MW)"])


class EvidenceLifecycleTests(unittest.TestCase):
    def test_old_cache_recovers_only_initial_date_from_reviewed_official_source(self):
        import industry_projects
        with tempfile.TemporaryDirectory() as folder:
            directory_path = Path(folder)
            source = "https://meta.example/first"
            baseline = {"id": "el-paso", "isEstimated": False, "announcedAt": "2025-10-15", "status": "construction", "powerCapacityMw": 1000, "sourceUrls": [source]}
            current = {"id": "el-paso", "announcedAt": "2026-07-28", "status": "operational", "powerCapacityMw": None, "sourceUrls": [source]}
            for filename, project in (("public-reviewed.json", baseline), ("projects.json", current)):
                (directory_path / filename).write_text(json.dumps({"projects": [project]}), encoding="utf8")
            with patch.object(industry_projects, "DATA", directory_path):
                restored = industry_projects.load_previous_projects()[0]
            self.assertEqual(restored["announcedAt"], "2025-10-15")
            self.assertEqual(restored["status"], "operational")
            self.assertIsNone(restored["powerCapacityMw"])

    def test_new_capacity_disclosure_keeps_initial_project_announcement(self):
        from industry_projects import merge_project_history
        previous = {"id": "el-paso", "status": "construction", "announcedAt": "2025-10-15", "sourceUrls": ["https://meta.example/first"]}
        candidate = {"id": "el-paso", "status": "construction", "announcedAt": "2026-07-28", "powerCapacityMw": 1000, "capacityKind": "compute_capacity", "sourceUrls": ["https://meta.example/capacity"], "statusHistory": [{"date": "2026-07-28", "status": "construction", "capacityMw": 1000, "sourceUrl": "https://meta.example/capacity"}]}
        merged = merge_project_history(previous, candidate)
        self.assertEqual(merged["announcedAt"], "2025-10-15")
        self.assertEqual(merged["statusHistory"][0]["date"], "2026-07-28")

    def test_revisions_preserved_but_repeated_fetch_does_not_duplicate(self):
        project = {"id": TEMPLE}
        item = {**epoch_template(TEMPLE, EPOCH_SPECS[TEMPLE], "it_power", "current"), "valueMw": 152, "version": "v1", "status": "ready"}
        retain_evidence(project, item)
        retain_evidence(project, {**item, "fetchedAt": FETCHED})
        self.assertEqual(project["capacityEvidenceHistory"], [])
        retain_evidence(project, {**item, "valueMw": 178, "version": "v2"})
        self.assertEqual(len(project["capacityEvidenceHistory"]), 1)
        self.assertEqual(project["capacityEvidenceHistory"][0]["valueMw"], 152)

    def test_failure_keeps_value_and_original_success_time(self):
        project = {"id": TEMPLE}
        template = epoch_template(TEMPLE, EPOCH_SPECS[TEMPLE], "it_power", "current")
        retain_evidence(project, {**template, "valueMw": 178, "status": "ready", "fetchedAt": FETCHED})
        failed_evidence(project, template, NOW, "network unavailable")
        cached = project["capacityEvidence"][0]
        self.assertEqual(cached["status"], "cached")
        self.assertEqual(cached["valueMw"], 178)
        self.assertEqual(cached["lastSuccessfulAt"], FETCHED)
        self.assertEqual(cached["checkedAt"], NOW)

    def test_first_failure_does_not_create_estimated_value(self):
        project = {"id": TEMPLE}
        failed_evidence(project, epoch_template(TEMPLE, EPOCH_SPECS[TEMPLE], "it_power", "current"), NOW, "failure")
        self.assertEqual(project["capacityEvidence"][0]["status"], "fetch_failed")
        self.assertIsNone(project["capacityEvidence"][0]["valueMw"])

    def test_official_capacity_stays_official_with_actual_disclosure_date(self):
        project = {"id": "h", "owner": "Meta", "status": "construction", "powerCapacityMw": 5000, "capacityKind": "compute_capacity", "lastVerifiedAt": FETCHED, "statusHistory": [{"date": "2026-07-13", "status": "construction", "capacityMw": 5000, "sourceUrl": "https://about.fb.com/hyperion"}]}
        official_evidence(project, [{"url": "https://about.fb.com/hyperion", "status": "ready", "fetchedAt": FETCHED}], NOW)
        evidence = project["capacityEvidence"][0]
        self.assertEqual(evidence["sourceType"], "official")
        self.assertEqual(evidence["scope"], "planned")
        self.assertEqual(evidence["publishedAt"], "2026-07-13")
        self.assertEqual(project["powerCapacityMw"], 5000)

    def test_whole_feed_failure_retains_official_status_and_retry_forces_fetch(self):
        project = {"id": TEMPLE, "status": "operational", "powerCapacityMw": None, "sourceUrls": ["https://meta.example/temple"]}
        item = {**epoch_template(TEMPLE, EPOCH_SPECS[TEMPLE], "it_power", "current"), "valueMw": 178, "status": "cached", "fetchedAt": FETCHED}
        retain_evidence(project, item)
        calls = []
        def broken(url, force=False):
            calls.append((url, force)); raise RuntimeError("network failure")
        result, sources = enrich_project_capacities([project], [], NOW, fetcher=broken)
        self.assertEqual(result[0]["status"], "operational")
        self.assertIsNone(result[0]["powerCapacityMw"])
        self.assertEqual(result[0]["capacityEvidence"][0]["valueMw"], 178)
        self.assertEqual(sources[0]["status"], "fetch_failed")
        self.assertEqual(calls, [(EPOCH_DATA, True)])


if __name__ == "__main__":
    unittest.main()
