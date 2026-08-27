param(
  [switch]$ProxyOnly,
  [switch]$RestartProxy,
  [string]$InstalledPluginPath,
  [string]$RuntimeDirectory
)

$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$v98Launcher = Join-Path $pluginRoot "Start-PhotoshopAgentV98.ps1"

if (-not (Test-Path -LiteralPath $v98Launcher)) {
  throw "Photoshop Assistant v9.8 launcher was not found: $v98Launcher"
}

Write-Host "The generic launcher now targets Photoshop Assistant v9.8."
& $v98Launcher @PSBoundParameters
