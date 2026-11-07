param([switch]$ShowStatus)
$ErrorActionPreference = 'Stop'
# Prefer this host's standard modules when launched from PowerShell 7 or Codex.
# Windows PowerShell can otherwise try to import incompatible inherited modules.
if ($PSVersionTable.PSVersion.Major -le 5) { $env:PSModulePath = "$PSHOME\Modules;$env:PSModulePath" }
$bridgeRoot = Split-Path $PSScriptRoot -Parent
$source = Join-Path $PSScriptRoot 'BridgeTray.cs'
$version = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.Substring(0, 12)
$program = Join-Path $bridgeRoot ('local-state/codex-bridge/OttbotTray-' + $version + '.exe')
if (-not (Test-Path -LiteralPath $program)) {
    Add-Type -Path $source -OutputAssembly $program -OutputType WindowsApplication -ReferencedAssemblies System, System.Core, System.Windows.Forms, System.Drawing, System.Net.Http, System.Web.Extensions, System.Management
}
# This is a Windows GUI executable with no console. --background suppresses its
# status form; SW_HIDE would also hide the first form opened later by the user.
$options = @{ FilePath=$program; WorkingDirectory=$bridgeRoot }
if (-not $ShowStatus) { $options.ArgumentList='--background' }
Start-Process @options
