# 数据中心容量来源与更新

项目的官方建设状态、官方披露容量、机构估算容量分别保存。地图按选定口径汇总公开样本；每个数值可回到项目明细查看来源和日期。

## 本次核对的 11 个项目

| 项目 | 官方容量 | 新接入的机构资料 |
| --- | --- | --- |
| Meta Temple | 投运公告未披露 MW | Epoch AI：178 MW IT / 231 MW 设施用电，估算时点 2026-09-30 |
| Meta Kuna | 投运公告未披露 MW | Epoch AI：152 MW IT / 198 MW 设施用电，估算时点 2026-06-01，文章更新 2026-06-16 |
| Meta Gallatin | 投运公告未披露 MW | Epoch AI：新增 AI 楼栋 87 MW IT / 114 MW 设施用电，估算时点 2026-08-24，文章更新 2026-10-05；不含原有园区 |
| Meta Mesa | 投运公告未披露 MW | Cleanview 州级公开表：240 MW 设施用电，页面更新 2026-11-11 |
| Meta Kansas City | 投运公告未披露 MW | Cleanview 州级公开表：低于 200 MW 设施用电，页面更新 2026-11-11；保留上界，不作为 200 MW 点值汇总 |
| Meta Hyperion | 5,000 MW 最终计算容量，官方公告 2026-07-13 | Epoch AI：Holly Ridge 一期预计 2028 Q1 达 1,632 MW IT / 2,203 MW 设施用电；文章更新 2026-09-21 |
| Meta Lebanon | 1,000 MW 园区规划容量，官方公告 2026-02-11 | 当前 Epoch 目录未覆盖 |
| Meta El Paso | 1,000 MW 计算容量，官方公告 2026-07-28；计划 2028 年起上线 | 当前 Epoch 目录未覆盖 |
| DOE Portsmouth | 10,000 MW 规划数据中心容量，在建项目公告 2026-03-24 | 当前 Epoch 目录未覆盖 |
| DOE Savannah River | 1,000 MW 规划数据中心容量，选择谈判公告 2026-07-20 | 当前 Epoch 目录未覆盖 |
| DOE Idaho National Laboratory | 征集方案公告未披露容量 | 尚未取得可核验的项目容量数值 |

此表记录本次接入时核验结果。网站当前值以后台后续成功采集的版本为准。

## 自动获取

`scripts/industry_projects.py` 在原有官方项目采集后调用两个容量适配器：

- `industry_project_capacity.py`：读取 Epoch AI [项目 CSV](https://epoch.ai/data/data_centers/data_centers.csv)、[时间线 CSV](https://epoch.ai/data/data_centers/data_center_timelines.csv) 和对应项目目录页。CSV 提供数值和估算时点，目录页提供机构更新日期。
- `industry_project_capacity_cleanview.py`：仅解析 [Arizona](https://cleanview.co/data-centers/arizona)、[Missouri](https://cleanview.co/data-centers/missouri) 两个公开页面中对应 Meta 项目的投运容量行。没有访问付费表、登录页面或私有接口。

Epoch AI 采用 [CC-BY 署名许可及方法说明](https://epoch.ai/data/data-centers-documentation)。数值旁保留 Epoch AI、来源链接、计算表和方法链接。Cleanview 仅提取上述两条公开事实并署名链接，不再发布完整数据库或文章。

## 字段与状态

`DataCenterProject.capacityEvidence` 保存每个来源、口径、当前/规划分组的最新证据：

- `sourceType`：`official` 或 `institutional_estimate`。
- `capacityKind`：`it_power`、`facility_power`、官方原始容量口径。
- `scope`：`current` 或 `planned`；未来目标保存在 `targetDate`，不作为已经发生的观测日期。
- `valueMw` 为精确点值；`upperBoundMw` / `valueQualifier` 保存“低于某值”等范围描述。
- `asOfDate` 是估算所描述的时点，`publishedAt` 是来源更新日期，`fetchedAt` 是原始文件获取时间，`checkedAt` 是本轮检查时间。
- `coverageScope` 标明一期、新增楼栋等覆盖范围。
- `status` 分别表示成功、缓存、获取失败、未发布、未配置。

目录中的未来行按**来源发布日**区分，超过目标日也不会自动变成已投运事实。Epoch 的 IT 与设施用电列分开保存，当前 CSV 的 IT 数值必须与历史时间线一致。项目名称、业主、国家、页标题、更新日期、重复观测和数值均经过校验。

获取或解析失败时保留最后成功值及原日期，显示缓存状态；首次失败保持空值。当前尚无正值投运估算时保持空值，不把规划项目变成 0 MW 已投运项目。变更前版本保存在 `capacityEvidenceHistory`，原始响应以内容哈希保存在后台已有持久缓存中。

官方 `powerCapacityMw` 与原有 `PROJECT.*` 官方指标保持独立。机构容量只进入明确标注的项目明细和地图估算层，不自动进入官方容量评分。合并缓存时以项目采集器作为项目事实来源，旧的静态登记表补充上下文，不能覆盖刚核验的容量和日期。

地图可切换官方在建规划容量、官方在建计算容量、官方已投运容量、机构 AI IT 容量、机构设施容量和未来规划 AI IT 容量。每个项目在同一口径只选择最新有效版本，覆盖项目数、数据日期和缓存数量可见。Kansas City 仅有范围，保留项目卡说明，精确容量地图显示斜纹。

后台原有每日项目任务同时刷新这些来源。新容量接入版本在首次部署时立即检查，即使当天其他数据已更新。来源失败按 15、30、60、120 分钟退避重试，保留最后成功数据。所有本机子进程均通过隐藏窗口的后台执行器运行；网页关闭后调度继续。GitHub Actions 调度可能排队。

## 验证

```text
python -m unittest discover -s tests -p project_capacity_test.py
python -m unittest discover -s tests -p project_capacity_cleanview_test.py
python -m unittest discover -s tests -p industry_collector_test.py
node --test tests/project-capacity-merge.test.mjs
python tests/project_capacity_schedule_test.py
node --test tests/industry-geography.test.mjs tests/infrastructure-map.test.mjs
```

回归覆盖当前/未来分离、IT/设施用电分离、上界非点值、项目身份校验、源数据变化、失败保留缓存、修订记录、官方统计隔离，以及静态登记表覆盖新数据的问题。
