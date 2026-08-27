param(
  [string]$Target,
  [string]$RuntimeDirectory
)

$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$v98Installer = Join-Path $pluginRoot "Install-UxpV98.ps1"

if (-not (Test-Path -LiteralPath $v98Installer)) {
  throw "Photoshop Assistant v9.8 installer was not found: $v98Installer"
}

Write-Host "The generic installer now targets Photoshop Assistant v9.8."
& $v98Installer @PSBoundParameters
