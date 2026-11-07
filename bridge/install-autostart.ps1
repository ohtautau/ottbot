param([switch]$Disable)
$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path $PSScriptRoot -Parent
$trayScript = Join-Path $PSScriptRoot 'tray-bridge.ps1'
$runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
try { $entry = if ($registryKey) { $registryKey.GetValue('Ottbot', $null) } else { $null } } finally { if ($registryKey) { $registryKey.Dispose() } }
if ($entry -and $entry -notlike ('*' + $trayScript + '*')) { throw 'A different Ottbot startup entry already exists; it was not overwritten.' }
if ($Disable) {
    if ($entry) { Remove-ItemProperty -LiteralPath $runPath -Name 'Ottbot' }
    Write-Host 'Ottbot login startup disabled.'
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $bridgeRoot 'local-state/codex-bridge/worker.json'))) { throw 'Bridge configuration is missing.' }
    $shell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $command = '"' + $shell + '" -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $trayScript + '"'
    if (-not (Test-Path -LiteralPath $runPath)) { New-Item -Path $runPath | Out-Null }
    New-ItemProperty -LiteralPath $runPath -Name 'Ottbot' -Value $command -PropertyType String -Force | Out-Null
    Write-Host 'Ottbot tray will start hidden after this user signs in to Windows.'
}
