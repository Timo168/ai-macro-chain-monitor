param([string]$PythonPath = 'python')
$ErrorActionPreference = 'Stop'
$macroRoot = Split-Path -Parent $PSScriptRoot
$macroPythonConsole = (Get-Command $PythonPath -ErrorAction Stop).Source
$macroPythonWindowless = Join-Path (Split-Path $macroPythonConsole -Parent) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $macroPythonWindowless)) {
    throw "找不到 pythonw.exe，已停止安装以避免后台采集弹出命令窗口：$macroPythonWindowless"
}
$macroAction = New-ScheduledTaskAction -Execute $macroPythonWindowless -Argument ('-u "' + (Join-Path $macroRoot 'scripts/schedule.py') + '"') -WorkingDirectory $macroRoot
$macroTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$macroSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
Register-ScheduledTask -TaskName 'AI-Macro-Observatory-Data-Sync' -Action $macroAction -Trigger $macroTrigger -Settings $macroSettings -Description 'AI 产业链宏观观察台：无窗口后台同步；每 15 分钟检查官方数据和央行决议。' -Force | Select-Object TaskName,State
