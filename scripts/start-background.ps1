$ErrorActionPreference = 'Stop'
$macroRoot = Split-Path -Parent $PSScriptRoot
$macroNode = (Get-Command node).Source
$macroLogDir = Join-Path $macroRoot '.logs'
New-Item -ItemType Directory -Path $macroLogDir -Force | Out-Null
$macroProcess = Start-Process -FilePath $macroNode -ArgumentList @('scripts/run-framework.mjs', 'dev') -WorkingDirectory $macroRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $macroLogDir 'website.log') -RedirectStandardError (Join-Path $macroLogDir 'website-errors.log') -PassThru
$macroProcess.Id | Set-Content -LiteralPath (Join-Path $macroLogDir 'website.pid')
Write-Output ('Website process started: ' + $macroProcess.Id)
