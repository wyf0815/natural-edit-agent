$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ccxPath = Join-Path $pluginRoot "dist\Natural-Edit-Agent-v0.9.8-beta.ccx"

if (-not (Test-Path -LiteralPath $ccxPath)) {
  Write-Host "Building the Natural Edit Agent v0.9.8 beta package."
  & (Join-Path $pluginRoot "Build-Ccx.ps1")
}

$upiaCandidates = @(
  "$env:ProgramFiles\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe",
  "${env:ProgramFiles(x86)}\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
)

foreach ($candidate in $upiaCandidates) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) {
    Write-Host "Installing with UPIA: $candidate"
    & $candidate /install $ccxPath
    exit $LASTEXITCODE
  }
}

Write-Warning "UPIA was not found. Opening the CCX file with Windows default handler."
Start-Process -FilePath $ccxPath
