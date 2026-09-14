param([string]$PythonPath = 'python')
$ErrorActionPreference = 'Stop'
$macroRoot = Split-Path -Parent $PSScriptRoot
$macroPython = (Get-Command $PythonPath).Source
$macroPythonWindowless = Join-Path (Split-Path $macroPython -Parent) 'pythonw.exe'
if (Test-Path -LiteralPath $macroPythonWindowless) { $macroPython = $macroPythonWindowless }
$macroAction = New-ScheduledTaskAction -Execute $macroPython -Argument ('"' + (Join-Path $macroRoot 'scripts/schedule.py') + '"') -WorkingDirectory $macroRoot
$macroTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$macroSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RunOnlyIfIdle -IdleDuration (New-TimeSpan -Minutes 10) -IdleWaitTimeout (New-TimeSpan -Hours 1) -DontStopOnIdleEnd
Register-ScheduledTask -TaskName 'AI-Macro-Observatory-Data-Sync' -Action $macroAction -Trigger $macroTrigger -Settings $macroSettings -Description 'AI 产业链宏观观察台：按官方发布日历采集数据、保留缓存和修订，每 15 分钟检查。' -Force | Select-Object TaskName,State
