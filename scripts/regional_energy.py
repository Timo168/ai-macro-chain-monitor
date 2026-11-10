"""Key-free official regional electricity prices and reported hourly demand.

EIA's website endpoint is the same public feed used by its Grid Monitor; only
TYPE_ID D / DATA_REPORTED is accepted, never demand forecasts or imputation.
Raw source versions and observation revisions survive routine refreshes.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sqlite3
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WHOLESALE = "https://www.eia.gov/electricity/wholesale/"
GRID = "https://www.eia.gov/electricity/gridmonitor/"
GRID_ABOUT = "https://www.eia.gov/electricity/930-content/about.html"
GRID_API = "https://www.eia.gov/electricity/930-api/region_data/series_data"
LICENSE = "https://www.eia.gov/about/copyrights_reuse.php"
REGIONS = {
    "ercot": {"id": "ercot", "name": "得克萨斯 · ERCOT", "timeZone": "America/Chicago", "ba": "ERCO",
              "priceId": "EIA_ERCOT_NORTH_PRICE", "hub": "ERCOT North 345KV Peak", "priceName": "ERCOT North 批发电价"},
    "pjm": {"id": "pjm", "name": "美国中东部 · PJM", "timeZone": "America/New_York", "ba": "PJM",
            "priceId": "EIA_PJM_WEST_PRICE", "hub": "PJM WH Real Time Peak", "priceName": "PJM West 批发电价"},
}


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp requires an explicit time zone")
    return parsed.astimezone(timezone.utc)


def atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temp, path)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def download(url: str) -> bytes:
    """In-process HTTP only; no curl, shells or desktop child windows."""
    request = Request(url, headers={"User-Agent": "AI-Macro-Chain-Monitor/1.0 (public EIA research dashboard)"})
    with urlopen(request, timeout=45) as response:
        return response.read()


def number(value: object) -> float | None:
    if value is None or value in ("", ".", "NA"):
        return None
    if isinstance(value, bool):
        raise ValueError("Boolean is not a numeric observation")
    result = float(str(value).strip().replace(",", ""))
    if not math.isfinite(result):
        raise ValueError("Non-finite source value")
    return result


def price_url(year: int, current_year: int) -> str:
    archive = "archive/" if year < current_year else ""
    suffix = "final" if year < current_year else ""
    return f"{WHOLESALE}xls/{archive}ice_electric-{year}{suffix}.xlsx"


def workbook_date(value: object) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(value).strip(), fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError("Invalid trade or delivery date")


def demand_url(ba: str, start: datetime, end: datetime) -> str:
    # The public dashboard uses MMDDYYYY HH:MM:SS, not ISO date arguments.
    params = {"respondent[0]": ba, "type[0]": "D", "start": start.strftime("%m%d%Y %H:%M:%S"),
              "end": end.strftime("%m%d%Y %H:%M:%S"), "frequency": "hourly", "timezone": "UTC"}
    return GRID_API + "?" + urlencode(params)


def parse_prices(raw: bytes, as_of: datetime) -> dict[str, list[dict]]:
    workbook = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    result = {region["priceId"]: [] for region in REGIONS.values()}
    try:
        rows = workbook.worksheets[0].iter_rows(values_only=True)
        header = next(rows)
        expected = {0: "Price hub", 1: "Trade date", 2: "Delivery start date", 6: "Wtd avg price $/MWh"}
        if any(str(header[i]).strip() != name for i, name in expected.items()):
            raise ValueError("EIA wholesale schema changed")
        mapping = {r["hub"]: r["priceId"] for r in REGIONS.values()}
        seen = {}
        for row in rows:
            if row[0] not in mapping:
                continue
            key = mapping[row[0]]
            date, delivery_start, delivery_end = (workbook_date(row[i]) for i in (1, 2, 3))
            if date > as_of.date().isoformat():
                raise ValueError("Future wholesale trade date")
            value, low, high = number(row[6]), number(row[5]), number(row[4])
            if value is not None and low is not None and high is not None and not low <= value <= high:
                raise ValueError("Weighted price falls outside the source high/low")
            if delivery_end < delivery_start:
                raise ValueError("Invalid delivery interval")
            point = {"date": date, "value": value, "deliveryStart": delivery_start,
                     "deliveryEnd": delivery_end, "low": low, "high": high,
                     "volumeMWh": number(row[8]), "isEstimated": False, "publishedAt": None}
            if (key, date) in seen:
                if seen[key, date] != point:
                    raise ValueError("Conflicting wholesale trade date")
                continue
            seen[key, date] = point
            result[key].append(point)
    finally:
        workbook.close()
    return {key: sorted(points, key=lambda p: p["date"]) for key, points in result.items()}


def parse_demand(raw: bytes, ba: str, time_zone: str, as_of: datetime) -> list[dict]:
    payload = json.loads(raw)
    if not isinstance(payload, list) or not payload or not isinstance(payload[0].get("data"), list):
        raise ValueError("EIA hourly response schema changed")
    series = [s for s in payload[0]["data"] if s.get("RESPONDENT_ID") == ba and s.get("TYPE_ID") == "D"]
    if not series:
        if not payload[0]["data"]:
            return []
        raise ValueError("Response does not contain requested reported demand")
    if len(series) != 1:
        raise ValueError("Duplicate demand series")
    source = series[0]
    if source.get("FREQUENCY") != "hourly" or source.get("TIME_ZONE") != "UTC":
        raise ValueError("Demand frequency/time zone changed")
    values = source.get("VALUES", {})
    dates, reported = values.get("DATES"), values.get("DATA_REPORTED")
    if not isinstance(dates, list) or not isinstance(reported, list) or len(dates) != len(reported):
        raise ValueError("Reported demand columns missing or misaligned")
    zone = ZoneInfo(time_zone)
    result = {}
    for text, raw_value in zip(dates, reported):
        when = datetime.strptime(text, "%m/%d/%Y %H:%M:%S").replace(tzinfo=timezone.utc)
        if when.minute or when.second or when > as_of:
            raise ValueError("Future or non-hourly actual-demand observation")
        value = number(raw_value)
        if value is not None and not 0 < value < 1_000_000:
            raise ValueError("Reported demand outside validation range")
        point = {"date": iso(when), "value": value, "localDateTime": when.astimezone(zone).isoformat(),
                 "timeZone": time_zone, "interval": "hour_ending", "isEstimated": False,
                 "sourceQuality": "reported" if value is not None else "missing", "publishedAt": None}
        key = point["date"]
        if key in result and result[key] != point:
            raise ValueError("Conflicting UTC demand timestamp")
        result[key] = point
    return [result[key] for key in sorted(result)]


def definition(region: dict, kind: str) -> dict:
    hourly = kind == "load"
    return {
        "id": f"EIA_{region['ba']}_DEMAND" if hourly else region["priceId"],
        "name": f"{region['ba']} 实际小时负荷" if hourly else region["priceName"],
        "kind": kind, "unit": "MW" if hourly else "美元/MWh", "frequency": "hourly" if hourly else "daily",
        "timeZone": region["timeZone"], "dateConvention": "UTC hour ending" if hourly else "trade date",
        "sourceName": "EIA-930 · 电网实际报告" if hourly else "EIA · ICE 批发交易指数",
        "sourceUrl": GRID if hourly else WHOLESALE, "methodologyUrl": GRID_ABOUT if hourly else WHOLESALE,
        "methodology": "电网报告的每小时实际平均负荷，按小时结束时刻记录；只取原始报告值。" if hourly else "高峰时段电力交易的成交量加权价格，横轴为交易日，保留交付起止日期。",
        "interpretation": "负荷越高，电网承担的用电需求越大；结合天气、同季节及同一小时比较。" if hourly else "价格上升表示该枢纽的短期批发采购成本上升，结合负荷变化观察供需压力。",
        "aiImpact": "观察区域供电压力与扩容需求，再结合数据中心并网和建设进度。" if hourly else "为数据中心运营和电力采购提供区域成本线索，实际费用还取决于电价合同。",
        "publicationFrequency": "通常在小时结束后约一小时公布，可修订" if hourly else "日度交易观测；EIA 每两周更新文件",
        "checkIntervalMinutes": 60 if hourly else 1440, "exportAllowed": hourly,
        "licenseUrl": LICENSE, "licenseNote": "EIA 政府公开数据，导出保留来源。" if hourly else "底层 ICE 第三方数据；保留来源链接，本站不提供批量导出。",
        "status": "not_configured", "lastFetchStatus": "not_configured", "checkedAt": None,
        "fetchedAt": None, "lastSuccessAt": None, "latestObservationAt": None, "version": None,
        "publishedAt": None, "observations": [], "error": None,
    }


def save_raw(root: Path, raw: bytes, url: str, checked: str, suffix: str) -> str:
    digest = hashlib.sha256(raw).hexdigest()
    path = root / "versions" / "regional-energy" / "raw"
    path.mkdir(parents=True, exist_ok=True)
    target = path / (digest + suffix)
    if not target.exists():
        target.write_bytes(raw)
    metadata = path / (digest + ".meta.json")
    first_seen = read_json(metadata).get("firstFetchedAt", checked)
    atomic(metadata, {"url": url, "sha256": digest, "firstFetchedAt": first_seen, "fetchedAt": checked})
    return digest


def merge_observations(root: Path, series_id: str, previous: list[dict], points: list[dict], url: str, fetched: str, digest: str) -> tuple[list[dict], int]:
    """Retain first seen values and every later revision in a durable ledger."""
    folder = root / "versions" / "regional-energy"
    folder.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(folder / "observations.sqlite")
    connection.execute("CREATE TABLE IF NOT EXISTS observations (series_id TEXT, observation_at TEXT, version TEXT, first_seen TEXT, source_hash TEXT, payload TEXT, PRIMARY KEY(series_id,observation_at,version))")
    merged = {p["date"]: p for p in previous}
    changed = 0
    try:
        for point in points:
            canonical = json.dumps(point, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            content_hash = hashlib.sha256(canonical.encode()).hexdigest()
            old = merged.get(point["date"])
            if old and (old.get("contentHash") or old.get("version")) == content_hash:
                continue
            changed += bool(old)
            version = hashlib.sha256((content_hash + old.get("version", "") + fetched).encode()).hexdigest() if old else content_hash
            saved = {**point, "sourceUrl": url, "fetchedAt": fetched, "sourceVersion": digest,
                     "version": version, "contentHash": content_hash, "isRevised": bool(old)}
            # The old display cache may have been restored without its ledger.
            if old and old.get("version"):
                connection.execute("INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?)", (series_id, old["date"], old["version"], old.get("fetchedAt", fetched), old.get("sourceVersion"), json.dumps(old, ensure_ascii=False)))
            connection.execute("INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?)", (series_id, point["date"], version, fetched, digest, json.dumps(saved, ensure_ascii=False)))
            merged[point["date"]] = saved
        connection.commit()
    finally:
        connection.close()
    return [merged[key] for key in sorted(merged)], changed


def failure(old: dict, error: str, checked: str, status: str = "fetch_failed") -> dict:
    return {**old, "status": "cached" if old.get("observations") else status,
            "lastFetchStatus": status, "checkedAt": checked, "error": error}


def success(old: dict, observations: list[dict], url: str, checked: str, digest: str, changed: int, as_of: datetime) -> dict:
    valid = [p for p in observations if p["value"] is not None]
    latest = valid[-1]["date"] if valid else None
    updated = {**old, "status": "available" if valid else "not_published", "lastFetchStatus": "available" if valid else "not_published",
               "checkedAt": checked, "fetchedAt": checked, "lastSuccessAt": checked, "dataUrl": url,
               "version": digest, "latestObservationAt": latest, "observations": observations, "error": None,
               "revisionCount": old.get("revisionCount", 0) + changed}
    age = (as_of - (stamp(latest) if old["frequency"] == "hourly" else datetime.fromisoformat(latest).replace(tzinfo=timezone.utc))).total_seconds() / 3600 if latest else None
    updated["freshness"] = "no_observations" if age is None else "delayed" if age > (6 if old["frequency"] == "hourly" else 24 * 21) else "current"
    return updated


def is_due(series: dict, as_of: datetime, force: bool) -> bool:
    if force or not series.get("checkedAt"):
        return True
    try:
        elapsed = (as_of - stamp(series["checkedAt"])).total_seconds() / 60
    except (TypeError, ValueError):
        return True
    cadence = 15 if series.get("lastFetchStatus") == "fetch_failed" else series["checkIntervalMinutes"]
    return elapsed < 0 or elapsed >= cadence


def collect(output: Path = DATA / "regional-energy.json", force: bool = False, as_of: datetime | None = None, fetch=download) -> dict:
    as_of = as_of or utc_now()
    checked = iso(as_of)
    root = output.parent
    prior = read_json(output)
    old_series = {s["id"]: s for r in prior.get("regions", []) for s in r.get("series", [])}
    regions = []
    for region in REGIONS.values():
        series = []
        for kind in ("wholesale_price", "load"):
            base = definition(region, kind)
            series.append({**base, **old_series.get(base["id"], {})})
        regions.append({"id": region["id"], "name": region["name"], "timeZone": region["timeZone"], "series": series})
    by_id = {s["id"]: s for r in regions for s in r["series"]}

    prices = [s for s in by_id.values() if s["kind"] == "wholesale_price"]
    if any(is_due(s, as_of, force) for s in prices):
        url = price_url(as_of.year, as_of.year)
        try:
            raw = fetch(url)
            parsed = parse_prices(raw, as_of)
            digest = save_raw(root, raw, url, checked, ".xlsx")
            for old in prices:
                current_points = parsed[old["id"]]
                points, changed = merge_observations(root, old["id"], old.get("observations", []), current_points, url, checked, digest)
                updated = success(old, points, url, checked, digest, changed, as_of)
                if not current_points:
                    updated.update(status="not_published", lastFetchStatus="not_published", error="EIA 当前年度文件未提供该枢纽的交易观测。", freshness="not_published")
                # Import two earlier years once. A historical failure never masks a current success.
                archives = dict(old.get("archives", {}))
                if current_points:
                    for year in range(as_of.year - 2, as_of.year):
                        if str(year) in archives:
                            continue
                        history_url = price_url(year, as_of.year)
                        try:
                            history_raw = fetch(history_url)
                            history_points = parse_prices(history_raw, as_of)[old["id"]]
                            history_hash = save_raw(root, history_raw, history_url, checked, ".xlsx")
                            merged, revisions = merge_observations(root, old["id"], updated["observations"], history_points, history_url, checked, history_hash)
                            updated["observations"] = merged
                            updated["revisionCount"] += revisions
                            archives[str(year)] = {"status": "available", "sourceUrl": history_url, "fetchedAt": checked, "version": history_hash}
                            updated.get("archiveErrors", {}).pop(str(year), None)
                        except Exception as exc:
                            updated.setdefault("archiveErrors", {})[str(year)] = str(exc)[:180]
                updated["archives"] = archives
                if old["id"] == "EIA_ERCOT_NORTH_PRICE":
                    updated["directSourceCheck"] = {"sourceUrl": "https://www.ercot.com/content/cdr/html/real_time_spp", "status": "fetch_failed", "httpStatus": 403, "checkedDate": "2026-11-10", "note": "接入核实时 ERCOT 直接接口拒绝请求；此为当次验证记录，与 EIA 文件未提供该枢纽分开记录。"}
                by_id[old["id"]] = updated
        except Exception as exc:
            for old in prices:
                by_id[old["id"]] = failure(old, str(exc)[:240], checked)

    for region in REGIONS.values():
        key = f"EIA_{region['ba']}_DEMAND"
        old = by_id[key]
        if not is_due(old, as_of, force):
            continue
        end = as_of.replace(minute=0, second=0, microsecond=0)
        # Every weekly refresh rechecks the entire 90-day window for late revisions.
        deep = not old.get("observations") or not old.get("lastHistoryCheckAt") or as_of - stamp(old["lastHistoryCheckAt"]) >= timedelta(days=7)
        start = end - timedelta(days=90 if deep else 7)
        url = demand_url(region["ba"], start, end)
        try:
            raw = fetch(url)
            parsed = parse_demand(raw, region["ba"], region["timeZone"], as_of)
            digest = save_raw(root, raw, url, checked, ".json")
            if not parsed:
                by_id[key] = failure(old, "本次查询时段尚无实际负荷观测。", checked, "not_published")
                continue
            points, changes = merge_observations(root, key, old.get("observations", []), parsed, url, checked, digest)
            updated = success(old, points, url, checked, digest, changes, as_of)
            updated["lastHistoryCheckAt"] = checked if deep else old.get("lastHistoryCheckAt")
            # Limit display size; the ledger retains all versions beyond this window.
            cutoff = iso(end - timedelta(days=366))
            updated["observations"] = [p for p in updated["observations"] if p["date"] >= cutoff]
            by_id[key] = updated
        except Exception as exc:
            by_id[key] = failure(old, str(exc)[:240], checked)

    for region in regions:
        region["series"] = [by_id[s["id"]] for s in region["series"]]
    result = {"schemaVersion": 1, "generatedAt": checked,
              "status": "available" if all(s["status"] == "available" for s in by_id.values()) else "partial",
              "regions": regions}
    result["version"] = hashlib.sha256(json.dumps(regions, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    atomic(output, result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--output", type=Path, default=DATA / "regional-energy.json")
    args = parser.parse_args()
    result = collect(args.output, args.force)
    print(json.dumps({"status": result["status"], "series": [{"id": s["id"], "status": s["status"], "latest": s.get("latestObservationAt"), "points": len(s["observations"])} for r in result["regions"] for s in r["series"]]}, ensure_ascii=False))
