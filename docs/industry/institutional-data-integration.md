# 权威机构数据与研究结论落地（2026-10-01）

本次新增可持续采集的公开数据，完善正式研究与先行研究的区分。产业因子评分表达研究优先级，不代表预期收益；尚未完成股票估值及样本外投资回测。

## 已接入

| 来源 | 指标与历史 | 用途及边界 |
|---|---|---|
| SEC EDGAR companyfacts | MU、ETN、VRT整体营业收入及毛利率，各14个连续实际财季 | 企业业务周期；非AI/HBM单项。SEC `filed`为发布时间，申报accession、原始XBRL标签及累计差分输入均保留。 |
| TSMC Investor Relations | 整体收入（新台币）及TIFRS毛利率，2024Q1至2026Q2共10季 | 晶圆代工企业总体需求与盈利；不等于AI芯片收入。季度页动态发现Earnings Release，仅取实际业绩段。 |
| [CSO MEC02](https://data.cso.ie/table/MEC02) | 爱尔兰数据中心实际计量用电，2015Q1至2025Q4共44季、GWh | 区域负荷交叉验证，非美国/全球数据，非AI专属，不能代替在建/投运MW。季度观测、年度发布；时效按来源`updated`及年度发布周期判断。 |
| [IEA Key Questions on Energy and AI](https://www.iea.org/reports/key-questions-on-energy-and-ai) | 2025年全球用电485TWh（估算）、2030年950TWh（预测） | 自动解析公开正文及许可标记；只进入情景背景，不进入实际序列或正式评分，不从图线插值制造历史。 |

CSO与该IEA报告采用CC BY 4.0，保留署名、许可、版本和适用范围。网站对IEA的衍生说明不代表IEA背书。

## 自动更新与状态

`industry_schedule.py`每天运行两个新增适配器，浏览器关闭后仍由GitHub Actions / Windows后台任务运行。新适配器的Windows curl备用请求使用`CREATE_NO_WINDOW`与`SW_HIDE`。

- 成功获取并通过格式/单位/日期校验：`ready`。
- 获取失败，有最后成功数据：`cached`，保留原发布时间、获取时间、版本及错误。
- 首次失败：`fetch_failed`；未发布占位：`pending`，不生成零值。
- 商业报告未获相应用途授权：`authorization_required`；不抓正文、不向模型发送数字、不导出CSV。
- 用户页面刷新只检查新后台版本，不创建观测。

SEC通过`SEC_USER_AGENT`可配置组织/联系身份；GitHub在仓库的 Actions Variables 中配置同名变量，本地采集使用进程环境变量，不能只把它写进未加载的`.env`。无需API密钥。TSMC当前新季度结束21天后开始探测，未覆盖完整官方财报日历，不能承诺公告即时更新。

## 研究引擎变化

1. 新增公司整体收入的明确行业映射，仅用于定义中的`researchTargets`，不会自动视为全AI产业需求。
2. 同公司整体收入与毛利率别名去重；分部数据保留独立口径。
3. 采用最近可比窗口：季度至少8期，月度水平指标至少16期，并至少4个同比比较点；窗口内空档继续阻断。较早缺口不会永久阻断新的完整窗口。
4. 正增长显著减速时，不会因历史偏离绝对值较大而放大正向强度。
5. 过期产业数据从模型可引用上下文移除；完整旧值仍保存在复算档案。
6. 各目标`readiness`列出直接性、缺期、短历史、需求主体覆盖等所有阻断原因与补齐方法。
7. 机构来源独立于数字性质。实际/估算/预测按每条fact区分；报告背景不能自动补正式评分门槛。

规则版本：`industry-1.4.0`；因子版本：`industry-evidence-factor-2.3.0`；研究版本：`research-2.1.0`。`history_normalized`仅表示通过历史标准化，绝不表示已完成投资效果校准。

完整`calculationInputs`、观测版本清单、输入哈希存入`data/industry/research-inputs`及持久数据分支；网页和外部模型使用精简证据包。首次历史导入是当前可获得版本，不能伪装成过去当时已知的完整修订历史。

## 已核查但尚未接入的机构

| 机构 | 可能补充 | 当前具体阻碍 |
|---|---|---|
| [沙利文](https://www.frost.com/terms-of-use/) | AI基础设施趋势与市场研究 | 条款限制数据采集、数据库/衍生整理和公开展示；开放摘要主要是趋势/预测，没有可许可的连续实际接口。 |
| [IDC](https://www.idc.com/about/termsofuse/) | 服务器收入与出货追踪 | 要求外部使用许可，限制自动抓取及高级分析/AI输入；服务器总体口径也不是纯AI出货。 |
| [TrendForce](https://www.trendforce.com/about/terms) | DRAM/NAND/HBM价格与供需 | 公开署名指南不等于模型/数据库/再分发许可。 |
| [Synergy](https://www.srgresearch.com/about) | 云市场与超大规模数据中心 | 非客户使用需审批；数量和容量指数不能替代可比MW。 |
| [Uptime](https://uptimeinstitute.com/publication-usage) | PUE、机架密度等调查 | 非个人用途需书面许可；每年自报样本改变，不是全量容量加权效率。 |
| [CBRE](https://www.cbre.com/about-us/disclaimer-terms-of-use) | 主要市场在建MW与吸纳 | 采集/存储/衍生权限未获得；特定市场覆盖与历史修订必须逐版处理。 |

这些限制是各机构公布的具体使用条件，不是因为数据不足就任意屏蔽来源。以后取得适用授权，可以添加单独适配器；仍需记录方法、范围、发布日期、委托关系、版本和实际/预测性质。

## 尚不能落地为可靠买卖模型的原因

- `PROJECT.operational_capacity/construction_capacity`仍缺同口径、连续、公开可用的建设/投运MW实际历史；项目里程碑、投入、电耗或预测不能替代。
- 先进封装缺可复核实际需求与盈利历史；服务器及加速器部分公司的近期季度历史仍有空档或太短。
- 外部推理模型没有配置服务端`OPENAI_API_KEY`，当前真实状态为`not_configured`，确定性因子计算正常运行。模型名称只是默认配置，不表示已调用。
- 尚缺证券估值、盈利预期、公司行动、交易成本与基准，以及按当时可知数据做滚动样本外回测；不能证明评分能提高投资收益。

验收证据：`institutional-source-verification.json`含9条新增实际序列各3个历史点的原始来源核对，IEA两项情景另行验证；采集与模型测试覆盖累计差分、修订、未知基期、失败缓存、授权排除和近期缺期等边界。

本地验证：46项JavaScript测试和46项Python采集测试通过；TypeScript与Pages生产构建通过。完整档案复算10个目标的分数、因子贡献、先行信号和就绪检查，与发布输入一致。电脑与390像素手机视窗检查无页面横向溢出，数据来源、缺口展开和CSO图表跳转正常。
