"""Collect project-level AI data-center evidence from official DOE and operator pages.

The adapter deliberately treats project announcements as a disclosed sample. It
does not infer total US capacity, does not count proposed capacity as construction,
and never turns the absence of a disclosed operational MW figure into a zero.
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
        # This source publishes a construction-stage capacity, but its wording
        # differs from Meta's disclosed compute capacity.  Keep that boundary
        # explicit and only aggregate when every live project uses one kind.
        "capacityRole": "construction",
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
    {
        "id": "META.US.HYPERION.EXPANSION",
        "name": "Meta Hyperion official capacity-expansion announcement",
        "url": "https://about.fb.com/news/2026/07/teachers-local-businesses-win-as-meta-expands-louisiana-data-center/",
        "publishedAt": "2026-07-13",
        "projectIds": ["META-US-LA-HYPERION"],
        "capacityRole": "construction",
        "project": {
            "id": "META-US-LA-HYPERION",
            "name": "Hyperion / Richland Parish",
            "owner": "Meta",
            "country": "美国",
            "region": "Louisiana",
            "stateCode": "LA",
            "city": "Richland Parish",
            "status": "construction",
            "powerCapacityMw": 5000,
            "capacityKind": "compute_capacity",
            "notes": "Meta官方公告确认该在建项目扩展至5GW compute capacity；这是项目披露的计算容量规模，不等同于并网容量、现场发电容量或已投运容量。",
        },
        "requiredPatterns": [r"richland parish", r"\b5\s*gw\s+of\s+compute\s+capacity\b", r"breaking ground"],
        "eventNote": "Meta官方公告确认项目仍在建设，并披露扩展后的5GW compute capacity。",
    },
    {
        "id": "META.US.GALLATIN.OPERATIONAL",
        "name": "Meta Gallatin official operational announcement",
        "url": "https://datacenters.atmeta.com/2024/11/gallatin-we-are-online/",
        "publishedAt": "2024-11-14",
        "projectIds": ["META-US-TN-GALLATIN"],
        "milestoneGroup": "operational",
        "project": {
            "id": "META-US-TN-GALLATIN",
            "name": "Gallatin 数据中心",
            "owner": "Meta",
            "country": "美国",
            "region": "Tennessee",
            "stateCode": "TN",
            "city": "Gallatin",
            "status": "operational",
            "notes": "Meta官方公告确认项目已开始承载流量；公告未披露可汇总的数据中心MW，不填容量。",
        },
        "requiredPatterns": [r"gallatin data center", r"now serving traffic"],
        "eventNote": "Meta官方公告确认项目已开始承载流量；未披露数据中心MW。",
    },
    {
        "id": "META.US.MESA.OPERATIONAL",
        "name": "Meta Mesa official operational announcement",
        "url": "https://datacenters.atmeta.com/2025/01/mesa-we-are-online/",
        "publishedAt": "2025-01-30",
        "projectIds": ["META-US-AZ-MESA"],
        "milestoneGroup": "operational",
        "project": {
            "id": "META-US-AZ-MESA",
            "name": "Mesa 数据中心",
            "owner": "Meta",
            "country": "美国",
            "region": "Arizona",
            "stateCode": "AZ",
            "city": "Mesa",
            "status": "operational",
            "notes": "Meta官方公告确认项目已开始承载流量；公告未披露可汇总的数据中心MW，不填容量。",
        },
        "requiredPatterns": [r"mesa data center", r"now serving traffic"],
        "eventNote": "Meta官方公告确认项目已开始承载流量；未披露数据中心MW。",
    },
    {
        "id": "META.US.KANSAS_CITY.OPERATIONAL",
        "name": "Meta Kansas City official operational announcement",
        "url": "https://about.fb.com/news/2025/08/metas-kansas-city-data-center/",
        "publishedAt": "2025-08-20",
        "projectIds": ["META-US-MO-KANSAS-CITY"],
        "milestoneGroup": "operational",
        "project": {
            "id": "META-US-MO-KANSAS-CITY",
            "name": "Kansas City 数据中心",
            "owner": "Meta",
            "country": "美国",
            "region": "Missouri",
            "stateCode": "MO",
            "city": "Kansas City",
            "status": "operational",
            "notes": "Meta官方公告确认项目已投运并承载流量；公告未披露可汇总的数据中心MW，不填容量。",
        },
        "requiredPatterns": [r"kansas city data center", r"operational and serving traffic"],
        "eventNote": "Meta官方公告确认项目已投运并承载流量；未披露数据中心MW。",
    },
    {
        "id": "META.US.TEMPLE.OPERATIONAL",
        "name": "Meta Temple official operational announcement",
        "url": "https://datacenters.atmeta.com/2026/07/temple-we-are-online/",
        "publishedAt": "2026-07-22",
        "projectIds": ["META-US-TX-TEMPLE"],
        "milestoneGroup": "operational",
        "project": {
            "id": "META-US-TX-TEMPLE",
            "name": "Temple 数据中心",
            "owner": "Meta",
            "country": "美国",
            "region": "Texas",
            "stateCode": "TX",
            "city": "Temple",
            "status": "operational",
            "notes": "Meta官方公告确认项目已开始承载流量，且为首个投运的AI优化数据中心；公告未披露可汇总的数据中心MW，不填容量。",
        },
        "requiredPatterns": [r"temple data center", r"serving traffic", r"ai workloads"],
        "eventNote": "Meta官方公告确认项目已开始承载流量；未披露数据中心MW。",
    },
    {
        "id": "META.US.KUNA.OPERATIONAL",
        "name": "Meta Kuna official operational announcement",
        "url": "https://datacenters.atmeta.com/2026/09/kuna-we-are-online/",
        "publishedAt": "2026-09-03",
        "projectIds": ["META-US-ID-KUNA"],
        "milestoneGroup": "operational",
        "project": {
            "id": "META-US-ID-KUNA",
            "name": "Kuna 数据中心",
            "owner": "Meta",
            "country": "美国",
            "region": "Idaho",
            "stateCode": "ID",
            "city": "Kuna",
            "status": "operational",
            "notes": "Meta官方公告确认项目已上线并投运；公告未披露可汇总的数据中心MW，不填容量。",
        },
        "requiredPatterns": [r"kuna data center", r"online and operational"],
        "eventNote": "Meta官方公告确认项目已上线并投运；未披露数据中心MW。",
    },
]

# These are the first, already-verified facts from the same official pages in
# SOURCES.  Keeping them separately lets a transient page-fetch failure retain
# the project lifecycle that was known before the failure.  The source status
# still reports ``fetch_failed``; this is historical evidence, not a newly
# inferred observation.
PROJECT_BASELINES = {
    "DOE-US-OH-PORTSMOUTH-AI": {
        "stateCode": "OH",
        "statusHistory": [{"date": "2026-03-24", "status": "construction", "sourceUrl": SOURCES[0]["url"], "capacityMw": 10000, "capacityKind": "data_center_planned_capacity", "note": "DOE公告确认奠基和规划容量。"}],
    },
    "DOE-US-SC-SAVANNAH-AI": {
        "stateCode": "SC",
        "statusHistory": [{"date": "2026-07-20", "status": "planning", "sourceUrl": SOURCES[1]["url"], "capacityMw": 1000, "capacityKind": "data_center_planned_capacity", "note": "DOE/NNSA公布进入谈判的选择结果。"}],
    },
    "DOE-US-ID-INL-AI-RFA": {
        "stateCode": "ID",
        "statusHistory": [{"date": "2025-09-08", "status": "announced", "sourceUrl": SOURCES[2]["url"], "note": "DOE开始征集建设和供能方案。"}],
    },
    "META-US-LA-HYPERION": {
        "stateCode": "LA",
        "statusHistory": [{"date": "2026-07-13", "status": "construction", "sourceUrl": SOURCES[3]["url"], "capacityMw": 5000, "capacityKind": "compute_capacity", "note": "Meta官方公告确认项目仍在建设，并披露扩展后的5GW compute capacity。"}],
    },
    "META-US-TN-GALLATIN": {
        "stateCode": "TN",
        "statusHistory": [{"date": "2024-11-14", "status": "operational", "sourceUrl": SOURCES[4]["url"], "note": "Meta官方公告确认项目已开始承载流量；未披露数据中心MW。"}],
    },
    "META-US-AZ-MESA": {
        "stateCode": "AZ",
        "statusHistory": [{"date": "2025-01-30", "status": "operational", "sourceUrl": SOURCES[5]["url"], "note": "Meta官方公告确认项目已开始承载流量；未披露数据中心MW。"}],
    },
    "META-US-MO-KANSAS-CITY": {
        "stateCode": "MO",
        "statusHistory": [{"date": "2025-08-20", "status": "operational", "sourceUrl": SOURCES[6]["url"], "note": "Meta官方公告确认项目已投运并承载流量；未披露数据中心MW。"}],
    },
    "META-US-TX-TEMPLE": {
        "stateCode": "TX",
        "statusHistory": [{"date": "2026-07-22", "status": "operational", "sourceUrl": SOURCES[7]["url"], "note": "Meta官方公告确认项目已开始承载流量；未披露数据中心MW。"}],
    },
    "META-US-ID-KUNA": {
        "stateCode": "ID",
        "statusHistory": [{"date": "2026-09-03", "status": "operational", "sourceUrl": SOURCES[8]["url"], "note": "Meta官方公告确认项目已上线并投运；未披露数据中心MW。"}],
    },
}


def page_text(raw: bytes) -> str:
    return BeautifulSoup(raw, "html.parser").get_text(" ", strip=True)


def parse_source(spec, raw: bytes, fetched_at: str, digest: str):
    """Parse only facts that are explicitly present in a named official page."""
    text = page_text(raw)
    lower = text.lower()
    if spec.get("project"):
        missing = [pattern for pattern in spec.get("requiredPatterns", []) if not re.search(pattern, lower)]
        if missing:
            raise ValueError(f"{spec['id']} page no longer contains required official fact anchors: {', '.join(missing)}")
        project = {
            **spec["project"],
            "announcedAt": spec["publishedAt"],
            "sourceUrls": [spec["url"]],
            "statusHistory": [{
                "date": spec["publishedAt"],
                "status": spec["project"]["status"],
                "sourceUrl": spec["url"],
                **({"capacityMw": spec["project"]["powerCapacityMw"]} if isinstance(spec["project"].get("powerCapacityMw"), (int, float)) else {}),
                **({"capacityKind": spec["project"]["capacityKind"]} if spec["project"].get("capacityKind") else {}),
                "note": spec["eventNote"],
            }],
            "lastVerifiedAt": fetched_at,
            "isEstimated": False,
        }
        project.setdefault("powerCapacityMw", None)
        return [project]
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
            "capacityKind": "data_center_planned_capacity",
            "sourceUrls": [spec["url"]],
            "statusHistory": [{"date": spec["publishedAt"], "status": "construction", "sourceUrl": spec["url"], "capacityMw": 10000, "capacityKind": "data_center_planned_capacity", "note": "DOE公告确认奠基和规划容量。"}],
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
            "capacityKind": "data_center_planned_capacity",
            "sourceUrls": [spec["url"]],
            "statusHistory": [{"date": spec["publishedAt"], "status": "planning", "sourceUrl": spec["url"], "capacityMw": 1000, "capacityKind": "data_center_planned_capacity", "note": "DOE/NNSA公布进入谈判的选择结果。"}],
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
    """Retain official lifecycle facts and prior provenance across source updates.

    A later official page that omits MW is not evidence that a previously
    disclosed MW figure disappeared while the project remains in the same
    lifecycle state. A transition to operational without a newly disclosed MW
    figure is deliberately different: planned or construction capacity is not
    evidence of operational capacity, so the current capacity stays null.
    """
    history = list(previous.get("statusHistory", [])) if previous else []
    candidate_history = list(candidate.get("statusHistory", []))
    for event in candidate_history:
        key = (event.get("date"), event.get("status"), event.get("capacityMw"), event.get("capacityKind"), event.get("sourceUrl"))
        if not any((old.get("date"), old.get("status"), old.get("capacityMw"), old.get("capacityKind"), old.get("sourceUrl")) == key for old in history):
            history.append(event)
    status_changed = previous and previous.get("status") != candidate.get("status")
    capacity_changed = previous and candidate.get("powerCapacityMw") is not None and previous.get("powerCapacityMw") != candidate.get("powerCapacityMw")
    if status_changed or capacity_changed:
        event = {
            "date": candidate.get("announcedAt") or candidate.get("lastVerifiedAt", "")[:10],
            "status": candidate["status"],
            "sourceUrl": candidate["sourceUrls"][0],
            **({"capacityMw": candidate["powerCapacityMw"]} if isinstance(candidate.get("powerCapacityMw"), (int, float)) else {}),
            **({"capacityKind": candidate["capacityKind"]} if candidate.get("capacityKind") else {}),
            "note": "自动采集发现官方页面中的状态或披露容量变化；以该公告日期为准。",
        }
        key = (event.get("date"), event.get("status"), event.get("capacityMw"), event.get("capacityKind"), event.get("sourceUrl"))
        if not any((old.get("date"), old.get("status"), old.get("capacityMw"), old.get("capacityKind"), old.get("sourceUrl")) == key for old in history):
            history.append(event)
    merged = {**(previous or {}), **candidate}
    if previous:
        merged["sourceUrls"] = list(dict.fromkeys([*(previous.get("sourceUrls", [])), *(candidate.get("sourceUrls", []))]))
        for key in ("expectedOperationalAt", "investmentValue", "investmentCurrency"):
            if candidate.get(key) is None and previous.get(key) is not None:
                merged[key] = previous[key]
        if previous.get("status") == candidate.get("status"):
            for key in ("powerCapacityMw", "capacityKind"):
                if candidate.get(key) is None and previous.get(key) is not None:
                    merged[key] = previous[key]
        elif candidate.get("powerCapacityMw") is None:
            merged["powerCapacityMw"] = None
            merged["capacityKind"] = candidate.get("capacityKind")
    merged["statusHistory"] = sorted(history, key=lambda event: (event.get("date", ""), event.get("status", "")))
    return merged


def restore_verified_baseline(project):
    """Backfill verified lifecycle metadata when an older cache lacks it.

    This only fills the initial fact hard-coded from an official source above.
    It never changes a project's current status or creates a capacity point.
    """
    baseline = PROJECT_BASELINES.get(project.get("id"))
    if not baseline:
        return project
    project.setdefault("stateCode", baseline["stateCode"])
    existing = list(project.get("statusHistory", []))
    for event in baseline["statusHistory"]:
        key = (event.get("date"), event.get("status"), event.get("capacityMw"), event.get("capacityKind"), event.get("sourceUrl"))
        if not any((old.get("date"), old.get("status"), old.get("capacityMw"), old.get("capacityKind"), old.get("sourceUrl")) == key for old in existing):
            existing.append(event)
    project["statusHistory"] = sorted(existing, key=lambda event: (event.get("date", ""), event.get("status", "")))
    return project


def capacity_signature(projects, statuses, verified_project_ids=None):
    verified_project_ids = None if verified_project_ids is None else set(verified_project_ids)
    facts = [
        {"id": project["id"], "status": project.get("status"), "capacityMw": project.get("powerCapacityMw"), "capacityKind": project.get("capacityKind"), "sources": project.get("sourceUrls", [])}
        for project in projects
        if project.get("status") in statuses
        and isinstance(project.get("powerCapacityMw"), (int, float))
        and (verified_project_ids is None or project.get("id") in verified_project_ids)
    ]
    return hashlib.sha256(json.dumps(sorted(facts, key=lambda item: item["id"]), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def retain_snapshots(previous, candidate):
    """Keep a point only when the disclosed capacity composition changes."""
    if candidate is None:
        return previous
    def key(point):
        items = point.get("originalItems") or {}
        return (point.get("value"), items.get("projectIds", ""), items.get("capacityKind", ""))
    compact = []
    for point in previous:
        if not compact or key(compact[-1]) != key(point):
            compact.append(point)
    if compact and key(compact[-1]) == key(candidate):
        return compact
    if compact and compact[-1].get("periodEnd") == candidate.get("periodEnd"):
        return [*compact[:-1], candidate]
    return [*compact, candidate]


def operational_milestone_observations(projects, official_source_urls, checked_at):
    """Build cumulative operational-status milestones from explicit project events.

    The value is a count of distinct projects in this fixed official sample. It
    is intentionally not a capacity figure: an operational announcement with
    no MW disclosure must remain usable as a lifecycle event without being
    converted into operational MW.
    """
    earliest_by_project = {}
    for project in projects:
        project_id = project.get("id")
        if not project_id:
            continue
        for event in project.get("statusHistory", []):
            if event.get("status") not in ("operational", "partially_operational"):
                continue
            if event.get("sourceUrl") not in official_source_urls:
                continue
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", event.get("date", "")):
                continue
            candidate = {
                "projectId": project_id,
                "projectName": project.get("name", project_id),
                "eventDate": event["date"],
                "status": event["status"],
                "sourceUrl": event["sourceUrl"],
            }
            previous = earliest_by_project.get(project_id)
            if previous is None or (candidate["eventDate"], candidate["sourceUrl"]) < (previous["eventDate"], previous["sourceUrl"]):
                earliest_by_project[project_id] = candidate

    events_by_date = {}
    for event in earliest_by_project.values():
        events_by_date.setdefault(event["eventDate"], []).append(event)

    seen = {}
    rows = []
    for event_date in sorted(events_by_date):
        new_events = sorted(events_by_date[event_date], key=lambda event: event["projectId"])
        seen.update({event["projectId"]: event for event in new_events})
        sample = [seen[project_id] for project_id in sorted(seen)]
        version = hashlib.sha256(json.dumps(sample, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        rows.append(observation(
            "PROJECT.operational_milestone_count", event_date, len(sample), new_events[-1]["sourceUrl"], checked_at, version,
            fiscal=f"截至 {event_date} 的固定公开样本",
            formula="cumulative count(distinct projectId with an explicit official operational-status event)",
            items={
                "newProjectIds": ",".join(event["projectId"] for event in new_events),
                "sampleProjectIds": ",".join(event["projectId"] for event in sample),
                "eventProjects": new_events,
                "sampleProjectCount": len(sample),
                "sampleBoundary": "fixed DOE/operator official project sample; undisclosed projects are not inferred",
                "capacityDisclosure": "operational status milestone only; no data-center MW is inferred or summed",
            },
            published=event_date,
        ))
    return rows


def metric_definition(metric_id, name, family, method):
    result = definition(
        metric_id,
        name,
        family,
        "projects",
        family,
        "DOE/运营商项目级公开样本",
        "U.S. DOE / 项目运营商官方公告",
        "https://www.energy.gov/powering-americas-ai-future-data-center-resource-hub",
        unit="MW",
        value_type="project_announcement",
        method=method,
        eligible=False,
        frequency="event",
        export=True,
    )
    result.update({
        "nameEn": "Disclosed operational capacity snapshot (sample)" if family == "operational_capacity" else "Capacity under construction (sample)",
        "sourceOwner": "U.S. Department of Energy / 项目运营商官方公告",
        "accessMethod": "官方DOE和运营商项目页；后台抓取、文本事实校验、项目ID去重",
        "normalUpdateDelayDays": 90,
        "isComparableAcrossEntities": False,
        "directness": "project_sample",
        "scoringTier": "leading_only",
        "licenseNote": "仅提取公开事实与汇总值，保留每个项目的官方来源链接；不再分发网页正文。",
        "interpretation": "公开项目样本，不代表美国或全球全量；只在本轮来源已核验且所有项目披露同一capacityKind时显示单一MW。项目披露的capacityKind见项目记录，不能默认等同于并网、现场发电或已投运容量，也不参与正式评分。",
    })
    return result


def operational_milestone_definition():
    result = definition(
        "PROJECT.operational_milestone_count",
        "公开项目投运里程碑（样本）",
        "Official project operational milestones (sample)",
        "projects",
        "operational_milestone",
        "DOE/运营商项目级公开样本",
        "U.S. DOE / 项目运营商官方公告",
        "https://datacenters.atmeta.com/",
        unit="个项目",
        value_type="project_announcement",
        method="按官方公告中明确的投运/承载流量日期，累计计数唯一项目ID；这是固定公开样本的状态里程碑，不是MW，也不代表全量市场。",
        eligible=False,
        frequency="event",
        export=True,
    )
    result.update({
        "sourceOwner": "U.S. Department of Energy / 项目运营商官方公告",
        "accessMethod": "官方DOE和运营商项目页；后台抓取、文本事实校验、项目ID去重",
        "normalUpdateDelayDays": 120,
        "isComparableAcrossEntities": False,
        "directness": "project_sample",
        "scoringTier": "leading_only",
        "licenseNote": "仅提取公开事件事实与项目ID，保留每个项目的官方来源链接；不再分发网页正文。",
        "interpretation": "仅表示固定公开样本中已找到明确官方投运公告的项目数。没有MW披露时不推断容量；该指标不参与投资建议评分。",
        "sampleScope": "固定DOE/运营商官方项目样本，非全国或全球统计。",
    })
    return result


def capacity_project_items(projects, statuses, verified_project_ids=None):
    """Return source-linked capacity facts without flattening their meanings."""
    verified_project_ids = None if verified_project_ids is None else set(verified_project_ids)
    items = []
    for project in projects:
        if (
            project.get("status") not in statuses
            or not isinstance(project.get("powerCapacityMw"), (int, float))
            or (verified_project_ids is not None and project.get("id") not in verified_project_ids)
        ):
            continue
        matching_events = [
            event for event in project.get("statusHistory", [])
            if event.get("status") in statuses and isinstance(event.get("capacityMw"), (int, float))
        ]
        latest_event = max(matching_events, key=lambda event: event.get("date", ""), default={})
        items.append({
            "projectId": project["id"],
            "capacityMw": project["powerCapacityMw"],
            "capacityKind": project.get("capacityKind") or latest_event.get("capacityKind") or "unspecified_project_capacity",
            "sourceUrl": latest_event.get("sourceUrl") or (project.get("sourceUrls") or [None])[0],
            "publishedAt": latest_event.get("date") or project.get("announcedAt"),
        })
    return sorted(items, key=lambda item: item["projectId"])


def homogeneous_capacity_kind(items):
    """Return a capacity kind only when the live sample is comparable.

    MW is a unit, not a measurement definition.  A published compute-capacity
    figure and a project-planning capacity can share the same numeric unit while
    referring to different things.  The caller must therefore present project
    facts separately whenever the source set contains more than one kind.
    """
    kinds = {item.get("capacityKind") or "unspecified_project_capacity" for item in items}
    return next(iter(kinds)) if len(kinds) == 1 and 'unspecified_project_capacity' not in kinds else None


def safe_capacity_snapshots(points):
    """Keep only prior snapshots that were produced from a comparable live sample."""
    return [
        point for point in points
        if (point.get("originalItems") or {}).get("aggregationBoundary") == "current_verified_homogeneous_capacity_kind"
    ]


def latest_capacity_publication(items):
    published = [item.get("publishedAt") for item in items if re.fullmatch(r"\d{4}-\d{2}-\d{2}", item.get("publishedAt") or "")]
    return max(published) if published else None


def build():
    checked_at = now()
    previous = load_previous_projects()
    previous_by_id = {p.get("id"): p for p in previous if p.get("id")}
    projects_by_id = dict(previous_by_id)
    sources = []
    successful = 0
    successful_source_ids = set()
    current_verified_project_ids = set()
    latest_fetch = None
    for spec in SOURCES:
        try:
            raw, fetched_at, digest = fetch(spec["url"])
            parsed = parse_source(spec, raw, fetched_at, digest)
            for project in parsed:
                # A project may appear in more than one current official source.
                # Merge against the most recently assembled record so no current
                # source fact is lost during this run.
                projects_by_id[project["id"]] = merge_project_history(projects_by_id.get(project["id"]), project)
                current_verified_project_ids.add(project["id"])
            successful += 1
            successful_source_ids.add(spec["id"])
            latest_fetch = max(latest_fetch or fetched_at, fetched_at)
            sources.append({"id": spec["id"], "name": spec["name"], "url": spec["url"], "status": "ready", "fetchedAt": fetched_at, "note": "官方页面事实已通过关键字段校验。"})
        except Exception as error:
            sources.append({"id": spec["id"], "name": spec["name"], "url": spec["url"], "status": "fetch_failed", "checkedAt": checked_at, "error": str(error), "note": "保留该来源的最近成功项目；若无历史版本则不显示容量。"})

    projects = [restore_verified_baseline(project) for project in projects_by_id.values()]
    snapshot_date = datetime.now(timezone.utc).date().isoformat()
    construction_items = capacity_project_items(projects, {"construction"}, current_verified_project_ids)
    operational_items = capacity_project_items(projects, {"operational", "partially_operational"}, current_verified_project_ids)
    construction_kind = homogeneous_capacity_kind(construction_items)
    operational_kind = homogeneous_capacity_kind(operational_items)
    construction_version = capacity_signature(projects, {"construction"}, current_verified_project_ids)
    operational_version = capacity_signature(projects, {"operational", "partially_operational"}, current_verified_project_ids)
    construction_published = latest_capacity_publication(construction_items)
    operational_published = latest_capacity_publication(operational_items)
    construction_source_url = max(construction_items, key=lambda item: item.get("publishedAt") or "", default={}).get("sourceUrl") or "https://www.energy.gov/powering-americas-ai-future-data-center-resource-hub"
    operational_source_url = max(operational_items, key=lambda item: item.get("publishedAt") or "", default={}).get("sourceUrl") or "https://datacenters.atmeta.com/"
    construction_source_ids = {spec["id"] for spec in SOURCES if spec.get("capacityRole") == "construction"}
    operational_milestone_source_ids = {spec["id"] for spec in SOURCES if spec.get("milestoneGroup") == "operational"}
    operational_source_ids = {spec["id"] for spec in SOURCES if spec.get("capacityRole") == "operational"} or operational_milestone_source_ids
    operational_source_urls = {spec["url"] for spec in SOURCES if spec.get("milestoneGroup") == "operational"}
    construction_sources_ready = construction_source_ids.issubset(successful_source_ids)
    operational_sources_ready = operational_source_ids.issubset(successful_source_ids)
    operational_milestone_sources_ready = operational_milestone_source_ids.issubset(successful_source_ids)
    failed_source_ids = [spec["id"] for spec in SOURCES if spec["id"] not in successful_source_ids]
    common_note = "仅展示本轮来源已核验且披露同一容量口径的公开项目样本，不代表全量市场；规划/审批/谈判项目不计入在建项目样本。"
    old_payload = json.loads((DATA / "projects.json").read_text(encoding="utf-8")) if (DATA / "projects.json").exists() else {}
    old_series = old_payload.get("series", {})
    old_construction = safe_capacity_snapshots(old_series.get("PROJECT.construction_capacity", {}).get("observations", []))
    old_operational = safe_capacity_snapshots(old_series.get("PROJECT.operational_capacity", {}).get("observations", []))
    old_milestones = old_series.get("PROJECT.operational_milestone_count", {}).get("observations", [])
    construction_obs = observation(
        "PROJECT.construction_capacity", snapshot_date, sum(item["capacityMw"] for item in construction_items), construction_source_url, checked_at, construction_version,
        fiscal="latest public snapshot", formula="sum(project.powerCapacityMw where status=construction, current source verified, and one disclosed capacityKind)",
        items={"projectCount": len(construction_items), "projectIds": ",".join(item["projectId"] for item in construction_items), "currentVerifiedProjectIds": ",".join(sorted(current_verified_project_ids)), "projects": construction_items, "capacityKind": construction_kind, "aggregationBoundary": "current_verified_homogeneous_capacity_kind", "sampleBoundary": "known official project sample", "capacityBoundary": "capacityKind is retained per project; disclosed compute or project capacity is not assumed to be grid, generation, or operational capacity"},
        published=construction_published,
    ) if construction_sources_ready and construction_items and construction_kind else None
    operational_obs = observation(
        "PROJECT.operational_capacity", snapshot_date, sum(item["capacityMw"] for item in operational_items), operational_source_url, checked_at, operational_version,
        fiscal="latest public snapshot", formula="sum(project.powerCapacityMw where status in (operational, partially_operational), current source verified, and one disclosed capacityKind)",
        items={"projectCount": len(operational_items), "projectIds": ",".join(item["projectId"] for item in operational_items), "currentVerifiedProjectIds": ",".join(sorted(current_verified_project_ids)), "projects": operational_items, "capacityKind": operational_kind, "aggregationBoundary": "current_verified_homogeneous_capacity_kind", "sampleBoundary": "known official project sample", "capacityBoundary": "an operational-status event without MW disclosure remains excluded rather than becoming zero MW"},
        published=operational_published,
    ) if operational_sources_ready and operational_items and operational_kind else None
    milestone_history = operational_milestone_observations(projects, operational_source_urls, checked_at) if operational_milestone_sources_ready else []
    construction_history = retain_snapshots(old_construction, construction_obs)
    operational_history = retain_snapshots(old_operational, operational_obs)
    construction_note = (
        common_note if construction_obs else
        "本轮已核验在建项目披露的容量口径不同，按项目保留，不合并为单一MW。"
        if construction_items and not construction_kind else
        "已核验建设项目中暂无可汇总的官方容量披露；不显示零。"
    )
    operational_note = (
        common_note if operational_obs else
        "本轮已核验投运项目披露的容量口径不同，按项目保留，不合并为单一MW。"
        if operational_items and not operational_kind else
        "已核验项目中暂无官方披露的已投运MW；投运里程碑另列，不显示零。"
    )
    if construction_sources_ready:
        construction_series = {
            "observations": construction_history,
            "status": "ready" if construction_obs else "no_observation",
            "fetchedAt": latest_fetch,
            "checkedAt": checked_at,
            "note": construction_note,
        }
    else:
        construction_series = {**old_series.get("PROJECT.construction_capacity", {}), "observations": old_construction, "status": "cached" if old_construction else "fetch_failed", "checkedAt": checked_at, "error": f"项目容量来源本轮未全部通过核验：{', '.join(failed_source_ids)}；仅保留此前同口径、来源已核验的快照。"}
    if operational_sources_ready:
        operational_series = {
            "observations": operational_history,
            "status": "ready" if operational_obs else "no_observation",
            "fetchedAt": latest_fetch,
            "checkedAt": checked_at,
            "note": operational_note,
        }
    else:
        operational_series = {**old_series.get("PROJECT.operational_capacity", {}), "observations": old_operational, "status": "cached" if old_operational else "fetch_failed", "checkedAt": checked_at, "error": f"投运状态来源本轮未全部通过核验：{', '.join(failed_source_ids)}；仅保留此前同口径、来源已核验的快照。"}
    if operational_milestone_sources_ready:
        milestone_series = {
            "observations": milestone_history,
            "status": "ready" if milestone_history else "no_observation",
            "fetchedAt": latest_fetch,
            "checkedAt": checked_at,
            "note": "固定官方项目样本的投运状态事件；按项目ID累计，非MW，未参与投资建议评分。",
        }
    else:
        milestone_series = {**old_series.get("PROJECT.operational_milestone_count", {}), "status": "cached" if old_milestones else "fetch_failed", "checkedAt": checked_at, "error": f"投运状态来源本轮未全部通过核验：{', '.join(failed_source_ids)}；保留最近成功版本。"}
    result = {
        "schemaVersion": "1",
        "generatedAt": checked_at,
        "definitions": [
            metric_definition("PROJECT.operational_capacity", "公开项目已投运容量（同口径样本）", "operational_capacity", "仅在本轮来源已核验、status为operational或partially_operational且所有项目披露同一capacityKind时合计；没有已投运MW时保留空值，不填零。"),
            metric_definition("PROJECT.construction_capacity", "公开项目在建容量（同口径样本）", "construction_capacity", "仅在本轮来源已核验、status为construction且所有项目披露同一capacityKind时合计；规划、审批、谈判项目不计入在建项目样本。"),
            operational_milestone_definition(),
        ],
        "series": {"PROJECT.operational_capacity": operational_series, "PROJECT.construction_capacity": construction_series, "PROJECT.operational_milestone_count": milestone_series},
        "projects": projects,
        "events": [],
        "sources": sources,
    }
    persist(result, DATA / "projects.json")
    return result


if __name__ == "__main__":
    result = build()
    print(json.dumps({"projects": len(result["projects"]), "sources": result["sources"], "construction": result["series"]["PROJECT.construction_capacity"]["status"], "operational": result["series"]["PROJECT.operational_capacity"]["status"], "operationalMilestones": result["series"]["PROJECT.operational_milestone_count"]["status"]}, ensure_ascii=False))
