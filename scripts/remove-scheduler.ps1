$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName 'AI-Macro-Observatory-Data-Sync' -Confirm:$false
