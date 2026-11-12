"""Source-separated project capacity evidence; estimates never replace official MW.

Epoch AI's CC-BY CSV supplies values; its project page supplies publication date.
Future rows remain projections relative to that publication, even after their
target date passes. Raw responses and version hashes use the shared durable cache.
"""
import csv
import hashlib
import io
import json
import math
import re
from datetime import date, datetime

from bs4 import BeautifulSoup
from industry_common import fetch

EPOCH_DATA = "https://epoch.ai/data/data_centers/data_centers.csv"
EPOCH_TIMELINE = "https://epoch.ai/data/data_centers/data_center_timelines.csv"
EPOCH_METHOD = "https://epoch.ai/data/data-centers-documentation"
EPOCH_SPECS = {
    "META-US-TX-TEMPLE": {"name": "Meta Temple", "slug": "meta-temple", "coverage": "Epoch 跟踪的 AI 数据中心楼栋", "note": "估算投运时间参考项目备案与建设资料。"},
    "META-US-ID-KUNA": {"name": "Meta Kuna", "slug": "meta-kuna", "coverage": "一期 1、2 号楼", "note": "基于楼栋、供电安排与公开建设资料估算。"},
    "META-US-TN-GALLATIN": {"name": "Meta Gallatin", "slug": "meta-gallatin", "coverage": "新增 AI 楼栋（不含原有园区）", "note": "只覆盖 Epoch 跟踪的新增 AI 楼栋，不是整个 Gallatin 园区容量。"},
    "META-US-LA-HYPERION": {"name": "Meta Hyperion", "slug": "meta-hyperion", "coverage": "Holly Ridge 一期", "note": "机构的一期估算，与官方公布的最终 5GW 计算容量分别展示。"},
}
MONTHS = {name: index for index, name in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def parse_csv(raw, required):
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
    if not set(required).issubset(reader.fieldnames or []):
        raise ValueError("Epoch CSV 字段发生变化，等待复核")
    rows = list(reader)
    if not rows:
        raise ValueError("Epoch CSV 没有数据行")
    return rows


def numeric(value):
    if value is None or str(value).strip() == "":
        return None
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError("容量必须是有限的非负数")
    return number


def publication_date(raw, spec, checked_at):
    soup = BeautifulSoup(raw, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    if spec["name"].lower() not in title.lower():
        raise ValueError("机构目录项目名称不匹配")
    text = soup.get_text(" ", strip=True)
    match = re.search(r"\bUpdated\s+([A-Z][a-z]{2})\.?\s+(\d{1,2}),\s+(\d{4})\b", text)
    if not match or match[1] not in MONTHS:
        raise ValueError("机构目录未提供可解析的更新日期")
    result = date(int(match[3]), MONTHS[match[1]], int(match[2])).isoformat()
    if result > checked_at[:10]:
        raise ValueError("机构目录更新日期晚于检查时间")
    return result


def signature(item):
    keys = ("id", "sourceType", "valueMw", "upperBoundMw", "valueQualifier", "capacityKind", "scope", "asOfDate", "publishedAt", "targetDate", "sourceUrl", "coverageScope", "version")
    return json.dumps({key: item.get(key) for key in keys}, sort_keys=True, ensure_ascii=False)


def retain_evidence(project, evidence):
    """Replace one source/basis/scope fact while keeping every prior revision."""
    current = list(project.get("capacityEvidence") or [])
    previous = next((item for item in current if item.get("id") == evidence["id"]), None)
    history = list(project.get("capacityEvidenceHistory") or [])
    if previous and signature(previous) != signature(evidence) and (finite(previous.get("valueMw")) or finite(previous.get("upperBoundMw"))):
        if not any(signature(item) == signature(previous) for item in history):
            history.append(previous)
    project["capacityEvidence"] = [item for item in current if item.get("id") != evidence["id"]] + [evidence]
    project["capacityEvidenceHistory"] = history
    return project


def failed_evidence(project, template, checked_at, error):
    previous = next((item for item in project.get("capacityEvidence", []) if item.get("id") == template["id"]), None)
    has_previous = previous and (finite(previous.get("valueMw")) or finite(previous.get("upperBoundMw")))
    evidence = {**(previous if has_previous else template), "status": "cached" if has_previous else "fetch_failed", "checkedAt": checked_at, "error": str(error)}
    if has_previous:
        evidence["lastSuccessfulAt"] = previous.get("lastSuccessfulAt") or previous.get("fetchedAt")
    return retain_evidence(project, evidence)


def epoch_template(project_id, spec, kind, scope):
    return {"id": f"EPOCH.{project_id}.{kind}.{scope}", "sourceType": "institutional_estimate", "sourceName": "Epoch AI", "sourceUrl": "https://epoch.ai/data/ai-data-centers/directory/" + spec["slug"], "datasetUrl": EPOCH_TIMELINE, "methodologyUrl": EPOCH_METHOD, "license": "CC-BY · Epoch AI", "capacityKind": kind, "scope": scope, "valueMw": None, "asOfDate": None, "coverageScope": spec["coverage"], "method": "卫星影像、设备配置与项目公开资料估算", "note": spec["note"]}


def parse_epoch_project(project_id, directory, timelines, page_raw, checked_at, fetched_at, version):
    spec = EPOCH_SPECS[project_id]
    published = publication_date(page_raw, spec, checked_at)
    matches = [row for row in directory if row.get("Name") == spec["name"]]
    if len(matches) != 1:
        raise ValueError("机构 CSV 未找到唯一对应项目")
    record = matches[0]
    if record.get("Country") != "United States" or not re.search(r"\bMeta\b", record.get("Owner", "")):
        raise ValueError("机构项目的业主或国家不匹配")
    entries = []
    dates = set()
    for row in timelines:
        if row.get("Data center") != spec["name"]:
            continue
        day = date.fromisoformat(row["Date"]).isoformat()
        if day in dates:
            raise ValueError("机构项目时间线存在重复日期")
        dates.add(day)
        entries.append({"date": day, "it_power": numeric(row.get("IT power (MW)")), "facility_power": numeric(row.get("Power (MW)"))})
    if not entries:
        raise ValueError("机构项目未提供容量时间线")
    current = max((row for row in entries if row["date"] <= published), key=lambda row: row["date"], default=None)
    # Main CSV must agree with the historical IT timeline, not facility electricity.
    advertised = numeric(record.get("Current power (MW)"))
    if current is None or advertised is None or current["it_power"] is None or not math.isclose(advertised, current["it_power"], abs_tol=0.01):
        raise ValueError("机构当前容量与时间线不一致，保留上次成功版本")
    future = max((row for row in entries if row["date"] > published and (row["it_power"] or 0) > 0), key=lambda row: row["date"], default=None)
    result = []
    for scope, row in (("current", current), ("planned", future)):
        for kind in ("it_power", "facility_power"):
            evidence = {**epoch_template(project_id, spec, kind, scope), "publishedAt": published, "checkedAt": checked_at, "fetchedAt": fetched_at, "lastSuccessfulAt": fetched_at, "version": version, "calculationUrl": record.get("Calculations sheet", "")}
            if row and finite(row[kind]) and row[kind] > 0:
                evidence.update(valueMw=row[kind], asOfDate=row["date"] if scope == "current" else published, status="ready")
                if scope == "planned":
                    # CSV encodes a quarter target on its first day; keep that precision.
                    target = row["date"]
                    evidence["targetDate"] = target[:4] + "-Q" + str((int(target[5:7]) - 1) // 3 + 1) if target[5:] in ("01-01", "04-01", "07-01", "10-01") else target
            else:
                evidence.update(status="not_published", asOfDate=published, note=spec["note"] + (" 当前尚无正值投运容量估算。" if scope == "current" else " 未提供独立的未来容量估算。"))
            result.append(evidence)
    return result


def official_evidence(project, sources, checked_at):
    value = project.get("powerCapacityMw")
    if not finite(value) or value < 0 or project.get("isEstimated"):
        return project
    candidates = [event for event in project.get("statusHistory", []) if event.get("status") == project.get("status") and event.get("capacityMw") == value and event.get("sourceUrl")]
    event = max(candidates, key=lambda item: item.get("date", ""), default=None)
    if not event or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", event.get("date", "")):
        return project
    source = next((item for item in sources if item.get("url") == event["sourceUrl"]), None)
    successful = source and source.get("status") in ("ready", "reviewed", "available")
    fetched_at = source.get("fetchedAt") if successful else project.get("lastVerifiedAt")
    scope = "current" if project.get("status") in ("operational", "partially_operational") else "planned"
    evidence = {"id": "OFFICIAL." + project["id"], "sourceType": "official", "sourceName": (source or {}).get("name") or ("Meta 官方公告" if project.get("owner", "").startswith("Meta") else "美国能源部 DOE"), "sourceUrl": event["sourceUrl"], "valueMw": value, "capacityKind": project.get("capacityKind") or event.get("capacityKind") or "unspecified_project_capacity", "scope": scope, "asOfDate": event["date"], "publishedAt": event["date"], "checkedAt": checked_at, "status": "ready" if successful else "cached", "fetchedAt": fetched_at, "lastSuccessfulAt": fetched_at, "note": event.get("note", "")}
    evidence["version"] = hashlib.sha256(signature(evidence).encode()).hexdigest()
    return retain_evidence(project, evidence)


def enrich_project_capacities(projects, official_sources, checked_at, fetcher=fetch):
    result = [official_evidence({**project}, official_sources, checked_at) for project in projects]
    sources = []
    configured = [project for project in result if project["id"] in EPOCH_SPECS]
    directory = timelines = None
    csv_error = None
    force = any(item.get("status") in ("cached", "fetch_failed") for project in configured for item in project.get("capacityEvidence", []) if item.get("sourceName") == "Epoch AI")
    try:
        directory_raw, directory_at, directory_hash = fetcher(EPOCH_DATA, force=force)
        timeline_raw, timeline_at, timeline_hash = fetcher(EPOCH_TIMELINE, force=force)
        directory = parse_csv(directory_raw, ["Name", "Current power (MW)", "Owner", "Country"])
        timelines = parse_csv(timeline_raw, ["Data center", "Date", "IT power (MW)", "Power (MW)"])
    except Exception as error:
        csv_error = error
    for project in result:
        spec = EPOCH_SPECS.get(project["id"])
        project["capacityAudit"] = {"checkedAt": checked_at, "status": "ready", "note": "已核对官方资料和 Epoch AI 项目目录。", "sourceUrls": list(project.get("sourceUrls", [])) + [EPOCH_DATA]}
        if not spec:
            project["capacityAudit"].update(status="not_published" if csv_error is None else "fetch_failed", note="当前 Epoch AI 目录未覆盖此项目；官方容量按原披露口径保留。" if csv_error is None else "机构目录本轮获取失败；官方容量及历史资料继续保留。")
            continue
        source_url = epoch_template(project["id"], spec, "it_power", "current")["sourceUrl"]
        try:
            if csv_error:
                raise csv_error
            page_raw, page_at, page_hash = fetcher(source_url, force=force)
            version = hashlib.sha256((directory_hash + timeline_hash + page_hash).encode()).hexdigest()
            fetched_at = min(directory_at, timeline_at, page_at)
            evidence = parse_epoch_project(project["id"], directory, timelines, page_raw, checked_at, fetched_at, version)
            for item in evidence:
                retain_evidence(project, item)
            sources.append({"id": "EPOCH." + project["id"], "name": "Epoch AI · " + spec["name"], "url": source_url, "status": "ready", "fetchedAt": fetched_at, "checkedAt": checked_at, "note": "CC-BY；机构估算按 IT/设施用电及当前/规划分开保存。"})
            project["capacityAudit"]["sourceUrls"].append(source_url)
            project["capacityAudit"]["note"] = "已核对官方披露与 Epoch AI 估算；容量口径和日期分别保留。"
        except Exception as error:
            for scope in ("current", "planned"):
                for kind in ("it_power", "facility_power"):
                    failed_evidence(project, epoch_template(project["id"], spec, kind, scope), checked_at, error)
            sources.append({"id": "EPOCH." + project["id"], "name": "Epoch AI · " + spec["name"], "url": source_url, "status": "fetch_failed", "checkedAt": checked_at, "error": str(error)})
            project["capacityAudit"].update(status="cached" if any(item.get("status") == "cached" for item in project.get("capacityEvidence", []) if item.get("sourceName") == "Epoch AI") else "fetch_failed", note="机构估算本轮核验失败，保留已核验的历史版本。")
    return result, sources
