"""Official U.S. infrastructure and hardware-demand proxies for AI research.

These Census series describe broad private construction categories, not data
center capacity or project completion.  They are therefore retained as
``proxy`` observations: useful for a leading, conditional research layer, but
never a substitute for project-level MW, interconnection, or contract data.
Missing FRED observations are kept as nulls and a failed refresh keeps the
last successful observations with an explicit cached/failure status.
"""
from __future__ import annotations

import calendar
import json
import sys
from datetime import date

from collect import parse_csv
from industry_common import DATA, definition, fetch, now, observation, persist


FRED_GRAPH = "https://fred.stlouisfed.org/graph/fredgraph.csv?id="
CONSTRUCTION_RELEASE = "https://fred.stlouisfed.org/release?rid=46"
M3_RELEASE = "https://fred.stlouisfed.org/release?rid=53"

# All three are U.S. Census Bureau Construction Spending series.  Seasonally
# adjusted annual rates make their monthly direction comparable without
# treating seasonal construction patterns as a new AI signal.
SERIES = (
    {
        "id": "CENSUS.private_power_construction",
        "code": "PRPWRCONS",
        "name": "美国私营电力建设支出",
        "name_en": "U.S. private power construction spending",
        "family": "grid_construction_spending",
        "category": "power",
        "stage": "power",
        "unit": "百万美元（季调年率）",
        "seasonal_adjustment": "SAAR",
        "aggregation": "mean",
        "data_role": "construction_environment_proxy",
        "source_release_url": CONSTRUCTION_RELEASE,
        "methodology": "美国人口普查局Construction Spending月度序列，经FRED公开CSV取得；原始观测为季调年率，原始日期为月初，展示期末为对应自然月月末。此指标是行业施工环境代理，不能等同于数据中心MW、项目建设进度或企业订单。",
        "interpretation": "美国私营Power（含电力、油气）建设支出，反映广义能源基础设施施工活动；不是数据中心投资或并网容量。",
        "transmission": "持续扩张可作为发电、输配电和设备需求环境的前瞻线索；仍需与EIA机组、项目级状态和设备订单交叉验证。",
        "proxy_targets": ["power", "overall"],
    },
    {
        "id": "CENSUS.private_communications_construction",
        "code": "PRCMUCONS",
        "name": "美国私营通信建设支出",
        "name_en": "U.S. private communications construction spending",
        "family": "communications_construction_spending",
        "category": "projects",
        "stage": "data_centers",
        "unit": "百万美元（季调年率）",
        "seasonal_adjustment": "SAAR",
        "aggregation": "mean",
        "data_role": "construction_environment_proxy",
        "source_release_url": CONSTRUCTION_RELEASE,
        "methodology": "美国人口普查局Construction Spending月度序列，经FRED公开CSV取得；原始观测为季调年率，原始日期为月初，展示期末为对应自然月月末。此指标是行业施工环境代理，不能等同于数据中心MW、项目建设进度或企业订单。",
        "interpretation": "美国私营通信建设支出，覆盖广义通信基础设施；不能视为数据中心建设面积、机架或MW。",
        "transmission": "可补充观察通信基础设施施工周期，与数据中心相关但不具专属性；必须同项目级公告、云厂商资本开支和电力接入证据共同使用。",
        "proxy_targets": ["data_centers", "overall"],
    },
    {
        "id": "CENSUS.private_manufacturing_construction",
        "code": "PRMFGCONS",
        "name": "美国私营制造业建设支出",
        "name_en": "U.S. private manufacturing construction spending",
        "family": "manufacturing_construction_spending",
        "category": "semiconductor",
        "stage": "semiconductor",
        "unit": "百万美元（季调年率）",
        "seasonal_adjustment": "SAAR",
        "aggregation": "mean",
        "data_role": "construction_environment_proxy",
        "source_release_url": CONSTRUCTION_RELEASE,
        "methodology": "美国人口普查局Construction Spending月度序列，经FRED公开CSV取得；原始观测为季调年率，原始日期为月初，展示期末为对应自然月月末。此指标是行业施工环境代理，不能等同于数据中心MW、项目建设进度或企业订单。",
        "interpretation": "美国私营制造业建设支出，包含多行业厂房，不能视为半导体晶圆厂或先进封装产能。",
        "transmission": "可作为美国制造业扩产环境的补充观察，不能替代晶圆厂开工、设备装机、封装产能或公司订单证据。",
        "proxy_targets": ["foundry", "packaging", "memory", "accelerators"],
    },
    {
        "id": "CENSUS.computer_electronics_new_orders",
        "code": "A34SNO",
        "name": "美国计算机及电子产品制造业新订单",
        "name_en": "U.S. manufacturers' new orders: computers and electronic products",
        "family": "computer_electronics_orders",
        "category": "semiconductor",
        "stage": "semiconductor",
        "unit": "百万美元（季调）",
        "seasonal_adjustment": "SA",
        "aggregation": "sum",
        "data_role": "hardware_demand_proxy",
        "source_release_url": M3_RELEASE,
        "methodology": "美国人口普查局M3 Manufacturers' Shipments, Inventories, and Orders月度新订单序列，经FRED公开CSV取得；覆盖计算机和电子产品的广义制造业订单，包含非AI产品，不能当作AI芯片、服务器或云订单。",
        "interpretation": "美国计算机及电子产品制造业新订单，覆盖广义行业订单而非AI专属需求。",
        "transmission": "订单趋势可作为服务器、网络与半导体景气的补充观察；需要与公司分部收入、AI服务器订单、半导体销售和库存共同核对。",
        "proxy_targets": ["servers", "accelerators", "foundry", "packaging", "memory", "overall"],
    },
    {
        "id": "CENSUS.communications_equipment_new_orders",
        "code": "A34XNO",
        "name": "美国通信设备制造业新订单",
        "name_en": "U.S. manufacturers' new orders: communications equipment",
        "family": "communications_equipment_orders",
        "category": "servers",
        "stage": "servers",
        "unit": "百万美元（季调）",
        "seasonal_adjustment": "SA",
        "aggregation": "sum",
        "data_role": "hardware_demand_proxy",
        "source_release_url": M3_RELEASE,
        "methodology": "美国人口普查局M3 Manufacturers' Shipments, Inventories, and Orders月度新订单序列，经FRED公开CSV取得；覆盖广义通信设备制造业，不能等同数据中心网络设备或AI服务器订单。",
        "interpretation": "美国通信设备制造业新订单，涵盖多种网络与通信用途，并非数据中心或AI专属订单。",
        "transmission": "订单变化可补充观察网络设备和基础设施需求环境；需与公司订单余额、云厂商资本开支和项目级建设数据交叉验证。",
        "proxy_targets": ["servers", "data_centers", "overall"],
    },
)


def month_end(source_date: str) -> str:
    """Convert FRED's monthly first-of-month stamp to an observation period end."""
    year, month, _ = map(int, source_date.split("-"))
    return f"{year:04}-{month:02}-{calendar.monthrange(year, month)[1]:02}"


def parse_fred_monthly(raw: bytes) -> list[dict]:
    """Parse a FRED graph CSV without manufacturing missing months or values."""
    values = parse_csv(raw)
    return [
        {
            "sourceDate": row["date"],
            "periodEnd": month_end(row["date"]),
            "value": row["value"],
        }
        for row in values
        if row["date"] <= date.today().isoformat()
    ]


def proxy_definition(spec: dict) -> dict:
    url = FRED_GRAPH + spec["code"]
    metric = definition(
        spec["id"],
        spec["name"],
        spec["name_en"],
        spec["category"],
        spec["family"],
        "美国",
        "U.S. Census Bureau via FRED",
        url,
        spec["unit"],
        "proxy",
        spec["methodology"],
        True,
        "monthly",
        True,
    )
    metric.update(
        {
            "sourceAdapter": "infrastructure",
            "directness": "sector_proxy",
            "dataRole": spec["data_role"],
            "proxyTargets": spec["proxy_targets"],
            "interpretation": spec["interpretation"],
            "transmission": spec["transmission"],
            "crossCheck": "项目级官方状态与披露MW、EIA机组/电力负荷、公司资本开支、设备订单和实际收入。",
            "normalUpdateDelayDays": 45,
            "seasonalAdjustment": spec["seasonal_adjustment"],
            # Construction spending is a monthly rate, while M3 new orders are
            # period flows.  Preserve that distinction for any downstream
            # aggregation instead of applying the definition helper's generic
            # monthly mean to both series.
            "aggregation": spec["aggregation"],
            "licenseNote": "仅保存计算所需观测、来源链接、抓取时间和版本哈希；FRED页面与Census原始口径均保留可追溯链接。",
            "sourceReleaseUrl": spec["source_release_url"],
        }
    )
    return metric


def cached_series(previous: dict | None, error: str) -> dict:
    prior = previous or {"observations": []}
    observations = prior.get("observations", [])
    return {
        **prior,
        "observations": observations,
        "status": "cached" if observations else "fetch_failed",
        "checkedAt": now(),
        "error": error,
        "note": "本次来源检查未取得有效数据，保留最近成功观测；不会补零或插值。",
    }


def build(*, force: bool = False) -> dict:
    path = DATA / "infrastructure.json"
    old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"series": {}}
    result = {
        "schemaVersion": "1",
        "generatedAt": now(),
        "definitions": [],
        "series": {},
        "projects": [],
        "events": [],
        "sources": [],
    }
    for spec in SERIES:
        metric = proxy_definition(spec)
        metric_id = metric["id"]
        url = FRED_GRAPH + spec["code"]
        result["definitions"].append(metric)
        try:
            raw, stamp, version = fetch(url, force=force)
            rows = parse_fred_monthly(raw)
            if len(rows) < 13:
                raise ValueError("FRED历史长度少于13个月，无法计算同比基期")
            observations = [
                observation(
                    metric_id,
                    row["periodEnd"],
                    row["value"],
                    url,
                    stamp,
                    version,
                    start=f"{row['periodEnd'][:7]}-01",
                    formula="原始FRED月初日期映射为同一自然月月末；不重采样、不插值",
                    items={
                        "source_series": spec["code"],
                        "source_observation_date": row["sourceDate"],
                        "seasonal_adjustment": spec["seasonal_adjustment"],
                        "directness": "sector_proxy",
                    },
                )
                for row in rows
            ]
            result["series"][metric_id] = {
                "observations": observations,
                "status": "ready",
                "fetchedAt": stamp,
                "lastSuccessfulAt": stamp,
                "checkedAt": now(),
                "error": None,
                "note": "官方宽口径行业代理；不等同于AI专属订单、数据中心项目容量或投运进度。",
            }
            result["sources"].append(
                {
                    "id": spec["code"],
                    "name": f"FRED / Census · {spec['name']}",
                    "url": url,
                    "status": "ready",
                    "fetchedAt": stamp,
                    "checkedAt": now(),
                    "note": f"{spec['unit']}；可能修订；不是AI专属指标。",
                }
            )
        except Exception as exc:
            error = str(exc)
            result["series"][metric_id] = cached_series(old.get("series", {}).get(metric_id), error)
            result["sources"].append(
                {
                    "id": spec["code"],
                    "name": f"FRED / Census · {spec['name']}",
                    "url": url,
                    "status": result["series"][metric_id]["status"],
                    "checkedAt": now(),
                    "error": error,
                    "note": "读取失败时保留上一成功版本。",
                }
            )
    persist(result, path)
    return result


if __name__ == "__main__":
    # The scheduler uses --force for its lightweight release/revision probe.
    # fetch() still writes the raw response atomically and the same collector
    # preserves the last successful observations if the source is unavailable.
    payload = build(force="--force" in sys.argv)
    ready = sum(series.get("status") == "ready" for series in payload["series"].values())
    print(json.dumps({"series": len(payload["series"]), "ready": ready}, ensure_ascii=False))
