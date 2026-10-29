$ErrorActionPreference = 'Stop'
$ottbotRoot = Split-Path $PSScriptRoot -Parent
$bridgeState = Join-Path $ottbotRoot 'local-state/codex-bridge'
$bridgeConfigPath = Join-Path $bridgeState 'worker.json'
if (-not (Test-Path -LiteralPath $bridgeConfigPath)) { throw 'Bridge configuration is missing. Run deployment setup first.' }
$bridgeConfig = Get-Content -Raw -LiteralPath $bridgeConfigPath | ConvertFrom-Json
$bridgeNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $bridgeNode) { $bridgeNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $bridgeNode)) { throw 'Node.js 22+ is required.' }
try {
    # Windows PowerShell 5 treats native stderr as ErrorRecord even for exit code 0.
    $ErrorActionPreference = 'Continue'
    $bridgeAuth = & $bridgeConfig.codexPath login status 2>&1 | Out-String
    $bridgeAuthExit = $LASTEXITCODE
} finally { $ErrorActionPreference = 'Stop' }
if ($bridgeAuthExit -ne 0 -or $bridgeAuth -notmatch 'Logged in using ChatGPT') { throw 'Please sign in to Codex with ChatGPT before starting. API-key authentication is not used by this bridge.' }
$bridgeLock = $null
$bridgeWorker = $null
$bridgeTunnel = $null
try {
    $bridgeLock = [System.IO.File]::Open((Join-Path $bridgeState 'supervisor.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    foreach ($bridgePort in @($bridgeConfig.port, $bridgeConfig.localRelayPort)) {
        if (Get-NetTCPConnection -LocalPort $bridgePort -State Listen -ErrorAction SilentlyContinue) { throw "Port $bridgePort is already in use; no existing process was stopped." }
    }
    $bridgeWorkerArgs = @(('"' + (Join-Path $PSScriptRoot 'worker.mjs') + '"'), ('"' + $bridgeConfigPath + '"'))
    $bridgeWorker = Start-Process -FilePath $bridgeNode -ArgumentList $bridgeWorkerArgs -WorkingDirectory $ottbotRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $bridgeState 'worker.log') -RedirectStandardError (Join-Path $bridgeState 'worker-error.log')
    $bridgeWorker.Id | Set-Content -LiteralPath (Join-Path $bridgeState 'worker.pid')
    Write-Host 'Codex worker started. Waiting for private server tunnel...'
    while (-not $bridgeWorker.HasExited) {
        $bridgeSshArgs = @('-N', '-L', "127.0.0.1:$($bridgeConfig.localRelayPort):127.0.0.1:$($bridgeConfig.serverRelayPort)", '-R', "127.0.0.1:$($bridgeConfig.serverWorkerPort):127.0.0.1:$($bridgeConfig.port)", '-i', ('"' + $bridgeConfig.sshKey + '"'), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=yes', '-o', ('"UserKnownHostsFile=' + $bridgeConfig.knownHosts + '"'), $bridgeConfig.sshTarget)
        $bridgeTunnel = Start-Process -FilePath 'ssh.exe' -ArgumentList $bridgeSshArgs -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $bridgeState 'tunnel-error.log')
        $bridgeTunnel.Id | Set-Content -LiteralPath (Join-Path $bridgeState 'tunnel.pid')
        for ($bridgeAttempt = 0; $bridgeAttempt -lt 20; $bridgeAttempt++) {
            if ($bridgeTunnel.HasExited -or $bridgeWorker.HasExited) { break }
            try {
                $bridgeHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$($bridgeConfig.localRelayPort)/health" -Headers @{ Authorization = "Bearer $($bridgeConfig.clientToken)" } -TimeoutSec 2
                if ($bridgeHealth.ok) { Write-Host 'Ready. In CodeBuddy choose codex-local. Send /model or /status in chat.'; break }
            } catch { }
            Start-Sleep -Milliseconds 500
        }
        while (-not $bridgeTunnel.HasExited -and -not $bridgeWorker.HasExited) { Start-Sleep -Seconds 2 }
        if (-not $bridgeTunnel.HasExited) { Stop-Process -Id $bridgeTunnel.Id -ErrorAction SilentlyContinue }
        if (-not $bridgeWorker.HasExited) { Write-Host 'Tunnel disconnected; reconnecting in 5 seconds...'; Start-Sleep -Seconds 5 }
    }
    throw 'Codex worker stopped. Check local-state/codex-bridge/worker-error.log.'
} finally {
    if ($bridgeTunnel -and -not $bridgeTunnel.HasExited) { Stop-Process -Id $bridgeTunnel.Id -ErrorAction SilentlyContinue }
    if ($bridgeWorker -and -not $bridgeWorker.HasExited) { & taskkill.exe /PID $bridgeWorker.Id /T /F 2>$null | Out-Null }
    if ($bridgeLock) { $bridgeLock.Dispose() }
}
