param([int]$Port = 5173)
$ErrorActionPreference = 'Stop'
$macroRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $macroRoot
if (-not (Test-Path -LiteralPath 'node_modules/vinext/dist/cli.js')) { throw 'Run npm ci before starting.' }
& node scripts/run-framework.mjs dev --port $Port
