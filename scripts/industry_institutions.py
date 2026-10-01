"""Open institutional evidence with explicit reuse and statistical boundaries.

CSO's metered electricity dataset is an actual, regional load observation, not
AI-only demand or operational / construction MW. IEA estimates and projections
remain report context and never enter the observation or formal scoring tables.
Commercial institutions are catalogued as requiring authorisation; this adapter
does not fetch their report bodies, store their numbers or send them to a model.
"""
from __future__ import annotations

import calendar
import html
import json
import math
import re
import sys
from datetime import datetime, timezone

from industry_common import DATA, definition, fetch, now, observation, persist


CSO_ID = "CSO.datacenter_electricity"
CSO_API = "https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/MEC02/JSON-stat/2.0/en"
CSO_PAGE = "https://data.cso.ie/table/MEC02"
CSO_LICENCE = "https://www.cso.ie/en/aboutus/whoweare/copyrightpolicy/"
IEA_ID = "IEA.energy_ai_2026"
IEA_PAGE = "https://www.iea.org/reports/key-questions-on-energy-and-ai"
IEA_FACTS = IEA_PAGE + "/executive-summary"
IEA_LICENCE = "https://www.iea.org/terms/creative-commons-cc-licenses"
LICENCE_REVIEWED_AT = "2026-10-01"

# A source-discovery directory is not an authorisation grant. Keep the actual
# restricted content out of all downstream datasets and model inputs.
RESTRICTED_SOURCES = (
    ("frost_sullivan", "Frost & Sullivan / 沙利文", "AI Computing and Data Centers",
     "https://www.frost.com/growth-opportunity-news/ai-computing-and-data-centers-building-the-foundation-for-the-ai-native-era-economy-opportunity-tnv10_tg23_aicomputingdatacenters_jul26_cim-sn/",
     "https://www.frost.com/terms-of-use/", "AI基础设施趋势、市场口径与报告发现",
     "官方使用条款限制采集、衍生整理和公开展示；尚无本站所需数据使用授权，公开摘要也不能代替连续实际历史。"),
    ("idc_server_tracker", "IDC", "Worldwide Quarterly Server Tracker",
     "https://www.idc.com/promo/servers/", "https://www.idc.com/about/termsofuse/",
     "服务器市场收入、出货与加速服务器的行业核验",
     "官方条款要求外部使用许可，并限制自动抓取及将材料输入高级分析或AI系统；现未获授权。"),
    ("trendforce_memory", "TrendForce", "DRAM / NAND / HBM Research",
     "https://www.trendforce.com/presscenter/", "https://www.trendforce.com/about/terms",
     "存储收入、价格与供需口径发现",
     "官方条款限制无书面许可复制、改编、展示及数据采集；署名指南并非数据库或模型使用许可。"),
    ("synergy_hyperscale", "Synergy Research Group", "Hyperscale Data Center and Cloud Research",
     "https://www.srgresearch.com/articles", "https://www.srgresearch.com/about",
     "云基础设施市场、超大规模数据中心数量与容量核验",
     "官方Citation Policy要求非客户的内外部使用先获审批；本站尚未获批，不能把新闻数值拼成可分发数据库。"),
    ("uptime_survey", "Uptime Institute", "Global Data Center Survey",
     "https://uptimeinstitute.com/resources/research-and-reports", "https://uptimeinstitute.com/publication-usage",
     "PUE、机架密度、设备与运营约束的调查证据",
     "官方Publication Usage要求非个人用途书面许可；调查自报样本会变化，不能代替实际建设MW或全球容量加权效率。"),
    ("cbre_datacenter_trends", "CBRE", "North America Data Center Trends",
     "https://www.cbre.com/insights/books/north-america-data-center-trends-h2-2025",
     "https://www.cbre.com/about-us/disclaimer-terms-of-use",
     "主要批发市场在建容量、库存、吸纳与租金的口径核验",
     "官方条款限制无许可复制、存储、衍生及抓取；覆盖特定市场且存在历史修订，不能盲拼为全美AI容量。"),
)


def _category_codes(category: dict, size: int) -> list[str]:
    index = category.get("index")
    if isinstance(index, list):
        codes = index
    elif isinstance(index, dict):
        positions = list(index.values())
        if sorted(positions) != list(range(size)):
            raise ValueError("JSON-stat分类位置不连续或重复")
        codes = sorted(index, key=index.get)
    else:
        raise ValueError("JSON-stat缺少分类索引")
    if len(codes) != size or len(set(codes)) != size:
        raise ValueError("JSON-stat分类长度或唯一性错误")
    return codes


def _published_at(value: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("来源缺少发布时间updated")
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("来源发布时间没有时区")
    if stamp > datetime.now(timezone.utc):
        raise ValueError("来源发布时间位于未来")
    return stamp.isoformat()


def next_annual_release(published_at: str) -> str:
    """Cadence estimate, never presented as a confirmed official release date."""
    stamp = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    day = min(stamp.day, calendar.monthrange(stamp.year + 1, stamp.month)[1])
    return stamp.replace(year=stamp.year + 1, day=day).isoformat()


def parse_cso(raw: bytes) -> dict:
    payload = json.loads(raw.decode("utf-8-sig"))
    dimensions = payload.get("id", [])
    sizes = payload.get("size", [])
    expected = {"STATISTIC", "TLIST(Q1)", "C03907V04659"}
    if set(dimensions) != expected or len(dimensions) != 3 or len(sizes) != 3:
        raise ValueError("CSO MEC02的JSON-stat维度发生变化")
    if any(isinstance(size, bool) or not isinstance(size, int) or size < 1 for size in sizes):
        raise ValueError("JSON-stat维度长度错误")
    codes = {
        name: _category_codes(payload["dimension"][name]["category"], size)
        for name, size in zip(dimensions, sizes)
    }
    statistic = payload["dimension"]["STATISTIC"]["category"]
    if "MEC02" not in codes["STATISTIC"] or statistic.get("unit", {}).get("MEC02", {}).get("label") != "GWh":
        raise ValueError("CSO统计代码或单位不再是MEC02/GWh")
    consumption = payload["dimension"]["C03907V04659"]["category"]
    if "10" not in codes["C03907V04659"] or not re.search(r"data\s+cent(?:re|er)s", consumption.get("label", {}).get("10", ""), re.I):
        raise ValueError("CSO类别10不再对应数据中心")
    published = _published_at(payload.get("updated"))
    values = payload.get("value")
    total = math.prod(sizes)
    if isinstance(values, list):
        if len(values) != total:
            raise ValueError("JSON-stat观测长度与维度不符")
        value_at = lambda index: values[index]
    elif isinstance(values, dict):
        if any(not str(key).isdigit() or int(key) >= total for key in values):
            raise ValueError("JSON-stat稀疏观测索引越界")
        value_at = lambda index: values.get(str(index))
    else:
        raise ValueError("JSON-stat缺少value观测")
    strides = {name: math.prod(sizes[i + 1:]) for i, name in enumerate(dimensions)}
    metric_offset = codes["STATISTIC"].index("MEC02") * strides["STATISTIC"]
    load_offset = codes["C03907V04659"].index("10") * strides["C03907V04659"]
    rows = []
    seen = set()
    for i, quarter in enumerate(codes["TLIST(Q1)"]):
        match = re.fullmatch(r"(\d{4})Q([1-4])", quarter)
        if not match or quarter in seen:
            raise ValueError("CSO季度标签无效或重复")
        seen.add(quarter)
        year, number = map(int, match.groups())
        month = number * 3
        end = f"{year:04}-{month:02}-{calendar.monthrange(year, month)[1]:02}"
        if datetime.fromisoformat(end).date() > datetime.now(timezone.utc).date():
            raise ValueError("CSO数据中包含未来季度，不能当成实际观测")
        value = value_at(metric_offset + load_offset + i * strides["TLIST(Q1)"])
        if value is not None and (isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0):
            raise ValueError("CSO用电观测不是有效的非负数值")
        rows.append({"quarter": quarter, "periodEnd": end,
                     "periodStart": f"{year:04}-{month - 2:02}-01", "value": value})
    rows.sort(key=lambda row: row["periodEnd"])
    return {"observations": rows, "publishedAt": published,
            "sourceNextExpectedAt": next_annual_release(published)}


def cso_definition() -> dict:
    metric = definition(
        CSO_ID, "爱尔兰数据中心计量用电", "Ireland data centres metered electricity consumption",
        "projects", "datacenter_electricity_consumption", "爱尔兰",
        "CSO Ireland / MEC02", CSO_PAGE, "GWh", "official",
        "爱尔兰CSO按已识别数据中心统计电表计量用电，JSON-stat MEC02类别10；季度观测、年度发布。保留来源修订和缺失值，不推算MW，不外推为美国或全球AI负荷。",
        False, "quarterly", True,
    )
    metric.update({
        "sourceAdapter": "institutions", "sourceOwner": "Central Statistics Office Ireland / Government of Ireland",
        "accessMethod": "CSO公开JSON-stat API，后台采集", "sourceApiUrl": CSO_API,
        "sourceReleaseUrl": "https://www.cso.ie/en/statistics/energy/datacentresmeteredelectricityconsumption/",
        "sourceReleaseFrequency": "annual", "sourceReleaseDelayDays": 35,
        "freshnessBasis": "source_publication", "normalUpdateDelayDays": 485,
        "directness": "regional_load_proxy", "scoringTier": "leading_only",
        "dataRole": "regional_datacenter_load", "proxyTargets": ["data_centers", "power", "overall"],
        "aggregation": "sum", "isComparableAcrossEntities": False, "currency": None,
        "licenseUrl": CSO_LICENCE, "licenseNote": "CSO统计数据：Government of Ireland，CC BY 4.0；保留署名、来源和修改说明。",
        "interpretation": "真实计量区域数据中心用电，体现爱尔兰已识别设施的用电活动；不是AI专属需求、全国装机MW或建设进度。",
        "transmission": "用电增长可补充区域投运活动和供电压力研究；不能单独推导设备订单、美国建设或股票收益。",
        "crossCheck": "当地并网、项目投运、公司实际收入与电力合同；需要单独核对地域、设施识别和自发电覆盖。",
    })
    return metric


def parse_iea_scenario(raw: bytes) -> list[dict]:
    text = raw.decode("utf-8-sig")
    text = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", text, flags=re.I | re.S)
    text = html.unescape(re.sub(r"<[^>]*>", " ", text))
    text = re.sub(r"\s+", " ", text)
    if "Key Questions on Energy and AI" not in text or not re.search(r"CC\s+BY\s+4\.0", text):
        raise ValueError("IEA报告标题或CC BY 4.0许可标记不匹配")
    # Parse explicit report text only. No chart digitisation, guessed values or
    # interpolation when the source does not expose a downloadable series.
    matches = re.findall(
        r"electricity consumption from data cent(?:re|er)s roughly doubling from\s+([\d,.]+)\s*TWh\s+in\s+(\d{4})\s+to\s+([\d,.]+)\s*TWh\s+in\s+(\d{4})",
        text, flags=re.I,
    )
    if len(set(matches)) != 1:
        raise ValueError("IEA公开正文未找到唯一的年度估算与预测句，保留来源链接")
    baseline, first_year, projection, last_year = matches[0]
    baseline, projection = float(baseline.replace(",", "")), float(projection.replace(",", ""))
    if first_year != "2025" or last_year != "2030" or not all(math.isfinite(value) and 0 < value < 10000 for value in [baseline, projection]):
        raise ValueError("IEA报告年份或数值量纲发生变化，需重新核验")
    return [
        {"period": first_year, "value": baseline, "label": "全球数据中心用电历史估算", "nature": "estimate"},
        {"period": last_year, "value": projection, "label": "全球数据中心用电情景预测", "nature": "forecast"},
    ]


def source_catalog() -> list[dict]:
    catalogue = [
        {"id": "cso_ireland_datacenter_load", "publisher": "Central Statistics Office Ireland",
         "title": "Data Centres Metered Electricity Consumption / MEC02", "sourceUrl": CSO_PAGE,
         "licenseUrl": CSO_LICENCE, "status": "configured", "modelUseAllowed": True,
         "exportAllowed": True, "purpose": "爱尔兰数据中心季度实际计量用电，区域负荷交叉验证",
         "reason": "官方CC BY 4.0开放统计API；仅区域代理，不替代项目MW或AI专属需求。",
         "checkedAt": LICENCE_REVIEWED_AT},
        {"id": IEA_ID, "publisher": "IEA", "title": "Key Questions on Energy and AI (2026)",
         "sourceUrl": IEA_PAGE, "licenseUrl": IEA_LICENCE, "status": "configured",
         "modelUseAllowed": True, "exportAllowed": True, "purpose": "全球数据中心供电情景的估算/预测背景",
         "reason": "报告CC BY 4.0；只提取官网明确数值并保留估算/预测身份，不进入实际观测评分。",
         "checkedAt": LICENCE_REVIEWED_AT},
    ]
    for ident, publisher, title, url, licence, purpose, reason in RESTRICTED_SOURCES:
        catalogue.append({"id": ident, "publisher": publisher, "title": title, "sourceUrl": url,
                          "licenseUrl": licence, "status": "authorization_required", "modelUseAllowed": False,
                          "exportAllowed": False, "purpose": purpose, "reason": reason,
                          "checkedAt": LICENCE_REVIEWED_AT})
    return catalogue


def _cached_series(previous: dict | None, error: str) -> dict:
    prior = previous or {"observations": []}
    observations = prior.get("observations", [])
    return {**prior, "observations": observations, "status": "cached" if any(point.get("value") is not None for point in observations) else "fetch_failed",
            "checkedAt": now(), "error": error,
            "note": "本次公开来源获取或校验失败；保留最后成功版本，不补零、不创造新季度。"}


def _report_base() -> dict:
    return {"id": IEA_ID, "publisher": "IEA", "title": "Key Questions on Energy and AI (2026)",
            "publishedAt": "2026-04-16", "sourceUrl": IEA_FACTS, "licenseUrl": IEA_LICENCE,
            "licenseNote": "IEA (2026), Key Questions on Energy and AI, Licence: CC BY 4.0. This is a work derived by AI产业链宏观观察台 from IEA material and AI产业链宏观观察台 is solely liable and responsible for this derived work. The derived work is not endorsed by the IEA or its Member countries in any manner.",
            "modelUseAllowed": True, "observationNature": "forecast", "modelRole": "scenario_only",
            "scope": "全球全部数据中心，包含非AI负荷；报告估算与情景预测", "unit": "TWh",
            "methodology": "仅解析官方摘要唯一的2025历史用电估算至2030情景预测句；保留报告版本、页面和许可，不数字化图线、不插值，不进入季度实际评分。"}


def build(*, force: bool = False) -> dict:
    path = DATA / "institutions.json"
    old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"series": {}, "researchReports": []}
    result = {"schemaVersion": "1", "generatedAt": now(), "definitions": [cso_definition()],
              "series": {}, "projects": [], "events": [], "sources": [],
              "researchReports": [], "sourceCatalog": source_catalog()}
    try:
        raw, stamp, version = fetch(CSO_API, force=force)
        parsed = parse_cso(raw)
        observations = [
            observation(CSO_ID, row["periodEnd"], row["value"], CSO_PAGE, stamp, version,
                        start=row["periodStart"], fiscal=row["quarter"], published=parsed["publishedAt"],
                        formula="MEC02官方季度计量GWh；按JSON-stat维度定位Data centres类别10；不重采样",
                        items={"sourceDataset": "MEC02", "sourceCategory": "10", "sourceQuarter": row["quarter"],
                               "sourceApiUrl": CSO_API, "directness": "regional_load_proxy", "coverage": "Ireland"})
            for row in parsed["observations"]
        ]
        status = "ready" if any(point["value"] is not None for point in observations) else "pending"
        result["series"][CSO_ID] = {"observations": observations, "status": status, "fetchedAt": stamp,
                                   "lastSuccessfulAt": stamp, "checkedAt": now(), "error": None,
                                   "sourcePublishedAt": parsed["publishedAt"], "sourceReleaseFrequency": "annual",
                                   "sourceNextExpectedAt": parsed["sourceNextExpectedAt"], "version": version,
                                   "note": "爱尔兰区域实际计量用电；季度观测每年发布，下次时间按年度节奏估计，非官方确认日程。" if status == "ready" else "来源已获取但尚无已发布数值；不将未发布观测填零。"}
        prior = old.get("series", {}).get(CSO_ID, {})
        if status == "pending" and any(point.get("value") is not None for point in prior.get("observations", [])):
            result["series"][CSO_ID] = _cached_series(prior, "本次来源返回未发布占位观测，保留最后成功数据")
            result["series"][CSO_ID]["sourceStatus"] = "pending"
            result["series"][CSO_ID]["note"] = "来源本次尚无已发布有效数值，展示最后成功缓存；不补零、不删除已获取历史。"
    except Exception as exc:
        result["series"][CSO_ID] = _cached_series(old.get("series", {}).get(CSO_ID), str(exc))
    cso_series = result["series"][CSO_ID]
    result["sources"].append({"id": "CSO.MEC02", "name": "CSO Ireland / MEC02", "url": CSO_API,
                               "status": cso_series["status"], "fetchedAt": cso_series.get("fetchedAt"),
                               "checkedAt": cso_series["checkedAt"], "publishedAt": cso_series.get("sourcePublishedAt"),
                               "error": cso_series.get("error"), "note": cso_series["note"]})
    result["sourceCatalog"][0]["status"] = cso_series.get("sourceStatus", cso_series["status"])
    report = _report_base()
    try:
        raw, stamp, version = fetch(IEA_FACTS, force=force)
        facts = parse_iea_scenario(raw)
        report.update({"facts": facts, "status": "ready", "version": version,
                       "fetchedAt": stamp, "lastSuccessfulAt": stamp, "checkedAt": now(), "error": None})
    except Exception as exc:
        previous = next((item for item in old.get("researchReports", []) if item.get("id") == IEA_ID), {})
        facts = previous.get("facts", [])
        report.update({"facts": facts, "status": "cached" if facts else "fetch_failed",
                       "version": previous.get("version", ""), "fetchedAt": previous.get("fetchedAt"),
                       "lastSuccessfulAt": previous.get("lastSuccessfulAt"), "checkedAt": now(), "error": str(exc)})
    result["researchReports"].append(report)
    result["sourceCatalog"][1]["status"] = report["status"]
    result["sources"].append({"id": IEA_ID, "name": "IEA / Key Questions on Energy and AI",
                               "url": IEA_FACTS, "status": report["status"], "fetchedAt": report.get("fetchedAt"),
                               "checkedAt": report["checkedAt"], "error": report.get("error"),
                               "note": "CC BY 4.0报告；全球估算与预测仅作为情景，不进入实际历史评分。"})
    persist(result, path)
    return result


if __name__ == "__main__":
    payload = build(force="--force" in sys.argv)
    print(json.dumps({"series": {ident: item["status"] for ident, item in payload["series"].items()},
                      "reports": {item["id"]: item["status"] for item in payload["researchReports"]}}, ensure_ascii=False))
