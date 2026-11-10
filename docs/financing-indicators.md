# 两年期美债、长短期利差和广义美元指数

本轮在“融资环境”加入三组官方历史序列。沿用后台采集、SQLite 修订记录、原始文件归档和 JSON 展示缓存；网页读取缓存即可。

| 展示指标 | 官方序列 | 单位与历史起点 | 发布与检查 |
| --- | --- | --- | --- |
| 美国两年期国债收益率 | [FRED DGS2](https://fred.stlouisfed.org/series/DGS2)；美联储 H.15 | 年化 %；1976-06-01 | FRED 发布日历 18；按前一美国营业日检查观测是否到齐 |
| 美债长短期利差（10年－2年） | [FRED T10Y2Y](https://fred.stlouisfed.org/series/T10Y2Y)；圣路易斯联储 | 个百分点；1976-06-01 | 官方日历 304 仅给日期，后台每小时检查；失败后每15分钟重试，不生成虚构的发布时间 |
| 广义美元指数 | [FRED DTWEXBGS](https://fred.stlouisfed.org/series/DTWEXBGS)；美联储 H.10 | 2006年1月=100；2006-01-02 | 日度观测、每周发布；按日历 17 检查，等待前一工作周最后营业日的观测 |

美联储 [H.10 说明](https://www.federalreserve.gov/releases/h10/)：通常周一美东时间16:15发布上一工作周数据，联邦假日顺延。网页显示北京时间。观测频率与发布频率分开处理，不因周中没有新数据就标记来源延迟。

T10Y2Y 使用 FRED 的官方计算结果。自2019-06-21起，FRED 使用美国财政部同日 BC_10YEAR 与 BC_2YEAR 计算。图表采用零值参考线；数值和变化量都按百分点表达。广义美元指数显示指数水平，较上期和区间变化按百分比表达。

三个指标均可搜索、收藏、记笔记、折叠、缩放和导出所选区间 CSV。CSV 与数据详情保留来源、抓取时间和修订版本。宏观研究上下文自动识别新增序列，利差使用百分点变化；本轮未改变行业评分权重。

## 数据状态

- 获取成功：保存来源原始观测和本次获取时间；来源未提供精确发布时间时保持为空。
- 首次获取失败：`fetch_failed`，没有数值，也没有成功获取时间。
- 获取失败但存在历史：`cached`，保留最后成功观测、获取时间和修订版本。
- 计划发布之后尚未更新：`awaiting_source`，按有界退避重试；超过窗口才显示来源延迟。
- 尚未配置或尚无已发布观测：由统一状态组件分别显示，缺值保持为空。

## 验证

2026-11-10 获取官方完整 CSV，各抽查起点、中段、最新三个历史点。证据保存在 `tests/fixtures/financing-fred-samples.json`，含来源 URL、完整原文件 SHA-256、观测范围及抽样值。另核对三组共同交易日上的“十年期－两年期＝利差”。T10Y2Y 可能先于 H.15 更新到新的交易日，因此只在共同交易日核对，不错配日期。

执行回归检查：

```powershell
node --test tests/financing-indicators.test.mjs
py -3 -m unittest discover -s tests -p financing_sources_test.py
py -3 -m unittest discover -s tests -p macro_schedule_test.py
```

采集继续使用现有隐藏窗口封装：Windows 子进程带 `CREATE_NO_WINDOW`、隐藏启动信息；没有新增桌面命令窗口或额外常驻进程。
