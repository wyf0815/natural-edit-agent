$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $pluginRoot "uxp-v9.8"
$dist = Join-Path $pluginRoot "dist"
$staging = Join-Path $dist "natural-edit-agent-v0.9.8-beta"
$zipPath = Join-Path $dist "Natural-Edit-Agent-v0.9.8-beta.zip"
$ccxPath = Join-Path $dist "Natural-Edit-Agent-v0.9.8-beta.ccx"
$files = @(
  "manifest.json",
  "index.html",
  "styles.css",
  "model-providers.js",
  "visual-contract.js",
  "protocol.js",
  "state-engine.js",
  "mask-rle.js",
  "confidence-policy.js",
  "selection-session.js",
  "capabilities.js",
  "planner.js",
  "engine.js",
  "main.js"
)

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
  throw "Natural Edit Agent v0.9.8 plugin source was not found: $source"
}
if (Test-Path -LiteralPath $staging) {
  Remove-Item -LiteralPath $staging -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $staging | Out-Null

foreach ($file in $files) {
  $sourceFile = Join-Path $source $file
  if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
    throw "Natural Edit Agent v0.9.8 package source is missing: $sourceFile"
  }
  Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $staging $file) -Force
}

foreach ($notice in @("LICENSE", "THIRD_PARTY_NOTICES.md")) {
  $noticePath = Join-Path $pluginRoot $notice
  if (-not (Test-Path -LiteralPath $noticePath -PathType Leaf)) {
    throw "Natural Edit Agent package notice is missing: $noticePath"
  }
  Copy-Item -LiteralPath $noticePath -Destination (Join-Path $staging $notice) -Force
}

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path -LiteralPath $ccxPath) { Remove-Item -LiteralPath $ccxPath -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force
Move-Item -LiteralPath $zipPath -Destination $ccxPath -Force

Write-Host "Built Natural Edit Agent v0.9.8 beta package: $ccxPath"
