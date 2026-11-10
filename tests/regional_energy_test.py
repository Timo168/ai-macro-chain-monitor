"""Official source schemas, provenance, UTC/DST, failures and hourly cadence."""
import copy
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone

from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import regional_energy as energy

SAMPLES = json.loads((ROOT / "tests/fixtures/regional-energy-samples.json").read_text(encoding="utf-8"))
NOW = datetime(2026, 11, 10, 12, tzinfo=timezone.utc)
HEADER = ["Price hub", "Trade date", "Delivery start date", "Delivery \nend date", "High price $/MWh", "Low price $/MWh", "Wtd avg price $/MWh", "Change", "Daily volume MWh", "Number of trades", "Number of counterparties"]


def workbook(rows=None, header=None):
    book = Workbook()
    book.active.append(header or HEADER)
    for row in rows if rows is not None else SAMPLES["price"]["rows"]:
        book.active.append(row)
    output = io.BytesIO()
    book.save(output)
    return output.getvalue()


def demand(region="ercot"):
    return copy.deepcopy(SAMPLES["load"][region]["payload"])


def flatten(payload):
    return {s["id"]: s for r in payload["regions"] for s in r["series"]}


class SourceSchemaTests(unittest.TestCase):
    def test_three_actual_historical_pjm_prices_match_source_rows(self):
        result = energy.parse_prices(workbook(), NOW)
        self.assertEqual([(p["date"], p["value"]) for p in result["EIA_PJM_WEST_PRICE"]], [("2024-06-03", 45.77), ("2025-03-19", 50.65), ("2026-10-27", 63.91)])
        self.assertEqual(result["EIA_PJM_WEST_PRICE"][1]["volumeMWh"], 11200)
        self.assertEqual(result["EIA_PJM_WEST_PRICE"][1]["deliveryStart"], "2025-03-20")
        self.assertEqual(result["EIA_ERCOT_NORTH_PRICE"], [])

    def test_three_actual_load_samples_per_region_match_source_and_dst(self):
        for region, definition in energy.REGIONS.items():
            with self.subTest(region=region):
                actual = energy.parse_demand(json.dumps(demand(region)).encode(), definition["ba"], definition["timeZone"], NOW)
                self.assertEqual([{k: p[k] for k in ("date", "value", "localDateTime")} for p in actual], SAMPLES["load"][region]["expected"])
                self.assertTrue(all(p["sourceQuality"] == "reported" and p["interval"] == "hour_ending" for p in actual))

    def test_never_substitutes_forecast_or_imputed_value_for_reported_missing(self):
        payload = demand()
        values = payload[0]["data"][0]["VALUES"]
        values["DATA_REPORTED"][0] = None
        values["DATA"][0] = 123456
        values["DATA_IMPUTED"][0] = 123456
        parsed = energy.parse_demand(json.dumps(payload).encode(), "ERCO", "America/Chicago", NOW)
        self.assertIsNone(parsed[0]["value"])
        self.assertEqual(parsed[0]["sourceQuality"], "missing")
        payload[0]["data"][0]["TYPE_ID"] = "DF"
        with self.assertRaisesRegex(ValueError, "requested reported demand"):
            energy.parse_demand(json.dumps(payload).encode(), "ERCO", "America/Chicago", NOW)

    def test_rejects_wrong_frequency_zone_and_misaligned_data(self):
        for field, value in [("FREQUENCY", "daily"), ("TIME_ZONE", "Eastern")]:
            payload = demand()
            payload[0]["data"][0][field] = value
            with self.assertRaises(ValueError):
                energy.parse_demand(json.dumps(payload).encode(), "ERCO", "America/Chicago", NOW)
        payload = demand()
        payload[0]["data"][0]["VALUES"]["DATA_REPORTED"].pop()
        with self.assertRaisesRegex(ValueError, "misaligned"):
            energy.parse_demand(json.dumps(payload).encode(), "ERCO", "America/Chicago", NOW)

    def test_future_and_nonfinite_actuals_are_rejected(self):
        for value in [True, float("nan"), -1, 0]:
            payload = demand()
            payload[0]["data"][0]["VALUES"]["DATA_REPORTED"][0] = value
            with self.assertRaises(ValueError):
                energy.parse_demand(json.dumps(payload).encode(), "ERCO", "America/Chicago", NOW)
        with self.assertRaisesRegex(ValueError, "Future"):
            energy.parse_demand(json.dumps(demand()).encode(), "ERCO", "America/Chicago", NOW - timedelta(days=1))

    def test_fall_dst_repeated_hour_is_two_distinct_utc_observations(self):
        payload = demand()
        payload[0]["data"][0]["VALUES"] = {"DATES": ["11/01/2026 06:00:00", "11/01/2026 07:00:00"], "DATA_REPORTED": [40000, 39000]}
        points = energy.parse_demand(json.dumps(payload).encode(), "ERCO", "America/Chicago", NOW)
        self.assertTrue(points[0]["localDateTime"].endswith("01:00:00-05:00"))
        self.assertTrue(points[1]["localDateTime"].endswith("01:00:00-06:00"))
        self.assertNotEqual(points[0]["date"], points[1]["date"])

    def test_duplicate_conflicts_are_rejected_and_negative_prices_are_allowed(self):
        row = copy.deepcopy(SAMPLES["price"]["rows"][-1])
        row[4:7] = [-10, -20, -15]
        self.assertEqual(energy.parse_prices(workbook([row]), NOW)["EIA_PJM_WEST_PRICE"][0]["value"], -15)
        revised = row.copy()
        revised[6] = -16
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            energy.parse_prices(workbook([row, revised]), NOW)

    def test_changed_wholesale_schema_and_invalid_price_range_fail(self):
        header = HEADER.copy()
        header[6] = "Other price"
        with self.assertRaisesRegex(ValueError, "schema"):
            energy.parse_prices(workbook(header=header), NOW)
        row = copy.deepcopy(SAMPLES["price"]["rows"][-1])
        row[6] = 999
        with self.assertRaisesRegex(ValueError, "high/low"):
            energy.parse_prices(workbook([row]), NOW)


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.output = self.root / "regional-energy.json"
        self.requests = []

    def fetch(self, url):
        self.requests.append(url)
        if ".xlsx" in url:
            return workbook()
        return json.dumps(demand("pjm" if "=PJM" in url else "ercot")).encode()

    def test_collection_uses_native_grains_and_only_no_key_public_sources(self):
        result = energy.collect(self.output, as_of=NOW, fetch=self.fetch)
        series = flatten(result)
        self.assertEqual(series["EIA_ERCOT_NORTH_PRICE"]["status"], "not_published")
        self.assertEqual(series["EIA_ERCOT_NORTH_PRICE"]["directSourceCheck"]["httpStatus"], 403)
        self.assertEqual(series["EIA_ERCO_DEMAND"]["unit"], "MW")
        self.assertEqual(series["EIA_ERCO_DEMAND"]["frequency"], "hourly")
        self.assertTrue(series["EIA_ERCO_DEMAND"]["exportAllowed"])
        self.assertFalse(series["EIA_PJM_WEST_PRICE"]["exportAllowed"])
        self.assertTrue(all("api_key" not in url for url in self.requests))
        self.assertTrue((self.root / "versions/regional-energy/observations.sqlite").exists())

    def test_cached_failure_preserves_values_and_success_timestamps(self):
        good = flatten(energy.collect(self.output, as_of=NOW, fetch=self.fetch))
        def fail(url):
            raise RuntimeError("HTTP 503")
        failed = flatten(energy.collect(self.output, force=True, as_of=NOW + timedelta(hours=1), fetch=fail))
        for key in ["EIA_ERCO_DEMAND", "EIA_PJM_DEMAND", "EIA_PJM_WEST_PRICE"]:
            self.assertEqual(failed[key]["status"], "cached")
            self.assertEqual(failed[key]["lastFetchStatus"], "fetch_failed")
            self.assertEqual(failed[key]["observations"], good[key]["observations"])
            self.assertEqual(failed[key]["fetchedAt"], good[key]["fetchedAt"])
            self.assertEqual(failed[key]["lastSuccessAt"], good[key]["lastSuccessAt"])
            self.assertNotEqual(failed[key]["checkedAt"], good[key]["checkedAt"])

    def test_first_failure_creates_no_success_or_fake_observations(self):
        def fail(url):
            raise RuntimeError("unavailable")
        failed = flatten(energy.collect(self.output, as_of=NOW, fetch=fail))
        for series in failed.values():
            self.assertEqual(series["status"], "fetch_failed")
            self.assertIsNone(series["fetchedAt"])
            self.assertEqual(series["observations"], [])

    def test_skip_before_due_and_hourly_does_not_refetch_wholesale_file(self):
        energy.collect(self.output, as_of=NOW, fetch=self.fetch)
        self.requests.clear()
        energy.collect(self.output, as_of=NOW + timedelta(minutes=15), fetch=self.fetch)
        self.assertEqual(self.requests, [])
        energy.collect(self.output, as_of=NOW + timedelta(hours=1), fetch=self.fetch)
        self.assertEqual(len(self.requests), 2)
        self.assertTrue(all("region_data" in url for url in self.requests))

    def test_revision_ledger_retains_reversion_and_unchanged_fetch_is_not_revision(self):
        point = {"date": "2026-11-10T10:00:00Z", "value": 100}
        observations, changes = energy.merge_observations(self.root, "TEST", [], [point], "https://example.org", "2026-11-10T11:00:00Z", "a")
        same, changes = energy.merge_observations(self.root, "TEST", observations, [point], "https://example.org", "2026-11-10T12:00:00Z", "b")
        self.assertEqual(changes, 0)
        self.assertEqual(same, observations)
        revised, changes = energy.merge_observations(self.root, "TEST", same, [{**point, "value": 101}], "https://example.org", "2026-11-10T13:00:00Z", "c")
        self.assertEqual(changes, 1)
        reverted, changes = energy.merge_observations(self.root, "TEST", revised, [point], "https://example.org", "2026-11-10T14:00:00Z", "d")
        self.assertEqual(changes, 1)
        self.assertNotEqual(reverted[0]["version"], observations[0]["version"])
        with closing(sqlite3.connect(self.root / "versions/regional-energy/observations.sqlite")) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 3)

    def test_wholesale_age_respects_biweekly_release_and_load_delay_is_visible(self):
        price = energy.definition(energy.REGIONS["pjm"], "wholesale_price")
        point = {"date": "2026-10-27", "value": 63.91}
        self.assertEqual(energy.success(price, [point], "u", energy.iso(NOW), "hash", 0, NOW)["freshness"], "current")
        self.assertEqual(energy.success(price, [point], "u", energy.iso(NOW), "hash", 0, NOW + timedelta(days=8))["freshness"], "delayed")
        load = energy.definition(energy.REGIONS["pjm"], "load")
        self.assertEqual(energy.success(load, [{"date": "2026-11-10T01:00:00Z", "value": 100}], "u", energy.iso(NOW), "hash", 0, NOW)["freshness"], "delayed")

    def test_seed_is_explicitly_unconfigured_and_never_contains_examples(self):
        seed = json.loads((ROOT / "data/regional-energy.seed.json").read_text(encoding="utf-8"))
        self.assertEqual(len(flatten(seed)), 4)
        for series in flatten(seed).values():
            self.assertEqual(series["status"], "not_configured")
            self.assertEqual(series["observations"], [])
            self.assertIsNone(series["fetchedAt"])


if __name__ == "__main__":
    unittest.main()
