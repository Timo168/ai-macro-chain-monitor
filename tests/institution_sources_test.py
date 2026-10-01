"""Boundary tests for public institutional data; no live requests or data writes."""
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import industry_institutions as adapter


def cso_fixture(*, sparse=False):
    payload = {
        "id": ["STATISTIC", "TLIST(Q1)", "C03907V04659"], "size": [1, 3, 3],
        "updated": "2026-07-07T11:00:00.000Z",
        "dimension": {
            "STATISTIC": {"category": {"index": ["MEC02"], "unit": {"MEC02": {"label": "GWh"}}}},
            "TLIST(Q1)": {"category": {"index": ["2015Q1", "2024Q4", "2025Q4"]}},
            "C03907V04659": {"category": {"index": ["-", "10", "20"],
                                              "label": {"-": "All metered electricity consumption", "10": "Data centres", "20": "Customers other than data centres"}}},
        },
        "value": [6565, 291, 6274, 8108, 1830, 6278, 8420, 1991, 6429],
    }
    if sparse:
        payload["value"] = {str(i): value for i, value in enumerate(payload["value"]) if i != 4}
    return payload


IEA = b'<h1>Key Questions on Energy and AI</h1><p>Licence CC BY 4.0</p><p>Our updated projections see electricity consumption from data centres roughly doubling from 485 TWh in 2025 to 950 TWh in 2030.</p>'


class InstitutionalSourcesTests(unittest.TestCase):
    def test_three_official_quarters_units_and_publication_are_preserved(self):
        parsed = adapter.parse_cso(json.dumps(cso_fixture()).encode())
        self.assertEqual([(row["periodEnd"], row["value"]) for row in parsed["observations"]],
                         [("2015-03-31", 291), ("2024-12-31", 1830), ("2025-12-31", 1991)])
        self.assertEqual(parsed["publishedAt"], "2026-07-07T11:00:00+00:00")
        self.assertEqual(parsed["sourceNextExpectedAt"], "2027-07-07T11:00:00+00:00")
        self.assertEqual(parsed["observations"][0]["periodStart"], "2015-01-01")

    def test_sparse_missing_is_null_not_zero(self):
        parsed = adapter.parse_cso(json.dumps(cso_fixture(sparse=True)).encode())
        self.assertIsNone(parsed["observations"][1]["value"])
        self.assertEqual(parsed["observations"][2]["value"], 1991)

    def test_dimension_order_and_dictionary_indices_do_not_change_results(self):
        payload = cso_fixture()
        payload["id"] = ["C03907V04659", "STATISTIC", "TLIST(Q1)"]
        payload["size"] = [3, 1, 3]
        payload["value"] = [6565, 8108, 8420, 291, 1830, 1991, 6274, 6278, 6429]
        payload["dimension"]["C03907V04659"]["category"]["index"] = {"20": 2, "10": 1, "-": 0}
        self.assertEqual([row["value"] for row in adapter.parse_cso(json.dumps(payload).encode())["observations"]], [291, 1830, 1991])

    def test_changed_unit_label_invalid_value_and_future_quarter_are_rejected(self):
        payload = cso_fixture()
        payload["dimension"]["STATISTIC"]["category"]["unit"]["MEC02"]["label"] = "MWh"
        with self.assertRaisesRegex(ValueError, "单位"):
            adapter.parse_cso(json.dumps(payload).encode())
        payload = cso_fixture()
        payload["value"][1] = False
        with self.assertRaisesRegex(ValueError, "数值"):
            adapter.parse_cso(json.dumps(payload).encode())
        payload = cso_fixture()
        payload["dimension"]["TLIST(Q1)"]["category"]["index"][2] = "2099Q4"
        with self.assertRaisesRegex(ValueError, "未来季度"):
            adapter.parse_cso(json.dumps(payload).encode())

    def test_unknown_cso_publication_time_is_failure_not_new_observation(self):
        payload = cso_fixture()
        payload["updated"] = None
        with self.assertRaisesRegex(ValueError, "发布时间"):
            adapter.parse_cso(json.dumps(payload).encode())

    def test_cso_is_annual_release_regional_proxy_with_explicit_open_licence(self):
        definition = adapter.cso_definition()
        self.assertEqual(definition["frequency"], "quarterly")
        self.assertEqual(definition["sourceReleaseFrequency"], "annual")
        self.assertEqual(definition["freshnessBasis"], "source_publication")
        self.assertEqual(definition["directness"], "regional_load_proxy")
        self.assertEqual(definition["scoringTier"], "leading_only")
        self.assertFalse(definition["recommendationEligible"])
        self.assertTrue(definition["exportAllowed"])
        self.assertIn("CC BY 4.0", definition["licenseNote"])

    def test_iea_only_parses_explicit_estimate_and_forecast(self):
        facts = adapter.parse_iea_scenario(IEA)
        self.assertEqual([(item["period"], item["value"], item["nature"]) for item in facts],
                         [("2025", 485, "estimate"), ("2030", 950, "forecast")])
        with self.assertRaisesRegex(ValueError, "许可"):
            adapter.parse_iea_scenario(IEA.replace(b'CC BY 4.0', b'All rights reserved'))
        with self.assertRaisesRegex(ValueError, "唯一"):
            adapter.parse_iea_scenario(IEA.replace(b'485 TWh', b'an undisclosed amount'))
        with self.assertRaisesRegex(ValueError, "年份"):
            adapter.parse_iea_scenario(IEA.replace(b'in 2025', b'in 2026'))

    def test_commercial_catalogue_has_no_numbers_and_blocks_model_and_export(self):
        restricted = [item for item in adapter.source_catalog() if item["status"] == "authorization_required"]
        self.assertEqual(len(restricted), 6)
        for item in restricted:
            self.assertFalse(item["modelUseAllowed"])
            self.assertFalse(item["exportAllowed"])
            self.assertNotIn("facts", item)
            self.assertTrue(item["licenseUrl"].startswith("https://"))

    def test_build_retains_successful_data_and_report_after_source_failure(self):
        stamp = "2026-10-01T00:00:00+00:00"
        def successful_fetch(url, force=False):
            return (json.dumps(cso_fixture()).encode() if url == adapter.CSO_API else IEA), stamp, "source-version"
        with tempfile.TemporaryDirectory(prefix="institution-boundary-") as temp:
            folder = pathlib.Path(temp)
            def persist_in_fixture(payload, path):
                path.write_text(json.dumps(payload), encoding="utf-8")
            with patch.object(adapter, "DATA", folder), patch.object(adapter, "persist", side_effect=persist_in_fixture):
                with patch.object(adapter, "fetch", side_effect=successful_fetch):
                    first = adapter.build(force=True)
                with patch.object(adapter, "fetch", side_effect=RuntimeError("offline")):
                    second = adapter.build(force=True)
        self.assertEqual(first["series"][adapter.CSO_ID]["status"], "ready")
        self.assertEqual(second["series"][adapter.CSO_ID]["status"], "cached")
        self.assertEqual(second["series"][adapter.CSO_ID]["observations"], first["series"][adapter.CSO_ID]["observations"])
        self.assertEqual(second["series"][adapter.CSO_ID]["lastSuccessfulAt"], stamp)
        self.assertEqual(second["researchReports"][0]["status"], "cached")
        self.assertEqual(second["researchReports"][0]["facts"], first["researchReports"][0]["facts"])
        self.assertFalse(any(ident.startswith("IEA") for ident in first["series"]))

    def test_first_failure_does_not_fabricate_iea_numbers_or_cso_observations(self):
        with tempfile.TemporaryDirectory(prefix="institution-first-failure-") as temp:
            with patch.object(adapter, "DATA", pathlib.Path(temp)), patch.object(adapter, "persist"), patch.object(adapter, "fetch", side_effect=RuntimeError("offline")):
                result = adapter.build()
        self.assertEqual(result["series"][adapter.CSO_ID]["status"], "fetch_failed")
        self.assertEqual(result["series"][adapter.CSO_ID]["observations"], [])
        self.assertEqual(result["researchReports"][0]["status"], "fetch_failed")
        self.assertEqual(result["researchReports"][0]["facts"], [])

    def test_all_null_success_is_pending_not_ready_or_zero(self):
        payload = cso_fixture()
        payload["value"] = [None] * 9
        def fetch_nulls(url, force=False):
            return (json.dumps(payload).encode() if url == adapter.CSO_API else IEA), "2026-10-01T00:00:00+00:00", "null-version"
        with tempfile.TemporaryDirectory(prefix="institution-pending-") as temp:
            with patch.object(adapter, "DATA", pathlib.Path(temp)), patch.object(adapter, "persist"), patch.object(adapter, "fetch", side_effect=fetch_nulls):
                result = adapter.build()
        self.assertEqual(result["series"][adapter.CSO_ID]["status"], "pending")
        self.assertTrue(all(point["value"] is None for point in result["series"][adapter.CSO_ID]["observations"]))

    def test_pending_source_does_not_erase_last_successful_history(self):
        payload = cso_fixture()
        payload["value"] = [None] * 9
        def fetch_nulls(url, force=False):
            return (json.dumps(payload).encode() if url == adapter.CSO_API else IEA), "2026-10-01T00:00:00+00:00", "null-version"
        prior = {"observations": [{"periodEnd": "2025-12-31", "value": 1991}], "status": "ready", "lastSuccessfulAt": "2026-07-08"}
        with tempfile.TemporaryDirectory(prefix="institution-pending-cache-") as temp:
            folder = pathlib.Path(temp)
            (folder / "institutions.json").write_text(json.dumps({"series": {adapter.CSO_ID: prior}}), encoding="utf-8")
            with patch.object(adapter, "DATA", folder), patch.object(adapter, "persist"), patch.object(adapter, "fetch", side_effect=fetch_nulls):
                result = adapter.build()
        series = result["series"][adapter.CSO_ID]
        self.assertEqual(series["status"], "cached")
        self.assertEqual(series["sourceStatus"], "pending")
        self.assertEqual(series["observations"], prior["observations"])
        self.assertEqual(series["lastSuccessfulAt"], prior["lastSuccessfulAt"])
        self.assertEqual(result["sourceCatalog"][0]["status"], "pending")


if __name__ == "__main__":
    unittest.main()
