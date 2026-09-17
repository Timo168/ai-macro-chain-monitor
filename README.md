# AI 产业链宏观观察台

七个中文视图、17 组图表、23 个真实历史序列。使用 React 19 / Vite / Recharts，支持电脑和手机。不使用演示行情、投资评分或未经核验的市场预期。

## 当前运行方式

- 本地网站：http://localhost:5173/ 。网站后台读取 `data/latest.json`，浏览器不直接请求数据源。
- 本机 Windows 计划任务 `AI-Macro-Observatory-Data-Sync` 已安装，每 15 分钟检查官方发布日历和官方利率决议。关闭网页或网站进程不影响采集；电脑需运行并联网，休眠后恢复时补检查。
- `data/observations.sqlite` 保存观测值、来源发布时间（不可得时为 null）、获取时间与修订版本；`data/versions/<series>/<sha256>.*` 保留原始文件。
- GitHub Pages 网站使用 `.github/workflows/deploy.yml`：约每 15 分钟在 GitHub Actions 运行采集器，按官方日历检查后发布页面与数据。与网页、个人电脑运行状态无关。`data-cache` 分支持久保存 SQLite、原始文件、日历与调度状态，每次运行先恢复再保存，使用普通提交而非强推。
- 政策利率页分开保存两种口径：BIS 的各国**月度期末**历史用于横向折线图；美联储官方 RSS、FOMC 声明及实施说明用于“最新官方决议”卡片。决议日不会被伪装成月初或月末的跨国比较点。
- GitHub 定时工作流可能延迟，不能承诺准点或实时；公开仓库长期无活动时 GitHub 可能暂停定时工作流，可在 Actions 重新启用。页面展示最后成功采集时间。来源失败保留旧数据并标注状态。
- 本机 `5173` 使用 Vite 客户端预览并读取本地原子缓存；正式 GitHub Pages 流程会随每次数据检查重新发布。

## 启动

需要 Node.js 22.13+、Python 3.11+、curl。

```powershell
npm ci
python -m pip install -r scripts/requirements.txt
python scripts/collect.py
npm run dev
```

本机 `python` 如指向 WindowsApps 空壳，请使用真正解释器。本次验证使用：

```powershell
& 'C:\实际Python目录\python.exe' scripts/schedule.py
```

关闭终端后仍运行网站：`./scripts/start-background.ps1`。隐藏窗口，日志在 `.logs/website.log`、`.logs/website-errors.log`。不要重复启动占用 5173 的实例。前台使用 `./scripts/start-local.ps1`。

## 数据源与密钥

指标配置位于 `lib/indicators.json`，图表及解释位于 `lib/groups.ts`。

- 默认从 FRED 官方公开图表 CSV 下载完整历史，无需密钥。这不是与正式 API 同等级的稳定接口承诺；下载适配器集中在 `scripts/collect.py`，方便替换。
- 可选正式 FRED API：在**后台进程环境变量**配置 `FRED_API_KEY`。变量示例见 `.env.example`。采集器不会自动读取 `.env`，需要启动环境或密钥管理器注入。密钥不要进入 `NEXT_PUBLIC_*`、浏览器或 Git。
- 世界银行：从官方商品主页发现最新月度 XLSX，失败时使用最后已知官方链接；按 `Monthly Prices` 工作表、标题、单位和日期解析。每个新哈希保留原文件。
- NFCI 目标用途许可待核验，首版关闭 CSV 导出。世界银行数据保留署名与基准说明，黄金在 2025-06 更换基准。

## 自动更新与状态

本机任务已安装。迁移到新电脑时：

```powershell
./scripts/install-scheduler.ps1 -PythonPath 'C:\实际路径\python.exe'
Get-ScheduledTaskInfo -TaskName 'AI-Macro-Observatory-Data-Sync'
```

移除任务：`./scripts/remove-scheduler.ps1`。手动检查一次：`python scripts/schedule.py`；强制采集：`python scripts/schedule.py --force`。

Windows 的计划任务只使用 `pythonw.exe`；找不到它时安装会停止，而不会回退到会弹窗的 `python.exe`。任务隐藏运行、不等待电脑空闲，采集中的 `curl`、Python 和 Node 子进程也会静默运行；定时更新不会弹出黑色命令窗口。无窗口任务的运行记录写入 `.logs/scheduler.log`。手动在终端执行上述命令时，输出仍会留在当前终端，便于排查问题。

1. FRED 官方 HTML 发布日历；PCE 优先使用 BEA 官方 JSON。按 `America/Chicago` 或来源 ISO 偏移解析，UTC 存储，北京时间展示，自动处理夏令时。
2. 月度日历回看 62 天、周度 21 天，保存上次到期事件。发布后按 15/30/60/120 分钟重试；超过 48 小时仍缺新观测，继续每日追赶。失败时保留日历缓存。
3. 日频收益率按发布窗口及每日兜底同步；布伦特遵循来源实际发布批次，仍保留日频观测。目标区间按每日生效数据检查，不把每日数据日历当作 FOMC 会议日历。
4. 世界银行文件每日检查新哈希；所有序列每周复核历史修订。月度指标不会因为数日不变就被标异常。
5. 来源失败保留最后成功数据和获取时间，另记检查状态。尚未发布、等待上游、来源延迟、抓取失败且缓存、未配置分别处理。
6. 网页“检查更新”只读缓存，不制造新观测。`data/scheduler.json` 为任务状态，`data/calendar.json` 为官方日历缓存；SQLite 的 `runs` 表记录采集结果。
7. 美联储官方决议通过其货币政策 RSS 发现后，读取 FOMC 声明和实施说明，保存公布日、目标区间、生效日、变动基点、原文哈希与来源链接。每 15 分钟检查一次；抓取失败时保留上次成功决议并标注缓存。GitHub Pages 仍需等待下一次工作流和部署完成，因此这是准实时更新，不承诺秒级显示。

## 计算与图表

- 同比按上年同月找基期，环比按上一自然月找基期。CPI 同比用未季调序列，环比用季调序列；PCE 均用季调指数。缺基期留空。
- 初请原始单位为人，展示千人；均值要求四个连续周。非农增量是相邻月 PAYEMS 总量差，单位千人；三月均值要求连续月份。
- 利率、失业率和通胀率之差是百分点；商品变化为百分比；NFCI 差为指数点。极小变化用 `<0.01` 等形式，避免“上升 0.00”。
- 图表顶部保持全历史最新值；缩放只改变区间统计、绘图区与导出范围。内部缺值保留断点。悬停、图例、同比/环比、适用图型切换均可操作。
- 商品比较统一月频，以共同首月重置 100；布伦特取有效日观测均值，保守排除来源首尾边界月，避免与世界银行完整月均混用。原价格分别显示。
- 摘要链接到对应图表与区间，NFCI 同时呈现水平与变化方向。首次导入的历史是目前修订值，不代表当年当时已知值。

## 验证

```powershell
node --test tests/calculations.test.mjs
python tests/collector_test.py
npx tsc --noEmit
npm run build
```

JS 验证包括 17 组图表各 3 点（51 点）、15 个 FRED 序列各 3 个原始点、辅助通胀转换及缺值/均值/变化单位。Python 验证世界银行 8 组商品各 3 点、修订留存、失败保留缓存与日历日期。报告在 `docs/verification.json`，来源核验在 `docs/source-audit.md`。

本机运行数据和原始档案不提交 Git；发布快照为 `data/seed.json`。新克隆中需先采集再执行要求档案的测试。

## 尚未完成的外部接入

1. GitHub Actions 调度与数据分支提供云端更新；不提供严格实时 SLA。将来可迁移至常驻数据库和专业调度服务。
2. 正式 FRED API 密钥为可选配置，现有公开 CSV 可运行。
3. 首次采集以前完整 ALFRED vintage 回填；当前仅保留实际观察到的修订。
4. NFCI 商业再分发/CSV 许可、实时行情许可与可靠一致预期。
5. 行业模块下一阶段仍需补齐连续的数据中心项目历史、合同电价、先进封装实际产能，以及取得授权的 AI 服务器出货量和 HBM/DRAM/NAND 价格；云厂商资本开支、天然气、区域电价与铝已接入。详见[行业模块完整清单](docs/industry/README.md)。

以上均不以演示数据替代，也不会被界面写成已完成。

## GitHub 部署

仓库：<https://github.com/Timo168/ai-macro-chain-monitor>。Pages 使用 Actions 模式，默认分支为 `main`。提交代码、手动运行工作流或定时触发都会执行数据检查、验证、构建、发布。工作流页面：<https://github.com/Timo168/ai-macro-chain-monitor/actions/workflows/deploy.yml>。

可选密钥放在仓库 Settings → Secrets and variables → Actions → `FRED_API_KEY`。不配置则使用公开 CSV。不要在 data-cache 分支中放任何密钥、个人文件或非公开业务数据。

本地构建 Pages：`npm run build:pages`，产物为 `dist-pages`。部署子路径由 `PAGES_BASE_PATH` 控制，默认 `/ai-macro-chain-monitor/`。页面导航、数据与静态资源均支持这个子路径。

参考：[GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[定时工作流限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。


## AI产业链关键指标

原“AI产业链影响”已升级为独立产业模块，包含五个子页面和可追溯的配置规则。[完整交付、来源、运行和未完成清单](docs/industry/README.md)。入口：`?page=impact`。
