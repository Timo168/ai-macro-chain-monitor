param([switch]$PullModel)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $projectRoot 'outputs\local-reasoning'
$binaryRoot = Join-Path $localRoot 'runtime'
$binaryPath = Join-Path $binaryRoot 'ollama.exe'
$archive = Join-Path $localRoot 'ollama-windows-amd64.zip'
if (-not (Test-Path -LiteralPath $binaryPath)) {
    if (-not (Test-Path -LiteralPath $archive)) { throw '请先运行 node scripts/download-local-reasoning.mjs 下载官方安装包。' }
    $source = Get-Content -LiteralPath (Join-Path $localRoot 'runtime-source.json') -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $source.sha256) { throw '官方安装包校验不一致，停止。' }
    Expand-Archive -LiteralPath $archive -DestinationPath $binaryRoot
}
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_MODELS = Join-Path $localRoot 'models'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_CONTEXT_LENGTH = '40960'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_FLASH_ATTENTION = '1'
$env:OLLAMA_KV_CACHE_TYPE = 'q8_0'
$serverReady = $false
try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2; $serverReady = $true } catch { }
if (-not $serverReady) {
    $serverProcess = Start-Process -FilePath $binaryPath -ArgumentList 'serve' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $localRoot 'server.stdout.log') -RedirectStandardError (Join-Path $localRoot 'server.stderr.log')
    $serverProcess.Id | Set-Content -LiteralPath (Join-Path $localRoot 'server.pid')
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        Start-Sleep -Seconds 1
        try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 1; $serverReady = $true; break } catch { }
    }
    if (-not $serverReady) { throw '本机服务未启动，请检查 outputs/local-reasoning/server.stderr.log。' }
}
if ($PullModel) {
    $pullProcess = Start-Process -FilePath $binaryPath -ArgumentList 'pull','qwen3:8b' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $localRoot 'model.stdout.log') -RedirectStandardError (Join-Path $localRoot 'model.stderr.log')
    $pullProcess.Id | Set-Content -LiteralPath (Join-Path $localRoot 'download.pid')
    Write-Output 'Qwen3 8B 已开始后台下载。可在 outputs/local-reasoning/model.stderr.log 查看进度。'
}
Write-Output '本机模型服务已启动，仅监听本机地址；没有打开命令窗口。'
