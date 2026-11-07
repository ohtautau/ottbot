param([switch]$KeepTray)
$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path $PSScriptRoot -Parent
if (-not $KeepTray) {
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { $id = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($bridgeRoot.TrimEnd('\').ToLowerInvariant()))).Replace('-', '').Substring(0, 16) } finally { $hash.Dispose() }
    try { $trayStop = [Threading.EventWaitHandle]::OpenExisting('Local\Ottbot.Tray.Stop.' + $id) } catch [Threading.WaitHandleCannotBeOpenedException] { $trayStop = $null }
    if ($trayStop) { try { $trayStop.Set() | Out-Null } finally { $trayStop.Dispose() }; Write-Host 'Ottbot tray shutdown requested.'; exit 0 }
}
$bridgePidFile = Join-Path $bridgeRoot 'local-state/codex-bridge/supervisor.pid'
if (-not (Test-Path -LiteralPath $bridgePidFile)) { Write-Host 'No bridge supervisor PID was recorded.'; exit 0 }
$bridgeSupervisorId = [int](Get-Content -LiteralPath $bridgePidFile)
$bridgeSupervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgeSupervisorId"
if (-not $bridgeSupervisor) { Write-Host 'The bridge supervisor is already stopped.'; exit 0 }
$bridgeExpectedScript = Join-Path $PSScriptRoot 'start-bridge.ps1'
if ($bridgeSupervisor.Name -notmatch '^(pwsh|powershell)\.exe$' -or $bridgeSupervisor.CommandLine.Replace('/', '\') -notmatch [regex]::Escape($bridgeExpectedScript)) { throw 'Stored PID belongs to another process. Nothing was stopped.' }
& taskkill.exe /PID $bridgeSupervisorId /T /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the bridge supervisor.' }
Write-Host 'Local bridge stopped. The separate server relay and blog remain running.'
