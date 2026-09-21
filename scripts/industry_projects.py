"""Collect project-level AI data-center construction evidence from official DOE pages.

The adapter deliberately treats project announcements as a disclosed sample. It
does not infer total US capacity, does not count proposed capacity as construction,
and never turns the absence of an operational announcement into a zero.
"""
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup

from industry_common import DATA, atomic, definition, fetch, now, observation, persist


SOURCES = [
    {
        "id": "DOE.US.PORTSMOUTH",
        "name": "DOE Portsmouth AI data-center announcement",
        "url": "https://www.energy.gov/em/articles/partnership-ensures-affordable-energy-powers-ai-future-portsmouth-site",
        "publishedAt": "2026-03-24",
        "projectIds": ["DOE-US-OH-PORTSMOUTH-AI"],
    },
    {
        "id": "DOE.US.SAVANNAH",
        "name": "DOE/NNSA Savannah River AI data-center announcement",
        "url": "https://www.energy.gov/nnsa/articles/nnsa-selects-amentum-ai-data-center-and-energy-project-savannah-river-site",
        "publishedAt": "2026-07-20",
        "projectIds": ["DOE-US-SC-SAVANNAH-AI"],
    },
    {
        "id": "DOE.US.INL.RFA",
        "name": "DOE Idaho National Laboratory AI data-center RFA",
        "url": "https://www.energy.gov/ne/articles/energy-department-seeks-proposals-ai-data-centers-energy-projects-idaho-national",
        "publishedAt": "2025-09-08",
        "projectIds": ["DOE-US-ID-INL-AI-RFA"],
    },
]


def page_text(raw: bytes) -> str:
    return BeautifulSoup(raw, "html.parser").get_text(" ", strip=True)


def parse_source(spec, raw: bytes, fetched_at: str, digest: str):
    """Parse only facts that are explicitly present in the DOE page."""
    text = page_text(raw)
    lower = text.lower()
    if spec["id"] == "DOE.US.PORTSMOUTH":
        if "groundbreaking" not in lower or not re.search(r"10[- ]gigawatt[^.]{0,120}data center", lower):
            raise ValueError("DOE Portsmouth page no longer contains the expected groundbreaking and 10 GW facts")
        return [{
            "id": "DOE-US-OH-PORTSMOUTH-AI",
            "name": "Portsmouth Site AI data center",
            "owner": "SB Energy / SoftBank（DOE Portsmouth Site）",
            "country": "美国",
            "region": "Ohio",
            "stateCode": "OH",
            "city": "Piketon / Portsmouth Site",
            "status": "construction",
            "announcedAt": spec["publishedAt"],
            "powerCapacityMw": 10000,
            "sourceUrls": [spec["url"]],
            "statusHistory": [{"date": spec["publishedAt"], "status": "construction", "sourceUrl": spec["url"], "capacityMw": 10000, "note": "DOE公告确认奠基和规划容量。"}],
            "lastVerifiedAt": fetched_at,
            "isEstimated": False,
            "notes": "DOE公告称已举行奠基并规划10GW AI数据中心；该数值是数据中心规划容量，不是已投运容量，也不等同于配套发电容量。",
        }]
    if spec["id"] == "DOE.US.SAVANNAH":
        if not re.search(r"1[- ]gigawatt[^.]{0,120}data center", lower) or not re.search(r"selection[^.]{0,100}negotiat", lower):
            raise ValueError("DOE/NNSA Savannah page no longer contains the expected negotiation and 1 GW facts")
        return [{
            "id": "DOE-US-SC-SAVANNAH-AI",
            "name": "Savannah River Site AI data center",
            "owner": "Amentum / DOE-NNSA Savannah River Site",
            "country": "美国",
            "region": "South Carolina",
            "stateCode": "SC",
            "city": "Savannah River Site",
            "status": "planning",
            "announcedAt": spec["publishedAt"],
            "powerCapacityMw": 1000,
            "sourceUrls": [spec["url"]],
            "statusHistory": [{"date": spec["publishedAt"], "status": "planning", "sourceUrl": spec["url"], "capacityMw": 1000, "note": "DOE/NNSA公布进入谈判的选择结果。"}],
            "lastVerifiedAt": fetched_at,
            "isEstimated": False,
            "notes": "DOE/NNSA公布的是进入谈判的选择结果；1GW为数据中心规划容量，约2GW为现场发电设想，未计入在建容量，也不是最终租约或投运确认。",
        }]
    if spec["id"] == "DOE.US.INL.RFA":
        if not re.search(r"seeks proposals|request for applications|rfa", lower):
            raise ValueError("DOE Idaho page no longer contains the expected proposal-stage language")
        return [{
            "id": "DOE-US-ID-INL-AI-RFA",
            "name": "Idaho National Laboratory AI data-center RFA",
            "owner": "美国能源部 / Idaho National Laboratory",
            "country": "美国",
            "region": "Idaho",
            "stateCode": "ID",
            "city": "Idaho National Laboratory",
            "status": "announced",
            "announcedAt": spec["publishedAt"],
            "powerCapacityMw": None,
            "sourceUrls": [spec["url"]],
            "statusHistory": [{"date": spec["publishedAt"], "status": "announced", "sourceUrl": spec["url"], "note": "DOE开始征集建设和供能方案。"}],
            "lastVerifiedAt": fetched_at,
            "isEstimated": False,
            "notes": "DOE征集建设和供能方案；公告未披露项目容量，因此保留未发布，不填零，也不计入在建容量。",
        }]
    raise ValueError(f"unknown DOE source: {spec['id']}")


def load_previous_projects():
    for path in (DATA / "projects.json", DATA / "public-reviewed.json"):
        if path.exists():
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                projects = payload.get("projects", [])
                if projects:
                    return projects
            except (OSError, ValueError):
                pass
    return []


def merge_project_history(previous, candidate):
    """Retain official lifecycle facts; append only a verified status/capacity change."""
    history = list(previous.get("statusHistory", [])) if previous else []
    candidate_history = list(candidate.get("statusHistory", []))
    for event in candidate_history:
        key = (event.get("date"), event.get("status"), event.get("capacityMw"), event.get("sourceUrl"))
        if not any((old.get("date"), old.get("status"), old.get("capacityMw"), old.get("sourceUrl")) == key for old in history):
            history.append(event)
    if previous and (previous.get("status") != candidate.get("status") or previous.get("powerCapacityMw") != candidate.get("powerCapacityMw")):
        event = {
            "date": candidate.get("announcedAt") or candidate.get("lastVerifiedAt", "")[:10],
            "status": candidate["status"],
            "sourceUrl": candidate["sourceUrls"][0],
            "capacityMw": candidate.get("powerCapacityMw"),
            "note": "自动采集发现官方页面中的状态或披露容量变化；以该公告日期为准。",
        }
        key = (event.get("date"), event.get("status"), event.get("capacityMw"), event.get("sourceUrl"))
        if not any((old.get("date"), old.get("status"), old.get("capacityMw"), old.get("sourceUrl")) == key for old in history):
            history.append(event)
    candidate["statusHistory"] = sorted(history, key=lambda event: (event.get("date", ""), event.get("status", "")))
    return candidate


def capacity_signature(projects, statuses):
    facts = [
        {"id": project["id"], "status": project.get("status"), "capacityMw": project.get("powerCapacityMw"), "sources": project.get("sourceUrls", [])}
        for project in projects
        if project.get("status") in statuses and isinstance(project.get("powerCapacityMw"), (int, float))
    ]
    return hashlib.sha256(json.dumps(sorted(facts, key=lambda item: item["id"]), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def retain_snapshots(previous, candidate):
    """Keep a point only when the disclosed capacity composition changes."""
    if candidate is None:
        return previous
    def key(point):
        return (point.get("value"), (point.get("originalItems") or {}).get("projectIds", ""))
    compact = []
    for point in previous:
        if not compact or key(compact[-1]) != key(point):
            compact.append(point)
    if compact and key(compact[-1]) == key(candidate):
        return compact
    if compact and compact[-1].get("periodEnd") == candidate.get("periodEnd"):
        return [*compact[:-1], candidate]
    return [*compact, candidate]


def metric_definition(metric_id, name, family, method):
    result = definition(
        metric_id,
        name,
        family,
        "projects",
        family,
        "DOE/项目级公开样本",
        "U.S. DOE / 项目级官方公告",
        "https://www.energy.gov/powering-americas-ai-future-data-center-resource-hub",
        unit="MW",
        value_type="project_announcement",
        method=method,
        eligible=True,
        frequency="event",
        export=True,
    )
    result.update({
        "nameEn": "New operational capacity" if family == "operational_capacity" else "Capacity under construction",
        "sourceOwner": "U.S. Department of Energy / DOE项目公告",
        "accessMethod": "官方DOE网页；后台抓取、文本事实校验、项目ID去重",
        "normalUpdateDelayDays": 90,
        "isComparableAcrossEntities": False,
        "licenseNote": "仅提取公开事实与汇总值，保留每个项目的官方来源链接；不再分发网页正文。",
        "interpretation": "公开项目样本，不代表美国或全球全量；没有已发布容量时保留空值。",
    })
    return result


def build():
    checked_at = now()
    previous = load_previous_projects()
    previous_by_id = {p.get("id"): p for p in previous if p.get("id")}
    projects_by_id = dict(previous_by_id)
    sources = []
    successful = 0
    latest_fetch = None
    latest_published = None
    for spec in SOURCES:
        try:
            raw, fetched_at, digest = fetch(spec["url"])
            parsed = parse_source(spec, raw, fetched_at, digest)
            for project in parsed:
                projects_by_id[project["id"]] = merge_project_history(previous_by_id.get(project["id"]), project)
            successful += 1
            latest_fetch = max(latest_fetch or fetched_at, fetched_at)
            latest_published = max(latest_published or spec["publishedAt"], spec["publishedAt"])
            sources.append({"id": spec["id"], "name": spec["name"], "url": spec["url"], "status": "ready", "fetchedAt": fetched_at, "note": "官方页面事实已通过关键字段校验。"})
        except Exception as error:
            sources.append({"id": spec["id"], "name": spec["name"], "url": spec["url"], "status": "fetch_failed", "checkedAt": checked_at, "error": str(error), "note": "保留该来源的最近成功项目；若无历史版本则不显示容量。"})

    projects = list(projects_by_id.values())
    construction = [p for p in projects if p.get("status") == "construction" and isinstance(p.get("powerCapacityMw"), (int, float))]
    operational = [p for p in projects if p.get("status") in ("operational", "partially_operational") and isinstance(p.get("powerCapacityMw"), (int, float))]
    snapshot_date = datetime.now(timezone.utc).date().isoformat()
    source_url = "https://www.energy.gov/powering-americas-ai-future-data-center-resource-hub"
    construction_version = capacity_signature(projects, {"construction"})
    operational_version = capacity_signature(projects, {"operational", "partially_operational"})
    construction_value = sum(p["powerCapacityMw"] for p in construction)
    operational_value = sum(p["powerCapacityMw"] for p in operational)
    common_note = "仅汇总已核验且披露容量的公开项目样本，不代表全量市场；规划/审批/谈判项目不计入在建容量。"
    old_payload = json.loads((DATA / "projects.json").read_text(encoding="utf-8")) if (DATA / "projects.json").exists() else {}
    old_series = old_payload.get("series", {})
    old_construction = old_series.get("PROJECT.construction_capacity", {}).get("observations", [])
    old_operational = old_series.get("PROJECT.operational_capacity", {}).get("observations", [])
    construction_obs = observation(
        "PROJECT.construction_capacity", snapshot_date, construction_value, source_url, checked_at, construction_version,
        fiscal="latest public snapshot", formula="sum(project.powerCapacityMw where status=construction and disclosed capacity)",
        items={"projectCount": len(construction), "projectIds": ",".join(p["id"] for p in construction), "sampleBoundary": "known official project sample"},
        published=latest_published,
    ) if successful else None
    operational_obs = observation(
        "PROJECT.operational_capacity", snapshot_date, operational_value, source_url, checked_at, operational_version,
        fiscal="latest public snapshot", formula="sum(project.powerCapacityMw where status in (operational, partially_operational) and disclosed capacity)",
        items={"projectCount": len(operational), "projectIds": ",".join(p["id"] for p in operational), "sampleBoundary": "known official project sample"},
        published=latest_published,
    ) if successful and operational else None
    construction_history = retain_snapshots(old_construction, construction_obs)
    operational_history = retain_snapshots(old_operational, operational_obs)
    if successful:
        operational_series = {
            "observations": operational_history,
            "status": "ready" if operational_obs else "no_observation",
            "fetchedAt": latest_fetch,
            "checkedAt": checked_at,
            "note": "已核验项目中暂无官方宣布已投运容量；不显示零。" if not operational_obs else common_note,
        }
        construction_series = {"observations": construction_history, "status": "ready", "fetchedAt": latest_fetch, "checkedAt": checked_at, "note": common_note}
    else:
        operational_series = {**old_series.get("PROJECT.operational_capacity", {}), "status": "cached" if old_series.get("PROJECT.operational_capacity", {}).get("observations") else "fetch_failed", "checkedAt": checked_at, "error": "所有DOE来源本次获取失败；保留最近成功版本。"}
        construction_series = {**old_series.get("PROJECT.construction_capacity", {}), "status": "cached" if old_series.get("PROJECT.construction_capacity", {}).get("observations") else "fetch_failed", "checkedAt": checked_at, "error": "所有DOE来源本次获取失败；保留最近成功版本。"}
    result = {
        "schemaVersion": "1",
        "generatedAt": checked_at,
        "definitions": [
            metric_definition("PROJECT.operational_capacity", "公开项目新增投运容量", "operational_capacity", "只汇总已公开且status为operational或partially_operational的项目容量；没有已投运项目时保留空值，不填零。"),
            metric_definition("PROJECT.construction_capacity", "公开项目在建容量", "construction_capacity", "只汇总status为construction且披露容量的项目；规划、审批、谈判项目不计入在建容量。"),
        ],
        "series": {"PROJECT.operational_capacity": operational_series, "PROJECT.construction_capacity": construction_series},
        "projects": projects,
        "events": [],
        "sources": sources,
    }
    persist(result, DATA / "projects.json")
    return result


if __name__ == "__main__":
    result = build()
    print(json.dumps({"projects": len(result["projects"]), "sources": result["sources"], "construction": result["series"]["PROJECT.construction_capacity"]["status"], "operational": result["series"]["PROJECT.operational_capacity"]["status"]}, ensure_ascii=False))
