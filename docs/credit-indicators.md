# 企业信贷与通胀补偿指标

本次补充三个图表：银行企业贷款标准（大中型/小型企业对比）、十年期盈亏平衡通胀率、企业信用风险偏好 EBP。它们进入融资环境、指标检索和站内提醒；本次不更改投资结论的评分权重。

| 指标 | 来源和单位 | 观察含义 | 更新方式 |
|---|---|---|---|
| DRTSCILM、DRTSCIS | 美联储 SLOOS，经 FRED；季度，% | 收紧贷款标准的银行占比减去放松占比；正数表示净收紧 | 官方 FRED 发布日历 191，保留日期精度；平日每天检查，发布日/等待新季度时每6小时，失败30分钟重试 |
| T10YIE | 圣路易斯联储，经 FRED；日度，% | 同日十年期名义收益率减实际收益率；包含通胀风险和流动性补偿 | 沿用利差日历304的每小时检查，失败15分钟重试 |
| EBP | 美联储 FEDS Notes 官方 CSV 的 ebp 列；月度，百分点 | 扣除模型估计的预期违约风险补偿之后，企业债市场要求的额外补偿 | 月初1–10日每6小时，其余每日检查；失败30分钟重试，无虚构精确发布时间 |

SLOOS 的季度是调查所属季度。比如 2026年11月2日公布的调查，FRED标识为2026-10-01（Q4），而不是把该日期理解为10月1日已经公布。实际来源发布时间未知时保持空值。EBP 是研究估计，不是正式统计公报；官网说明通常在每月第4个工作日上午10点以后发布，并可能因FOMC静默期或上游数据推迟。

同时新增 DHHNGSP Henry Hub 天然气现货日价图，保留原 NATGAS_US 月度均价。官方日历为342，日度观测通常按周集中更新，日期没有时刻。每6小时检查，失败30分钟重试，不拼接为月度数据、不插值。

## 来源与展示许可

- [SLOOS 官方说明](https://www.federalreserve.gov/data/sloos.htm)、[大中型企业](https://fred.stlouisfed.org/series/DRTSCILM)、[小型企业](https://fred.stlouisfed.org/series/DRTSCIS)：Public Domain: Citation Requested，注明美联储并注明经FRED取得。
- [T10YIE](https://fred.stlouisfed.org/series/T10YIE)：Copyrighted: Citation Required。保留圣路易斯联储署名、来源链接和FRED取得说明。[FRED条款](https://fred.stlouisfed.org/legal/)说明此类指标的引用要求。
- [EBP 研究说明](https://www.federalreserve.gov/econres/notes/feds-notes/updating-the-recession-risk-and-the-excess-bond-premium-20161006.html)、[官方 CSV](https://www.federalreserve.gov/econres/notes/feds-notes/ebp_csv.csv)：使用美联储公布的研究结果，不获取底层商业债券数据，也不用 ICE 指数代替。[美联储网站条款](https://www.federalreserve.gov/disclaimer.htm)说明未单独标注的资料为公有，须注明来源。保留完整研究引用：Favara, Gilchrist, Lewis and Zakrajšek (2016), FEDS Notes, DOI 10.17016/2380-7172.1836。
- [DHHNGSP](https://fred.stlouisfed.org/series/DHHNGSP)：Public Domain: Citation Requested，注明EIA及FRED。

## 数据与状态

沿用SQLite观测修订账本、原始文件SHA-256归档及JSON展示缓存。首次获取失败为 `fetch_failed`；已有历史时保留最后成功数据和成功时间并标记 `cached`；没有配置的数据依旧由前端标为未配置。SLOOS已到官方公布日期、源数据尚未推进到对应调查季度时标记 `awaiting_source`。未知未来发布时间不推断为已逾期。EBP全历史可能修订，修订保留旧值，不覆盖为“当时已知”的值。

EBP 使用Python进程内HTTP请求，不启动curl或额外命令窗口。其余数据沿用现有隐藏后台采集。GitHub Actions为尽力调度，以上间隔为检查目标。

## 2026-11-10 样点核验

完整原始文件在本地 `outputs/credit-nov10/source/`，可复核摘要在 `tests/fixtures/credit-source-samples.json`（原始文件哈希、历史起止、样点及源链接）。

| 指标 | 历史起点 | 中间样点 | 最新样点 |
|---|---|---|---|
| DRTSCILM | 1990-04-01：54.4% | 2020-04-01：41.5% | 2026-10-01：1.7% |
| DRTSCIS | 1990-04-01：52.7% | 2020-04-01：39.7% | 2026-10-01：5.1% |
| T10YIE | 2003-01-02：1.64% | 2020-04-01：0.91% | 2026-11-09：2.22% |
| EBP | 1973-01-01：-0.0476586827百分点 | 2020-04-01：0.6550285810百分点 | 2026-10-01：-0.2653311478百分点 |

验证覆盖：源列选择、缺失值/零值、无效结构、季度日期口径、日期精度日历、失败缓存、历史修订、源回退保护、源链接及单位。运行 `python tests/credit_conditions_test.py` 和 `node --test tests/credit-indicators.test.mjs`。
