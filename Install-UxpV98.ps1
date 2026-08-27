param(
  [string]$Target = "C:\Program Files\Common Files\Adobe\UXP\extensions\com.local.photoshop.assistant.v8-0.8.0",
  [string]$RuntimeDirectory = (Join-Path $env:LOCALAPPDATA "PhotoshopNaturalAgent\v9.8")
)

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop

$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $pluginRoot "uxp-v9.8"
$tokenPath = Join-Path $RuntimeDirectory "bridge-token.json"
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

function New-BridgeToken {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Protect-PathBestEffort {
  param([string]$Path, [switch]$Directory)
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $userSid = $identity.User.Value
    $permission = if ($Directory) { "(OI)(CI)(F)" } else { "(F)" }
    $arguments = @(
      $Path,
      "/inheritance:r",
      "/grant:r",
      "*$($userSid):$permission",
      "*S-1-5-18:$permission",
      "*S-1-5-32-544:$permission"
    )
    & "$env:SystemRoot\System32\icacls.exe" @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls returned $LASTEXITCODE" }
  } catch {
    Write-Warning "Could not tighten ACLs for $Path. Keep this path private: $($_.Exception.Message)"
  }
}

function Get-OrCreateBridgeToken {
  New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
  Protect-PathBestEffort -Path $RuntimeDirectory -Directory
  if (Test-Path -LiteralPath $tokenPath) {
    try {
      $saved = Get-Content -LiteralPath $tokenPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $candidate = [string]$saved.token
      if ($candidate -match '^[0-9a-fA-F]{64}$') {
        Protect-PathBestEffort -Path $tokenPath
        return $candidate.ToLowerInvariant()
      }
    } catch {
      Write-Warning "The saved bridge token is invalid and will be replaced."
    }
  }
  $runtimeParent = Split-Path -Parent $RuntimeDirectory
  foreach ($previousVersion in @("v9.7", "v9.5")) {
    $previousTokenPath = Join-Path (Join-Path $runtimeParent $previousVersion) "bridge-token.json"
    if (-not (Test-Path -LiteralPath $previousTokenPath)) { continue }
    try {
      $saved = Get-Content -LiteralPath $previousTokenPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $candidate = [string]$saved.token
      if ($candidate -match '^[0-9a-fA-F]{64}$') {
        $candidate = $candidate.ToLowerInvariant()
        $payload = @{ version = 1; token = $candidate; migratedFrom = $previousTokenPath; createdAt = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json
        [IO.File]::WriteAllText($tokenPath, $payload, (New-Object Text.UTF8Encoding($false)))
        Protect-PathBestEffort -Path $tokenPath
        return $candidate
      }
    } catch {
      Write-Warning "Could not migrate the $previousVersion bridge token: $($_.Exception.Message)"
    }
  }
  $token = New-BridgeToken
  $payload = @{ version = 1; token = $token; createdAt = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json
  $temporary = "$tokenPath.tmp"
  [IO.File]::WriteAllText($temporary, $payload, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $tokenPath -Force
  Protect-PathBestEffort -Path $tokenPath
  return $token
}

function Get-TextSha256 {
  param([string]$Value)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Value)
    return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("X2") })
  } finally {
    $sha.Dispose()
  }
}

$sourceManifestPath = Join-Path $source "manifest.json"
if (-not (Test-Path -LiteralPath $sourceManifestPath)) {
  throw "v9.8 source manifest is missing."
}

$manifest = Get-Content -LiteralPath $sourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -ne "0.9.8") {
  throw "Refusing to install an unexpected manifest version: $($manifest.version)"
}

$sourceHashes = @{}
foreach ($file in $files) {
  $sourceFile = Join-Path $source $file
  if (-not (Test-Path -LiteralPath $sourceFile)) {
    throw "Required v9.8 file is missing: $file"
  }
  if ($file -ne "index.html") {
    $sourceHashes[$file] = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash
  }
}

$bridgeToken = Get-OrCreateBridgeToken
$sourceIndex = Get-Content -LiteralPath (Join-Path $source "index.html") -Raw -Encoding UTF8
$tokenScriptTag = '    <script src="bridge-token.js"></script>'
if ($sourceIndex -notmatch '<script\s+src=["'']bridge-token\.js["'']') {
  $anchor = '    <script src="model-providers.js"></script>'
  if (-not $sourceIndex.Contains($anchor)) {
    throw "index.html has no safe script anchor for the bridge token."
  }
  $sourceIndex = $sourceIndex.Replace($anchor, "$tokenScriptTag`r`n$anchor")
}
$tokenScript = "// Generated locally by Install-UxpV98.ps1. Do not commit or share.`r`nglobalThis.PS_AGENT_BRIDGE_TOKEN = `"$bridgeToken`";`r`n"
$expectedIndexHash = Get-TextSha256 -Value $sourceIndex
$expectedTokenHash = Get-TextSha256 -Value $tokenScript

$backup = Join-Path ([IO.Path]::GetTempPath()) ("photoshop-agent-v98-install-" + [Guid]::NewGuid().ToString("N"))
$managedFiles = @($files + "bridge-token.js")
$existing = @{}
New-Item -ItemType Directory -Force -Path $backup | Out-Null
New-Item -ItemType Directory -Force -Path $Target | Out-Null

try {
  foreach ($file in $managedFiles) {
    $installedFile = Join-Path $Target $file
    $existing[$file] = Test-Path -LiteralPath $installedFile
    if ($existing[$file]) {
      Copy-Item -LiteralPath $installedFile -Destination (Join-Path $backup $file) -Force
    }
  }

  foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $Target $file) -Force
  }
  [IO.File]::WriteAllText((Join-Path $Target "index.html"), $sourceIndex, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $Target "bridge-token.js"), $tokenScript, (New-Object Text.UTF8Encoding($false)))
  Protect-PathBestEffort -Path (Join-Path $Target "bridge-token.js")

  foreach ($file in $files) {
    $installedFile = Join-Path $Target $file
    if (-not (Test-Path -LiteralPath $installedFile)) {
      throw "Installed file is missing: $file"
    }
    $installedHash = (Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash
    $expectedHash = if ($file -eq "index.html") { $expectedIndexHash } else { $sourceHashes[$file] }
    if ($expectedHash -ne $installedHash) {
      throw "Installed file verification failed: $file"
    }
  }
  if ((Get-FileHash -LiteralPath (Join-Path $Target "bridge-token.js") -Algorithm SHA256).Hash -ne $expectedTokenHash) {
    throw "Installed bridge token verification failed."
  }
} catch {
  foreach ($file in $managedFiles) {
    $installedFile = Join-Path $Target $file
    $backupFile = Join-Path $backup $file
    if ($existing[$file] -and (Test-Path -LiteralPath $backupFile)) {
      Copy-Item -LiteralPath $backupFile -Destination $installedFile -Force
    } elseif (-not $existing[$file] -and (Test-Path -LiteralPath $installedFile)) {
      Remove-Item -LiteralPath $installedFile -Force
    }
  }
  throw
} finally {
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
}

$installedManifest = Get-Content -LiteralPath (Join-Path $Target "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($installedManifest.version -ne "0.9.8") {
  throw "Installed manifest verification failed."
}

Write-Host "Installed Photoshop Assistant v9.8 in place: $Target"
Write-Host "A private bridge token was installed from: $tokenPath"
Write-Host "The plugin ID is unchanged, so saved model settings are retained."
