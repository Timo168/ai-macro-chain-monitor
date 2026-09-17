param([int]$Port = 5173)
$ErrorActionPreference = 'Stop'
$macroRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $macroRoot
if (-not (Test-Path -LiteralPath 'node_modules/vite/bin/vite.js')) { throw 'Run npm ci before starting.' }
& node scripts/run-pages-dev.mjs --port $Port
