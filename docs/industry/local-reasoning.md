# 不消耗 API 额度的本地推理

2026-10-31：默认推理提供方改为 Ollama，本机模型默认 `qwen3:8b`。不会因缺少模型、服务故障或输出失败而转用收费 API。当前电脑核验为 32GB 内存、RTX 4060 Ti 16GB 显存；这证明有部署条件，不代表模型效果已经通过验收。

## 运行方式

电脑下载并运行开源模型 → 读取网站当前证据包 → 生成结构化研究解释 → 精确校验引用与结论边界 → 单独发布模型结果 → GitHub 重新校验并展示。

- 推理计算在本机执行，不使用 API 密钥、不消耗外部 API 额度；仍占用本机算力、磁盘与电力。
- 模型服务只监听 `127.0.0.1:11434`，显式关闭云模型；接口还拒绝远端地址、重定向及云端别名。
- 不把整份本机宏观数据库推到线上。发布器只更新 `data-cache` 的 `industry/research-local-model.json`。
- 云端仍检查数据；电脑关闭时不生成新解释。若输入已变化，旧模型解释不能冒充当前结果，页面回退可复算的规则结论，等待本机再次推理。
- 输入包含当前数据日期，因此跨日也需要重新生成。网页刷新本身不启动本机任务。
- 无内部 thinking 文本进入网站或数据分支。保留最终分析、模型 digest、引用校验、用量和耗时。

## 首次准备

在项目目录运行：

```powershell
node scripts/download-local-reasoning.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-local-reasoning.ps1 -PullModel
```

第一步从 Ollama 官方 GitHub release 下载便携运行时并核验 SHA256；第二步隐藏启动服务和模型下载。程序、权重和日志仅放在被 Git 忽略的 `outputs/local-reasoning/`。安装包约 1.6GB，模型约 5.2GB，解压还需要空间。后台进度见 `model.stderr.log`。不要把未完成下载当作已安装。

网页源码先完成部署，且模型下载完成后执行：

```powershell
node scripts/run-local-reasoning.mjs
node scripts/publish-local-reasoning.mjs
node scripts/publish-local-reasoning.mjs --publish
```

第一条使用线上当前证据做真实推理。失败返回非零退出码，不能发布为成功。第二条只做发布前验收，第三条才向已授权仓库发布并触发网站更新。运行前请确认 GitHub CLI 已登录；不需要 OpenAI 账户。

网站的云端定时任务不会连接家中电脑。当前本机运行与发布为上述显式操作，尚未注册开机自启或自动发布任务；这两项不能声称已完成。

## 费用与验收

本机输出中 `costStatus=local_no_api_fee` 表示外部 API 调用费为零，不代表电力及设备成本为零。输入、输出 token 数保留原始统计，不能获取的思考 token 数保持空值。

默认 `REASONING_PROVIDER=ollama`、`REASONING_ENABLED=false`。本机显式脚本可以执行一次推理；普通构建不会开始生成。只有主动选择 `openai` 且显式开启、配置密钥，才允许收费路径；不存在自动切换。

离线测试验证请求、证据校验、状态和发布边界。真实模型是否成功，以 `analysis.origin=model`、`model.status=ready/cached`、模型 digest、成功时间和引用校验为准。模型的解释质量另需人工复核，投资效果仍以实际留存跟踪检验为准。

参考：[Ollama Windows](https://docs.ollama.com/windows)、[本地模式与关闭云端](https://docs.ollama.com/faq)、[结构化输出](https://docs.ollama.com/capabilities/structured-outputs)、[思考模式](https://docs.ollama.com/capabilities/thinking)、[Qwen3 8B](https://ollama.com/library/qwen3:8b)。
