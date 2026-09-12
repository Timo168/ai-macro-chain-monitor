# AI 产业链宏观观察台：数据源核验

核验日期：2026-09-11。已逐项浏览官方系列页面，并实际下载 15 个 FRED 原始 CSV、世界银行月度 XLSX。下表是本次获取的最新修订口径，不是历史时点可知数据；网页运行后必须用成功获取时间更新状态。

## 可立即使用的接入路径

- FRED 公开图表 CSV：`https://fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES_ID`。本次全部 15 个系列成功下载，无密钥。响应首行为 `observation_date,SERIES_ID`。这是公开下载入口，不是承诺稳定的正式 API；后台缓存、低频访问、有限重试，适配器需可切换。日频缺失值为空，不可转成零。
- 正式 FRED API：`https://api.stlouisfed.org/fred/series/observations?series_id=SERIES_ID&api_key=SERVER_KEY&file_type=json`。无 key 本次返回 HTTP 400，文档也明确 key 必需。服务端配置 `FRED_API_KEY`，不要在浏览器访问带 key 的地址。[观测值 API](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)
- 元数据：`fred/series` 返回单位、频率、季调、历史起止、最近更新等。[元数据 API](https://fred.stlouisfed.org/docs/api/fred/series.html)
- 世界银行：先从[商品数据主页](https://www.worldbank.org/en/research/commodity-markets)发现 Monthly prices 链接，不能永久假设 URL 文档编号不变。本次真实地址为 [CMO-Historical-Data-Monthly.xlsx](https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx)，HTTP 200，586735 字节。
- Windows 本次 `curl.exe` 成功而 `Invoke-WebRequest` 对 FRED CSV 超时；仅此环境差异不代表数据源不可用。
- 已下载原文件目录：`C:\Users\Rachel\AppData\Local\Temp\ai-macro-audit\`。文件名为 FRED ID 加 `.csv` 和 `pink-sheet-monthly.xlsx`。可作本次真实历史导入输入，但存入正式缓存时保留真实下载时间，不能声称是网站后台已自动同步。

## FRED 配置核验与三点抽样

日期使用原始观测日期；月频的每月 1 日表示该月，不是发布日期。三点来自完整原始 CSV 首部、中部、末部，末点也与官方系列网页核对。

| ID / 定义 | 频率、原始单位、季调 | 首点 | 中部点 | 末点 |
|---|---|---|---|---|
| [ICSA 初请人数](https://fred.stlouisfed.org/series/ICSA) | 周六结束周；人；SA | 1967-01-07：208000 | 1996-11-09：327000 | 2026-09-05：206000 |
| [UNRATE U-3 失业率](https://fred.stlouisfed.org/series/UNRATE) | 月；%；SA | 1948-01-01：3.4 | 1987-05-01：6.3 | 2026-08-01：4.1 |
| [PAYEMS 非农就业总量](https://fred.stlouisfed.org/series/PAYEMS) | 月；千人；SA | 1939-01-01：29923 | 1982-11-01：88786 | 2026-08-01：159075 |
| [CPIAUCNS 总体 CPI](https://fred.stlouisfed.org/series/CPIAUCNS) | 月；1982–1984=100；NSA | 1913-01-01：9.800 | 1969-10-01：37.300 | 2026-07-01：333.918 |
| [CPILFENS 核心 CPI](https://fred.stlouisfed.org/series/CPILFENS) | 月；1982–1984=100；NSA | 1957-01-01：28.500 | 1991-10-01：143.900 | 2026-07-01：337.133 |
| [CPIAUCSL 总体 CPI](https://fred.stlouisfed.org/series/CPIAUCSL) | 月；1982–1984=100；SA | 1947-01-01：21.480 | 1986-10-01：110.200 | 2026-07-01：332.813 |
| [CPILFESL 核心 CPI](https://fred.stlouisfed.org/series/CPILFESL) | 月；1982–1984=100；SA | 1957-01-01：28.500 | 1991-10-01：143.700 | 2026-07-01：336.789 |
| [PCEPI 总体 PCE](https://fred.stlouisfed.org/series/PCEPI) | 月；2017=100；SA | 1959-01-01：15.164 | 1992-11-01：64.064 | 2026-07-01：131.659 |
| [PCEPILFE 核心 PCE](https://fred.stlouisfed.org/series/PCEPILFE) | 月；2017=100；SA | 1959-01-01：15.501 | 1992-11-01：65.121 | 2026-07-01：130.658 |
| [DFEDTARL 目标下限](https://fred.stlouisfed.org/series/DFEDTARL) | 日，含周末；%；NSA | 2008-12-16：0.00 | 2017-10-29：1.00 | 2026-09-10：3.50 |
| [DFEDTARU 目标上限](https://fred.stlouisfed.org/series/DFEDTARU) | 日，含周末；%；NSA | 2008-12-16：0.25 | 2017-10-29：1.25 | 2026-09-10：3.75 |
| [DGS10 十年期名义收益率](https://fred.stlouisfed.org/series/DGS10) | 日；%；NSA | 1962-01-02：4.06 | 1994-05-25：7.14 | 2026-09-09：4.83 |
| [DFII10 十年期实际收益率](https://fred.stlouisfed.org/series/DFII10) | 日；%；NSA | 2003-01-02：2.43 | 2014-11-03：0.43 | 2026-09-09：2.46 |
| [NFCI 金融条件](https://fred.stlouisfed.org/series/NFCI) | 周五结束周；指数；NSA | 1971-01-08：0.600 | 1998-11-06：-0.021 | 2026-09-04：-0.564 |
| [DCOILBRENTEU 布伦特欧洲现货](https://fred.stlouisfed.org/series/DCOILBRENTEU) | 日；美元/桶；NSA | 1987-05-20：18.63 | 2006-12-14：62.85 | 2026-09-09：109.51 |

上述 15 个系列中，NFCI 标签为 Copyrighted: Citation Required，其他 14 个为 Public Domain: Citation Requested。请保留原数据生产机构名称，FRED 是分发平台。布伦特来源 EIA；就业/CPI 来源 BLS（初请为 ETA）；PCE 来源 BEA；利率来源美联储。

## 世界银行解析与商品口径

不要读取第一张表。本次文件第一张为 `Mismatch Details`；正确数据在 `Monthly Prices`。解析按工作表名、列标题和 `YYYYMmm` 日期匹配，不依赖固定列号。当前布局：第 5 行标题、第 6 行单位、第 7 行开始数据，共 800 个月，1960M01–2026M08；A4 标注 `Updated on September 02, 2026`。

| 商品 | 当前列 / 单位 | 1960M01（第 7 行） | 1993M05（第 407 行） | 2026M08（第 806 行） |
|---|---|---:|---:|---:|
| Copper | 第 65 列；美元/公吨 | 715 | 1795 | 14326 |
| Gold | 第 70 列；美元/金衡盎司 | 35 | 367 | 4411 |
| Silver | 第 72 列；美元/金衡盎司 | 0.9 | 4.5 | 65.4 |
| Crude oil, Brent（比较可用） | 第 3 列；美元/桶 | 1.6 | 18.5 | 90.9 |

工作簿 `Description`：铜是 LME Grade A 结算价；黄金从 2025-06 起为现货日价格均值，此前为伦敦下午定盘价的日均值；白银说明为英国 99.9% 精炼银伦敦下午定盘价，1976-07 以前采用 Handy & Harman，1962 年前为未精炼银。月均价的来源历史会变化，不可标成实时 LBMA 行情。

比较方案：将 EIA/FRED 布伦特日频有效观测聚合成完整自然月均值，与三种商品以共同月份交集对齐，再用同一首月各自价格计算起点 100。或者明确选择 WB 布伦特月度序列，注明基准切换。缺月留空；正在进行的月份若没有各商品数据，不加入共同比较。原价独立轴/独立图。

主页指向[世界银行数据使用摘要](https://data.worldbank.org/summary-terms-of-use)及[数据许可](https://datacatalog.worldbank.org/public-licenses)：默认 CC BY 4.0，可复制、改编、分发，包括商业用途，但应署名、标明修改，并遵守个别数据/第三方另列条件。工作簿 `Description` 列出 Bloomberg、Platts、Reuters、LBMA 等历史提供者；保留这些来源说明。该公开月度编制数据的默认使用条款不能替代实时/日频原始基准服务的授权。

NFCI 导出建议默认关闭，提示先核验目标用途：Chicago Fed 的[法律声明](https://www.chicagofed.org/utilities/legal-notices)对非商业且署名的自有文字材料给出有限许可，并要求其他再分发/商业用途另取许可；不要把 NFCI 标成无条件公共领域。图表保留出处和链接，生产商业化前进一步确认适用范围。

## 固定计算规则

1. CPI 同比仅使用 NSA 的 CPIAUCNS / CPILFENS；环比使用 SA 的 CPIAUCSL / CPILFESL。PCE 同比/环比均来自 SA 指数，并显示该口径。同比 = `(x[t] / x[同月上一年] - 1) * 100`，环比 = `(x[t] / x[上一月] - 1) * 100`；必须按日期找基期，不能有缺月时简单取前 12 行。取数多留至少 12 个月。
2. 非农增量 = 相邻自然月 PAYEMS 差，单位仍为千人；若显示万人，除以 10。三个月均值是三个连续月增量的平均，需要四个月原始总量。
3. 初请四周均值是四个连续的周六观测值平均，日期相隔 7 天；缺一个周则该窗口为空，不能压缩窗口。
4. 利率、通胀率、失业率相减是百分点；百分点乘 100 为基点。商品涨跌幅为百分比。NFCI 差值为指数点，不能算负值指数的百分比涨跌。
5. 选区间变化基于所选范围内首末有效点，同时显示实际比较日期；显示历史区间时不要把全序列最新值误叫成区间末值。组合线各自可用日期可能不同，应逐线标明。
6. 美联储 2% 长期目标对应总体 PCE 年度变化；核心 PCE 只作趋势参考，不给核心线标“美联储目标”。[美联储说明](https://www.federalreserve.gov/faqs/economy_14400.htm)
7. NFCI 水平（相对零）与方向（相对上周/四周前）分别呈现；负值上升可以同时意味着“低于历史平均紧度”和“最近收紧”。[NFCI 定义](https://fred.stlouisfed.org/series/NFCI)

## 更新日历与时区

| 来源 | 官方入口 | 后台实现注意 |
|---|---|---|
| BLS 就业/CPI | [就业日历](https://www.bls.gov/schedule/news_release/empsit.htm)、[CPI 日历](https://www.bls.gov/schedule/news_release/cpi.htm)、[可订阅 ICS](https://www.bls.gov/schedule/news_release/bls.ics) | ICS 更新后按具体日期调度，通常 08:30 美国东部时间，不能永久写死每月第一个周五。 |
| BEA PCE | [BEA 发布日程](https://www.bea.gov/news/schedule) | Personal Income and Outlays 条目，读取具体日期及时间。 |
| 初请 | [ETA 发布档案](https://oui.doleta.gov/unemploy/claims_arch.asp)、[FRED ICSA 下次发布日期](https://fred.stlouisfed.org/series/ICSA) | 周频按官方日历；节假日变化需处理。 |
| NFCI | [Chicago Fed 发布说明](https://www.chicagofed.org/research/data/nfci/current-data) | 通常周三 08:30 ET，覆盖前周五；若周三或当周此前有联邦假日，则周四更新。历史值也可能修订。 |
| 利率 | [FOMC 日历](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm)、[H.15](https://www.federalreserve.gov/releases/h15/) | 目标区间每个自然日生效值；收益率日频有非交易日缺失。 |
| 商品 | [EIA/FRED 布伦特](https://fred.stlouisfed.org/series/DCOILBRENTEU)、[WB 商品主页](https://www.worldbank.org/en/research/commodity-markets) | WB 本次主页明确下一次 2026-10-02；按主页新文件/发布日期检查，不把月频数天不变判为失败。 |

FRED 的 [series/release](https://fred.stlouisfed.org/docs/api/fred/series_release.html) 可建立系列与 release ID 对应，[releases/dates](https://fred.stlouisfed.org/docs/api/fred/releases_dates.html) 查发布日期。官方明确：源数据发布日期不保证该时刻已在 FRED 可用。因此发布后应做有上限的指数退避重试。不可伪装成已满足日历的固定每日刷新。

调度按 IANA `America/New_York`（官方 ET）和需要时 `America/Chicago`（FRED 页面时间）解释，UTC 保存，`Asia/Shanghai` 展示。北京时间不可固定只加 12 小时：夏令时和标准时不同。观测日期用 date-only 保留经济含义；抓取时间使用真实 UTC 时间戳。

## 历史修订、状态与尚未完成事项

- 公共 CSV 是目前最新修订版本，不提供过去每次 vintage。今后每次下载应保存原文件哈希、抓取时间、来源更新时间（如可得）和发生改变的观测值；未变不重复插入修订。
- 初次导入旧年月观测时，`knownAt` 只能是本次首次获取时间，不能假造当年的原始发布值。完整旧 vintage 回填需[ALFRED/FRED vintagedates](https://fred.stlouisfed.org/docs/api/fred/series_vintagedates.html)及 observations 的 realtime 参数；当前没有 API key，未验证该回填实际请求。
- 原始数据应分别保存 observationDate、sourcePublishedAt（可能为空）、fetchedAt、sourceLastUpdatedAt、revision/hash。FRED 系列 last_updated 是系列更新，不能当作每个观测首次发布日期。
- 上次成功数据仍可展示；本次抓取失败独立保存 error 和 failedAt。UI 区分尚未发布、获取失败且展示缓存、尚未配置、已有最新数据。没有真实数据时展示未接入，开发占位必须显著写“演示数据”。
- 本核验提供真实原文件和原始点样本，不代表网站采集任务、转换函数、图表或无人值守同步已完成；正式验收还需对实现后的每组图表抽查三点及单位。
- 无密钥历史 CSV/WB 文件均已可接入；待配置的主要是正式 FRED API key、长期运行的后台调度环境、过去所有 vintage 回填，以及 NFCI 目标商业/导出用途确认。
- 不接入已删除的旧金银 FRED 日频代码。[FRED 2022 删除公告](https://news.research.stlouisfed.org/2022/01/ice-benchmark-administration-ltd-iba-data-to-be-removed-from-fred/)明确已从 API 等移除；[IBA 基准许可](https://www.ice.com/iba/lbma-precious-metals)要求用途授权。

## 机器可读日历实测补充

本节是 2026-09-11 的真实下载结果。BLS/美联储的拦截应保留状态，不能用一个虚构的未来固定日历替换成“已接入”。

### BEA：推荐直接接入 JSON

- 官方 JSON：`https://apps.bea.gov/API/signup/release_dates.json`，HTTP 200，9053 字节，无 key。来源链接在 [BEA 订阅页面](https://www.bea.gov/news/schedule/icalendar)。读取 `payload["Personal Income and Outlays"].release_dates`；条目为带 UTC 偏移的 ISO 时间，`file_last_updated` 是日历文件更新时间。
- 本次下一条 PCE 发布时间：`2026-09-30T12:30:00+00:00`，即北京时间 2026-09-30 20:30。直接按条目时间排程，不要重新套用固定 08:30。
- 官方 ICS：`https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics`，HTTP 200，31131 字节。顶层 TZID 为 America/New_York，但 DTSTART 样本使用 `Z`（UTC）；按 DTSTART 实际参数解析。SUMMARY 含观测期，比 JSON 的主题级列表更丰富。ICS 长行可能折行，解析时先展开 CRLF 后的单空格/制表符。

### BLS：官方 ICS 存在，当前程序请求被拒

- 精确地址：`https://www.bls.gov/schedule/news_release/bls.ics`，在[官方 CPI 日历页面](https://www.bls.gov/schedule/news_release/cpi.htm)明确给出。本次 curl HTTP 403，410 字节 Access Denied HTML，不能当 ICS 入库。
- 就业和 CPI 的官方 HTML 仍能通过本次 web 浏览读取，但程序下载可用性不可等同于 web 工具。生产端可先测试 ICS，失败使用下述 FRED 官方发布日历；两者都失败时保留上次日历并标明失败。

### FRED：有 key 用 API；无 key 可解析官方 HTML

单个 release 的正式 API 模板：

```text
https://api.stlouisfed.org/fred/release/dates?release_id=10&api_key=SERVER_KEY&file_type=json&include_release_dates_with_no_data=true&sort_order=asc
```

`include_release_dates_with_no_data=true` 必须开启，否则未来尚无观测数据的发布日期被默认过滤。读取 `release_dates[].date`，它仅有日期，不能冒充精确时间。[官方 API 文档](https://fred.stlouisfed.org/docs/api/fred/release_dates.html) 已核验；无有效 key 不声称已做成功请求。API 分页按 count/offset。

无 key 的官方 HTML 精确模板：`https://fred.stlouisfed.org/releases/calendar?rid=10&y=2026`。本次 curl HTTP 200，72073 字节。页面有日期、时间与标题；底部明确所有时间为 US Central Time，须用 America/Chicago 处理夏令时。只解析发布表格而非整个网页上的随机日期。分页每页 50 条，跟随 Next 链接，示例：`https://fred.stlouisfed.org/releases/calendar?pageID=2&rid=180&ve=2026-12-31&vs=2026-01-01&y=2026`。当年与次年日历可分别缓存并每日检查。

已由系列页面“下次发布”链接核实的 release ID：

| release ID | 内容 | 关键说明 |
|---|---|---|
| [10](https://fred.stlouisfed.org/releases/calendar?rid=10&y=2026) | CPI | 页面 07:30 CT，即通常 08:30 ET。 |
| [50](https://fred.stlouisfed.org/release?rid=50) | Employment Situation | UNRATE、PAYEMS。 |
| [54](https://fred.stlouisfed.org/release?rid=54) | Personal Income and Outlays | PCE；优先 BEA JSON。 |
| [180](https://fred.stlouisfed.org/releases/calendar?rid=180&y=2026) | 初请周报 | 2026-11-25 为周三，证明不能写死每周四。 |
| [221](https://fred.stlouisfed.org/releases/calendar?rid=221&y=2026) | NFCI | 节假日顺延已列在日历，例如 2026-09-10 周四。 |
| [18](https://fred.stlouisfed.org/releases/calendar?rid=18&y=2026) | H.15 收益率 | 日历显示 15:15 CT，交易日/假日差异按日历。 |
| [212](https://fred.stlouisfed.org/releases/calendar?rid=212&y=2026) | EIA Spot Prices | 数据是日频，但本次发布日历按周批次列出（12:00 CT）；不可把“数据日频”自动等同“每天即时发布”。 |
| [101](https://fred.stlouisfed.org/releases/calendar?rid=101&y=2026) | FOMC Press Release | 该 FRED 日历实际上有 365 个自然日的区间利率更新，**不是 FOMC 八次会议日历**。 |

### 美联储

- 权威会议日历：`https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm`；本次 web 成功读取，Windows curl 因系统证书撤销检查联网失败而未下载成功，没有关闭 TLS 校验。可用正常验证 TLS 的服务端请求进一步测试并解析年度会议块。
- `https://www.federalreserve.gov/json/calendar.json` 本次 Python urllib 返回 HTTP 403，因此不列为可用自动更新接口，也不依赖第三方复制日历。没有核验成功的官方通用 FOMC ICS/JSON。
- 第一版利率实际数据仍能用 DFEDTARL/U 每日生效序列定时获取；会议事件标记必须以数值发生变更的生效日为准，若展示决策公布日需另外链接对应 FOMC 声明，二者不混淆。

## 已执行的独立日历解析样例

2026-09-11 11:15:58 UTC 执行完成，输出 `C:\Users\Rachel\AppData\Local\Temp\ai-macro-calendar.json`，研究脚本 `C:\Users\Rachel\AppData\Local\Temp\ai-macro-calendar-research.py`。只用了 Python 标准库 HTMLParser / zoneinfo 和 curl，没有安装依赖，没有修改网站代码。

FRED rid 10、50、54、180、221、18、212 全部成功获取并各提取未来 3 次事件（共 21 条）；通过 `vs=2026-09-11&ve=2027-09-12` 查询范围减少分页。每条保留源时区 America/Chicago、UTC、北京时间、日历链接及成功抓取时间。JSON 每个 release 的 `exampleHtml` 存实际日期行及事件行结构。BEA 官方 JSON 同时保留；三次 PCE 事件时间与 FRED 独立一致。所有事件均不早于提取时间。跨美国冬夏令时检查：CPI 2026-10-14 为北京 20:30，2026-11-10 为北京 21:30。

解析边界：`#release-dates-pager table`；`tr > td[colspan="2"]` 的第一个 span 是日期，下一 tr 的第一个 td 是时间、第二 td 的 `/release?rid=` 链接是名称。不能把日期行另一个 `Updated` span 混入日期。分页跟随文本含 Next 的链接并解码 `&amp;`。如果布局标记或 US Central Time 声明消失，研究解析器明确报错，而非悄悄返回空成功。
