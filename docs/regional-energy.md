# 区域电力：批发价与实际小时负荷

接入核验日期：2026-11-10。模块输出 `data/regional-energy.json`，空环境使用 `data/regional-energy.seed.json`，不依赖付费数据服务或 API 密钥。

## 本次接入范围

| 地区 | 指标 | 来源与口径 | 初次导入范围 | 状态 |
| --- | --- | --- | --- | --- |
| 美国中东部 PJM | PJM West 批发电价 | EIA 转刊 ICE `PJM WH Real Time Peak` 高峰电力交易量加权价格；美元/MWh；交易日 | 2023-12-27 至 2026-10-27，共 659 个交易日 | 已接入 |
| 得克萨斯 ERCOT | 实际小时负荷 | EIA-930 `ERCO` / `D` / `DATA_REPORTED`；MW；小时结束时刻 | 2026-08-12 11:00 UTC 至 2026-11-10 10:00 UTC，共 2,160 小时 | 已接入 |
| 美国中东部 PJM | 实际小时负荷 | EIA-930 `PJM` / `D` / `DATA_REPORTED`；MW；小时结束时刻 | 同上 | 已接入 |
| 得克萨斯 ERCOT | ERCOT North 批发电价 | EIA 当前年度电价文件未包含该枢纽 | 无 | `not_published`，明确展示缺口 |

PJM 是覆盖多个州的电网区域，PJM West 是交易枢纽。这里不把它们标作弗吉尼亚州的独立电价或独立负荷。EIA 当前文件没有 ERCOT 枢纽，与 ERCOT 直接接口拒绝请求是两件事：直接实时/日前 SPP 页面及市场页在本次接入检查返回 HTTP 403，`directSourceCheck` 单独保留日期、网址和错误；程序不绕过访问限制，也不把其他枢纽当作 Texas 数据。

## 官方依据及实际端点

- [EIA 批发电力市场数据及统计方法](https://www.eia.gov/electricity/wholesale/)：包括交易日、交付起止日期、高低价、成交量加权价。日度交易观测与文件更新频率分开记录；官网说明文件每两周更新。
- [2026 当前年度电价工作簿](https://www.eia.gov/electricity/wholesale/xls/ice_electric-2026.xlsx)、[2025 最终工作簿](https://www.eia.gov/electricity/wholesale/xls/archive/ice_electric-2025final.xlsx)、[2024 最终工作簿](https://www.eia.gov/electricity/wholesale/xls/archive/ice_electric-2024final.xlsx)。2024、2025、2026 文件均没有 ERCOT North 行。
- [EIA-930 官方定义、报告时间及可用性](https://www.eia.gov/electricity/930-content/about.html)：实际负荷通常在对应小时结束后一小时发布，数据可修订，原始报告、预测与填补值有不同字段。
- [EIA Hourly Electric Grid Monitor](https://www.eia.gov/electricity/gridmonitor/) 的公开同源 JSON 端点为 `https://www.eia.gov/electricity/930-api/region_data/series_data`。采用网页客户端的参数：`respondent[0]=ERCO/PJM&type[0]=D&frequency=hourly&timezone=UTC`；`start`、`end` 格式 `MMDDYYYY HH:MM:SS`。这是公开网页数据接口，不使用网页内嵌的 API 密钥；上游字段变更时校验失败并保留缓存。
- [EIA 版权及复用说明](https://www.eia.gov/about/copyrights_reuse.php)：EIA 自有公开政府数据可附来源复用，第三方授权内容另有权利边界。因此小时负荷允许附来源 CSV 导出，ICE 电价的 `exportAllowed=false`，提供原始来源链接。

## 后台采集与修订

```text
python scripts/regional_energy.py
python scripts/regional_energy.py --force
python tests/regional_energy_test.py
```

调用入口为 `regional_energy.collect(force=False)`，供主调度器调用。采集仅使用进程内 Python HTTP，不创建 curl 或命令窗口。

- 小时负荷每 60 分钟检查；首次拉取最近 90 天，此后重取近 7 天，每周重取 90 天以发现较晚修订。页面保留最近 366 天已获取的观测，历史修订账本持续保存。
- 批发电价每天检查当前年度文件，首次成功再导入前两个年度文件。历史文件失败单列 `archiveErrors`，不覆盖已取得的当前年度数据。已取得的最终历史文件不每次重下。
- 请求失败 15 分钟后允许重试；这是后台检查间隔，执行时间受主任务调度影响。
- 负荷最新有效点超过 6 小时、电价超过 21 天时设置 `freshness=delayed`。电价不因一周价格不变就误报异常；面板仍展示实际观测期与来源发布节奏。
- `observations[].date`：电价为交易日 `YYYY-MM-DD`；负荷为 UTC ISO 小时结束时间。负荷另存 `localDateTime`（含夏令时 UTC 偏移）、`timeZone` 与 `interval=hour_ending`。图上可以展示北京时间，原始时间不丢失。
- 只使用 `DATA_REPORTED`。预测 `DF`、网页调整后的 `DATA`、`DATA_IMPUTED` 不补入实际值；缺失保留 `null`，不填零。小时原始数值是该小时电量对应的平均功率，1 小时的 MWh 数值等于 MW，未缩放成 GW。
- `publishedAt` 无可靠来源时间时保留 `null`；不会用获取时间冒充官方发布时间。

原始响应按 SHA-256 保存到 `data/versions/regional-energy/raw/`，包含首次获取与最近获取元数据。`data/versions/regional-energy/observations.sqlite` 保存每个观测的首次见到版本及后续变更，包括改回旧值的修订。JSON 显示缓存原子替换。

## 状态边界

| 状态 | 含义 |
| --- | --- |
| `available` | 本次取得并校验了实际数据，时效另看 `freshness` |
| `cached` + `lastFetchStatus=fetch_failed` | 本次获取失败，继续展示最近成功值及原来的成功时间 |
| `fetch_failed` | 首次获取就失败，没有可用历史值 |
| `not_published` | 请求成功，但所需指标没有源观测，如 EIA 未提供 ERCOT North |
| `not_configured` | 空 seed，还没有运行来源采集 |

数据顶层为 `{schemaVersion,generatedAt,status,version,regions}`。地区含 `id,name,timeZone,series`；序列含 `id,name,kind,unit,frequency,sourceName,sourceUrl,dataUrl,methodology,publicationFrequency,exportAllowed,status,lastFetchStatus,checkedAt,fetchedAt,lastSuccessAt,latestObservationAt,version,observations`。每个点另存来源 URL、源文件版本、观测版本、获取时间、是否修订。

## 历史抽样与测试

`tests/fixtures/regional-energy-samples.json` 保存源响应摘取的事实数值、原始源 URL 与完整文件 SHA-256，每个已接入系列至少三个历史点：

| 系列 | 样点一 | 样点二 | 样点三 |
| --- | --- | --- | --- |
| PJM West 电价（美元/MWh） | 2024-06-03：45.77 | 2025-03-19：50.65 | 2026-10-27：63.91 |
| ERCO 实际负荷（MW） | 2026-08-12 11:00 UTC：61,033 | 2026-09-26 11:00 UTC：51,354 | 2026-11-10 10:00 UTC：42,360 |
| PJM 实际负荷（MW） | 2026-08-12 11:00 UTC：99,106 | 2026-09-26 11:00 UTC：74,545 | 2026-11-10 10:00 UTC：83,183 |

15 项离线测试通过：真实样点、源字段变化、逗号数值与混合日期、未来值、预测/填补隔离、负电价、重复冲突、夏令时重复小时、首轮失败、保留缓存、小时与日度检查节流、原值回归修订、双周电价时效及空 seed。

未完成接入：ERCOT 直接批发电价；需该公开端点可访问，或取得适合网站用途的替代数据许可后再启用。PJM West 当前是 EIA 定期发布的交易观测，不承诺分钟级实时电价。
