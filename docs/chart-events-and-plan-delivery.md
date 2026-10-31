# 图表事件与企业计划兑现

## 图表事件

`lib/observation-events.mjs` 只接受有 HTTPS 来源的真实发布日期：

- 宏观：`sourcePublishedAt`。字段为空时不以观测日期、抓取日期补齐。
- 央行：官方决议 `announcedAt` 或 `announcementDate`。原有政策横向对比图的决议标记保留，不重复叠加。
- 公司：`financialUpdates.release.publishedAt`、观测的 `publishedAt` / `filingDate`、已确认官方公告事件。
- 未来事件保留“日程”标识，不画作已经发生的标记。

图表按日、周或月的观测日期排列。若事件发生在两个观测日之间，标记定位到事件后第一个已有观测日，列表同时显示**事件真实日期和定位日期**。超出当前区间的事件仅在列表显示，不延长图线，不生成观测值。时间戳转换为北京时间；只有日期的公告保留来源日历日期。

界面默认关闭事件层，可展开来源列表；图上最多标最近 8 个落点。事件链接、获取时间、来源状态、版本可追溯。标记表示时间关联，不证明因果关系。

`useChartEventLayer`、`chartEventReferenceLines` 和 `ChartEvents` 可复用到宏观和公司图。根组件应使用 `ObserverProvider` 提供共享输入；公司图可传自己的 `industry` 数据以保持版本一致。

## 企业计划兑现

`lib/industry/plan-delivery-reviewed.json` 保存人工核验的官方事实样本，核验时间为 **2026-10-31**。这里不是自动生成的公司指引，更不是收益承诺。

首批样本：

| 公司 / 期间 | 较早已核验计划 | 最后已核验修订 | 实际 | 状态 |
| --- | --- | --- | --- | --- |
| META 2024 | 300–370 亿美元 | 380–400 亿美元 | 392.30 亿美元 | 完整期间可对照 |
| META 2025 | 600–650 亿美元 | 700–720 亿美元 | 722.20 亿美元 | 完整期间可对照 |
| META 2026 | 1,150–1,350 亿美元 | 1,350–1,450 亿美元 | 年度值未发布 | 期限未满；Q3 单季 349.10 亿美元单独展示 |

所有样本的口径均为**固定资产购置及融资租赁本金支付合计**。当前站内的 `META.capex` 是现金购置单项，不能直接替代该合计口径。表内实际值取官方财报直接披露的合计；收入仅作为经营背景，不能证明该年投入带来的回报。每个事实包含来源链接、官方公布日期和版本标识。已录入较早和最后核验的计划节点，不声称是完整修订史。

`evaluatePlanDelivery` 要求同主体、同币种、同单位、同口径、同起止期间；计划必须早于实际披露，且不能将期后计划回填为事前计划。估算、不同口径、未完整披露、期限未满均不计算兑现率。比较结果用“高于 / 低于 / 落在指引区间”表达，不将支出增加当作投资回报。

其余已接入实际资本开支的企业显示“指引待匹配”，并可跳转已有实际数据。来源失败时保留标明人工核验的快照；发现晚于核验日的新财报时，未完结计划显示“指引待再次核验”。新增样本应通过官方公告核对后追加，不能由语言模型猜测。

官方材料：

- [2024 计划（2024-02-01）](https://investor.atmeta.com/investor-news/press-release-details/2024/Meta-Reports-Fourth-Quarter-and-Full-Year-2023-Results-Initiates-Quarterly-Dividend/default.aspx)
- [2024 修订（2024-10-30）](https://investor.atmeta.com/investor-news/press-release-details/2024/Meta-Reports-Third-Quarter-2024-Results/default.aspx)
- [2024 实际与 2025 计划（2025-01-29）](https://investor.atmeta.com/investor-news/press-release-details/2025/Meta-Reports-Fourth-Quarter-and-Full-Year-2024-Results/)
- [2025 修订（2025-10-29）](https://investor.atmeta.com/investor-news/press-release-details/2025/Meta-Reports-Third-Quarter-2025-Results/)
- [2025 实际与 2026 计划（2026-01-28）](https://investor.atmeta.com/investor-news/press-release-details/2026/Meta-Reports-Fourth-Quarter-and-Full-Year-2025-Results/)
- [2026 修订及 Q3 实际（2026-10-21）](https://investor.atmeta.com/investor-news/press-release-details/2026/Meta-Reports-Third-Quarter-2026-Results/)

## 验证

```text
node --test --test-isolation=none tests/observation-events.test.mjs tests/plan-delivery.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

覆盖日期与时区、缺失日期不伪造、同财报去重、区间定位、未来日程、事前计划、同口径限制、未届满状态、缓存与待复核边界。生产构建和浏览器验收由整体集成时统一执行。
