param([switch]$ShowStatus)
$ErrorActionPreference = 'Stop'
# Prefer this host's standard modules when launched from PowerShell 7 or Codex.
# Windows PowerShell can otherwise try to import incompatible inherited modules.
if ($PSVersionTable.PSVersion.Major -le 5) { $env:PSModulePath = "$PSHOME\Modules;$env:PSModulePath" }
$bridgeRoot = Split-Path $PSScriptRoot -Parent
$source = Join-Path $PSScriptRoot 'BridgeTray.cs'
$logo = Join-Path $PSScriptRoot 'assets/ottbot-logo.png'
$icon = Join-Path $PSScriptRoot 'assets/ottbot-logo.ico'
$assetHashes = (@($source, $logo, $icon) | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }) -join ''
$hasher = [Security.Cryptography.SHA256]::Create()
try { $version = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($assetHashes))).Replace('-', '').Substring(0, 12) } finally { $hasher.Dispose() }
$program = Join-Path $bridgeRoot ('local-state/codex-bridge/OttbotTray-' + $version + '.exe')
if (-not (Test-Path -LiteralPath $program)) {
    $compiler = New-Object System.CodeDom.Compiler.CompilerParameters
    $compiler.GenerateExecutable = $true
    $compiler.GenerateInMemory = $false
    $compiler.OutputAssembly = $program
    $compiler.CompilerOptions = '/target:winexe /win32icon:"' + $icon + '"'
    $compiler.ReferencedAssemblies.AddRange([string[]]@('System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Net.Http.dll', 'System.Web.Extensions.dll', 'System.Management.dll'))
    Add-Type -Path $source -CompilerParameters $compiler
}
# This is a Windows GUI executable with no console. --background suppresses its
# status form; SW_HIDE would also hide the first form opened later by the user.
$options = @{ FilePath=$program; WorkingDirectory=$bridgeRoot }
if (-not $ShowStatus) { $options.ArgumentList='--background' }
Start-Process @options
