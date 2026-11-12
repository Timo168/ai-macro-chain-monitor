"""Two attributed public Cleanview facts; no paid tables or private API.

Only the visible operating-capacity row for the named Meta campus is read.
Cleanview's facility/grid-draw power is kept separate from Epoch's IT power.
"""
import copy
import hashlib
import json
import math
import re
from datetime import datetime

from bs4 import BeautifulSoup

from industry_common import fetch


SPECS = (
    {"projectId": "META-US-AZ-MESA", "id": "CLEANVIEW.META.MESA.CURRENT", "sourceId": "CLEANVIEW.US.AZ",
     "name": "Meta Mesa", "state": "Arizona", "county": "Maricopa County",
     "url": "https://cleanview.co/data-centers/arizona", "path": "/data-centers/arizona/meta-mesa-234"},
    {"projectId": "META-US-MO-KANSAS-CITY", "id": "CLEANVIEW.META.KANSAS_CITY.CURRENT", "sourceId": "CLEANVIEW.US.MO",
     "name": "Meta Kansas City", "state": "Missouri", "county": "Clay County",
     "url": "https://cleanview.co/data-centers/missouri", "path": "/data-centers/missouri/meta-kansas-city-235"},
)


def parse_public_capacity(raw, spec, checked_at):
    """Return only a visible, identity-checked operating row, not a page number."""
    html = raw.decode("utf-8") if isinstance(raw, bytes) else raw
    soup = BeautifulSoup(html, "html.parser")
    for script in soup(["script", "style"]):
        script.decompose()
    text = soup.get_text(" ", strip=True)
    heading = soup.find("h1")
    if not heading or heading.get_text(" ", strip=True) != f"Data centers in {spec['state']}":
        raise ValueError("Cleanview 州页面身份不匹配")
    if not re.search(r"power capacity.*electricity.*draw from the grid", text, re.I):
        raise ValueError("Cleanview 设施用电容量定义缺失或变化")
    dates = set(re.findall(r"Last updated ([A-Z][a-z]+ \d{1,2}, \d{4})", text))
    if len(dates) != 1:
        raise ValueError("Cleanview 公开页面更新日期缺失或不一致")
    as_of = datetime.strptime(next(iter(dates)), "%B %d, %Y").date().isoformat()
    if as_of > checked_at[:10]:
        raise ValueError("Cleanview 页面更新时间晚于本次核验")

    rows = []
    operating_tables = 0
    for table in soup.find_all("table"):
        headers = [x.get_text(" ", strip=True) for x in table.find_all("th")]
        if "Operating capacity" not in headers:
            continue
        if not all(field in headers for field in ("Campus", "Developer", "County")):
            raise ValueError("Cleanview 公开表头结构变化")
        operating_tables += 1
        for tr in table.find_all("tr"):
            cells = tr.find_all("td", recursive=False)
            if not cells:
                continue
            if len(cells) != len(headers):
                raise ValueError("Cleanview 公开表列数变化")
            mapped = dict(zip(headers, cells))
            campus = mapped["Campus"]
            if campus.get_text(" ", strip=True) != spec["name"]:
                continue
            link = campus.find("a")
            if not link or link.get("href", "").removeprefix("https://cleanview.co") != spec["path"]:
                raise ValueError("Cleanview 项目链接不匹配")
            if mapped["Developer"].get_text(" ", strip=True) != "Meta" or mapped["County"].get_text(" ", strip=True) != spec["county"]:
                raise ValueError("Cleanview 项目业主或地点不匹配")
            rows.append(mapped["Operating capacity"].get_text(" ", strip=True))
    if operating_tables != 1 or len(rows) > 1:
        raise ValueError("Cleanview 投运容量表缺失或项目重复")
    if not rows or rows[0].lower() in ("", "—", "–", "not disclosed", "not reported", "on paid plans"):
        return {"asOfDate": as_of, "publishedAt": as_of, "valueMw": None, "status": "not_published",
                "note": "公开投运容量表当前未列出该项目的容量数字。"}
    raw_value = rows[0]
    point = re.fullmatch(r"([\d,]+(?:\.\d+)?)\s*MW", raw_value)
    bound = re.fullmatch(r"Under\s+([\d,]+(?:\.\d+)?)\s*MW", raw_value, re.I)
    if not point and not bound:
        raise ValueError("Cleanview 容量表述变化，等待复核")
    value = float((point or bound).group(1).replace(",", ""))
    if not math.isfinite(value) or value <= 0:
        raise ValueError("Cleanview 投运容量数值无效")
    return {"asOfDate": as_of, "publishedAt": as_of, "valueMw": value if point else None,
            **({"upperBoundMw": value, "valueQualifier": "less_than"} if bound else {}),
            "status": "ready", "note": "公开页面截至该日的投运建筑设施用电容量。" +
            ("仅公布小于该上限的范围，未公布点估计。" if bound else "")}


def collect_cleanview(projects, checked_at, fetcher=fetch):
    """Keep official project facts unchanged and append bounded source evidence."""
    from industry_project_capacity import retain_evidence

    updated = copy.deepcopy(projects)
    by_id = {project["id"]: project for project in updated}
    sources = []
    for spec in SPECS:
        project = by_id.get(spec["projectId"])
        if project is None:
            continue
        previous = next((item for item in project.get("capacityEvidence", []) if item.get("id") == spec["id"]), None)
        base = {"id": spec["id"], "sourceType": "institutional_estimate", "sourceName": "Cleanview",
                "sourceUrl": spec["url"], "sourceId": spec["sourceId"], "methodologyUrl": spec["url"],
                "capacityKind": "facility_power", "scope": "current", "coverageScope": "园区已投运建筑",
                "method": "Cleanview 根据许可、企业披露与卫星影像整理；设施用电容量包括服务器及冷却等设备。",
                "licenseNote": "仅引用两项公开页面事实并署名链接；未接入付费逐建筑数据。",
                "checkedAt": checked_at}
        source = {"id": spec["sourceId"], "name": "Cleanview 公开容量参考", "url": spec["url"],
                  "projectIds": [spec["projectId"]], "checkedAt": checked_at}
        try:
            retry = previous and previous.get("status") in ("cached", "fetch_failed")
            raw, fetched_at, source_version = fetcher(spec["url"], **({"force": True} if retry else {}))
            parsed = parse_public_capacity(raw, spec, checked_at)
            if parsed["status"] == "not_published" and previous and (previous.get("valueMw") is not None or previous.get("upperBoundMw") is not None):
                evidence = {**previous, "status": "cached", "checkedAt": checked_at,
                            "error": "公开排名当前未列出容量，保留上次成功记录及其原始日期。"}
            else:
                version = hashlib.sha256(json.dumps([spec["id"], parsed], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                evidence = {**base, **parsed, "fetchedAt": fetched_at, "lastSuccessfulAt": fetched_at,
                            "version": version, "sourceVersion": source_version}
            retain_evidence(project, evidence)
            source.update({"status": evidence["status"], "fetchedAt": evidence.get("fetchedAt"),
                           "lastSuccessfulAt": evidence.get("lastSuccessfulAt"), "error": evidence.get("error")})
        except Exception as exc:
            has_value = previous and (previous.get("valueMw") is not None or previous.get("upperBoundMw") is not None)
            evidence = {**(previous or base), "status": "cached" if has_value else "fetch_failed",
                        "checkedAt": checked_at, "error": str(exc)}
            if not previous:
                evidence.update({"valueMw": None, "asOfDate": None, "publishedAt": None, "fetchedAt": None,
                                 "lastSuccessfulAt": None, "version": None})
            retain_evidence(project, evidence)
            source.update({"status": evidence["status"], "error": str(exc),
                           "fetchedAt": evidence.get("fetchedAt"), "lastSuccessfulAt": evidence.get("lastSuccessfulAt")})
        sources.append(source)
    return updated, sources
