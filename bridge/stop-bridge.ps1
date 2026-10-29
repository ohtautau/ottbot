$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path $PSScriptRoot -Parent
$bridgePidFile = Join-Path $bridgeRoot 'local-state/codex-bridge/supervisor.pid'
if (-not (Test-Path -LiteralPath $bridgePidFile)) { Write-Host 'No bridge supervisor PID was recorded.'; exit 0 }
$bridgeSupervisorId = [int](Get-Content -LiteralPath $bridgePidFile)
$bridgeSupervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgeSupervisorId"
if (-not $bridgeSupervisor) { Write-Host 'The bridge supervisor is already stopped.'; exit 0 }
$bridgeExpectedScript = Join-Path $PSScriptRoot 'start-bridge.ps1'
if ($bridgeSupervisor.CommandLine -notmatch [regex]::Escape($bridgeExpectedScript)) { throw 'Stored PID belongs to another process. Nothing was stopped.' }
& taskkill.exe /PID $bridgeSupervisorId /T /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the bridge supervisor.' }
Write-Host 'Local bridge stopped. The separate server relay and blog remain running.'
