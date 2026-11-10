# 公司对比

选择指标和公司后，先看“同季度对比”，再看历史趋势。

- 同季度对比默认定位到所选公司都有数值的最近一个季度，也可切换到其他季度。条形和数值按高低排列，始终显示当前季度；缺失项保留空态。
- 公司使用固定颜色，选择标签、条形、趋势和悬停说明保持对应。中文名称与股票代码同时显示。
- 历史趋势可切换柱状或折线。原始值看规模，同比、环比看变化，起点 100 看相对走势。
- 时间窗口对全部公司统一裁剪；缺失季度留空，不补零，也不使用前后季度替代。
- “数据覆盖”说明缺少哪些季度。来源明细按需展开，显示实际报告期间、财季和该期原文链接。

图表按报告期末所在的自然季度归组。不同公司的财季日期可能不同，实际日期在同季度对比和悬停说明中保留。一个公司同一指标采用一个明确口径，不把重复占位指标或不同业务范围的数据拼在一起。

## 验证命令

```text
node --test tests/company-comparison.test.mjs
python tests/amazon_history_test.py
python tests/industry_collector_test.py
python tests/financial_schedule_test.py
node node_modules/typescript/bin/tsc --noEmit
npm run build:pages
```

## 亚马逊 2024 年历史修复

2024 年前三季度曾缺数，是采集器为 2025 年 Q1–Q3 使用了不匹配的历史财报路径；这些财报的上年同期列原本承担部分历史补录。现已修正 2025 年文件地址，并接入 2024 年原始财报。现金购置固定资产的单季数据为：

| 期间 | 亿美元 | 原始财报 |
| --- | ---: | --- |
| 2024 Q1 | 149.25 | [Amazon Q1](https://s2.q4cdn.com/299287126/files/doc_financials/2024/q1/AMZN-Q1-2024-Earnings-Release.pdf) |
| 2024 Q2 | 176.20 | [Amazon Q2](https://s2.q4cdn.com/299287126/files/doc_financials/2024/q2/AMZN-Q2-2024-Earnings-Release.pdf) |
| 2024 Q3 | 226.20 | [Amazon Q3](https://s2.q4cdn.com/299287126/files/doc_financials/2024/q3/AMZN-Q3-2024-Earnings-Release.pdf) |

采用现金流量表 `Purchases of property and equipment`，从百万美元转换为亿美元。保留单季口径，不将年初累计或全年数值当成季度数值。2025 Q3 同时补回 350.95 亿美元。

后台检查到指定历史季度缺失时，仅补采亚马逊；来源失败保留最后成功数据并退避重试，成功后跳过重复补采。官方报告原文、获取时间、内容哈希及修订记录沿用现有保存机制。
