param(
  [switch]$ProxyOnly,
  [switch]$RestartProxy,
  [string]$InstalledPluginPath = "C:\Program Files\Common Files\Adobe\UXP\extensions\com.local.photoshop.assistant.v8-0.8.0",
  [string]$RuntimeDirectory = (Join-Path $env:LOCALAPPDATA "PhotoshopNaturalAgent\v9.8")
)

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop

function Get-FileSha256 {
  param([string]$Path)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:PS_AGENT_PORT) { [int]$env:PS_AGENT_PORT } else { 17861 }
$requiredBridgeVersion = "0.9.8"
$tokenPath = Join-Path $RuntimeDirectory "bridge-token.json"
$serverSourcePath = Join-Path $pluginRoot "server.js"
$providerSourcePath = Join-Path $pluginRoot "uxp-v9.8\model-providers.js"
if (-not (Test-Path -LiteralPath $serverSourcePath)) { throw "Photoshop Assistant server.js was not found: $serverSourcePath" }
if (-not (Test-Path -LiteralPath $providerSourcePath)) { throw "Photoshop Assistant v9.8 provider module was not found: $providerSourcePath" }
$expectedServerHash = Get-FileSha256 -Path $serverSourcePath
$expectedProviderHash = Get-FileSha256 -Path $providerSourcePath

function New-BridgeToken {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Protect-PathBestEffort {
  param([string]$Path, [switch]$Directory)
  try {
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $permission = if ($Directory) { "(OI)(CI)(F)" } else { "(F)" }
    $arguments = @($Path, "/inheritance:r", "/grant:r", "*$($userSid):$permission", "*S-1-5-18:$permission", "*S-1-5-32-544:$permission")
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

function Sync-InstalledPluginToken {
  param([string]$Token)
  $indexPath = Join-Path $InstalledPluginPath "index.html"
  $manifestPath = Join-Path $InstalledPluginPath "manifest.json"
  if (-not (Test-Path -LiteralPath $indexPath)) {
    Write-Warning "Installed v9.8 plugin was not found at $InstalledPluginPath. Run Install-UxpV98.ps1 before opening the panel."
    return
  }
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Installed plugin manifest is missing." }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.version -ne "0.9.8") {
    throw "Refusing to inject a v9.8 bridge token into plugin version $($manifest.version)."
  }
  $index = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8
  if ($index -notmatch '<script\s+src=["'']bridge-token\.js["'']') {
    $anchor = '    <script src="model-providers.js"></script>'
    if (-not $index.Contains($anchor)) { throw "Installed index.html has no safe bridge-token script anchor." }
    $index = $index.Replace($anchor, "    <script src=`"bridge-token.js`"></script>`r`n$anchor")
    [IO.File]::WriteAllText($indexPath, $index, (New-Object Text.UTF8Encoding($false)))
  }
  $tokenScript = "// Generated locally by Start-PhotoshopAgentV98.ps1. Do not commit or share.`r`nglobalThis.PS_AGENT_BRIDGE_TOKEN = `"$Token`";`r`n"
  $installedTokenPath = Join-Path $InstalledPluginPath "bridge-token.js"
  $installedToken = if (Test-Path -LiteralPath $installedTokenPath) {
    Get-Content -LiteralPath $installedTokenPath -Raw -Encoding UTF8
  } else { $null }
  if ($installedToken -cne $tokenScript) {
    [IO.File]::WriteAllText($installedTokenPath, $tokenScript, (New-Object Text.UTF8Encoding($false)))
    Protect-PathBestEffort -Path $installedTokenPath
  }
}

$bridgeToken = Get-OrCreateBridgeToken
Sync-InstalledPluginToken -Token $bridgeToken

function Test-PortOpen {
  param([int]$Port)
  try {
    $client = New-Object Net.Sockets.TcpClient
    $connect = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $success = $connect.AsyncWaitHandle.WaitOne(250, $false)
    if ($success) { $client.EndConnect($connect); $client.Close(); return $true }
    $client.Close()
    return $false
  } catch { return $false }
}

function Get-ProxyHealth {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -Headers @{ "X-PS-Agent-Token" = $bridgeToken } -TimeoutSec 2
  } catch { return $null }
}

function Test-ProxyCompatible {
  param($Health)
  return [bool]($Health -and $Health.ok -and $Health.proxy -eq "photoshop-assistant" `
    -and $Health.bridgeVersion -eq $requiredBridgeVersion `
    -and $Health.bridgeBuild.serverSha256 -eq $expectedServerHash `
    -and $Health.bridgeBuild.providerSha256 -eq $expectedProviderHash)
}

function Wait-ProxyCompatible {
  param([int]$TimeoutSeconds = 15)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $candidate = Get-ProxyHealth
    if (Test-ProxyCompatible -Health $candidate) { return $candidate }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Get-ListeningProcessId {
  param([int]$Port)
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { return [int]$listener.OwningProcess }
  $netstat = Join-Path $env:SystemRoot "System32\netstat.exe"
  if (Test-Path -LiteralPath $netstat) {
    $pattern = "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
    foreach ($line in (& $netstat -ano -p tcp)) {
      if ($line -match $pattern) { return [int]$Matches[1] }
    }
  }
  return $null
}

function Stop-StaleAssistantProxy {
  param($Health)
  if (-not $Health -or $Health.proxy -ne "photoshop-assistant") {
    throw "Port $port is occupied by a service that could not be authenticated as Photoshop Assistant; refusing to stop it."
  }
  $processId = Get-ListeningProcessId -Port $port
  if (-not $processId) { throw "The old Photoshop Assistant listener could not be identified." }
  Stop-Process -Id $processId -Force -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(5)
  while ((Test-PortOpen -Port $port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Test-PortOpen -Port $port) { throw "The old Photoshop Assistant process did not release port $port." }
}

function Find-NodeExecutable {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command -and (Test-Path -LiteralPath $command.Source)) { return $command.Source }
  throw "Node.js was not found. The Photoshop Assistant bridge cannot start."
}

function Start-AssistantProxy {
  param([string]$Node, [string]$WorkingDirectory, [string]$StandardOutput, [string]$StandardError)
  $serverScript = Join-Path $WorkingDirectory "server.js"
  if (-not (Test-Path -LiteralPath $serverScript)) { throw "Photoshop Assistant server.js was not found: $serverScript" }
  $pathEntries = @([Environment]::GetEnvironmentVariables("Process").GetEnumerator() | Where-Object { $_.Key -ieq "Path" })
  if ($pathEntries.Count -gt 1) {
    $pathValue = [string]$env:Path
    [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
    [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
  }
  $previousBridgeToken = [Environment]::GetEnvironmentVariable("PS_AGENT_BRIDGE_TOKEN", "Process")
  $previousRuntimeDirectory = [Environment]::GetEnvironmentVariable("PS_AGENT_RUNTIME_DIR", "Process")
  try {
    [Environment]::SetEnvironmentVariable("PS_AGENT_BRIDGE_TOKEN", $bridgeToken, "Process")
    [Environment]::SetEnvironmentVariable("PS_AGENT_RUNTIME_DIR", $RuntimeDirectory, "Process")
    $quotedServerScript = '"' + $serverScript.Replace('"', '\"') + '"'
    $process = Start-Process -FilePath $Node -ArgumentList $quotedServerScript -WorkingDirectory $WorkingDirectory `
      -WindowStyle Hidden -RedirectStandardOutput $StandardOutput -RedirectStandardError $StandardError -PassThru
  } finally {
    [Environment]::SetEnvironmentVariable("PS_AGENT_BRIDGE_TOKEN", $previousBridgeToken, "Process")
    [Environment]::SetEnvironmentVariable("PS_AGENT_RUNTIME_DIR", $previousRuntimeDirectory, "Process")
  }
  if (-not $process -or $process.HasExited) { throw "Unable to start the Photoshop Assistant bridge." }
  return $process
}

function Find-Photoshop {
  $years = 2026, 2025, 2024, 2023, 2022, 2021
  $shell = New-Object -ComObject WScript.Shell
  foreach ($year in $years) {
    foreach ($base in @($env:ProgramData, $env:APPDATA)) {
      $shortcut = Join-Path $base "Microsoft\Windows\Start Menu\Programs\Adobe Photoshop $year.lnk"
      if (Test-Path -LiteralPath $shortcut) {
        $target = $shell.CreateShortcut($shortcut).TargetPath
        if ($target -and (Test-Path -LiteralPath $target)) { return $target }
      }
    }
  }
  foreach ($year in $years) {
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
      if (-not $base) { continue }
      $candidate = Join-Path $base "Adobe\Adobe Photoshop $year\Photoshop.exe"
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
  }
  $command = Get-Command Photoshop.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

$health = Get-ProxyHealth
if ($RestartProxy -and (Test-PortOpen -Port $port)) {
  Stop-StaleAssistantProxy -Health $health
  $health = $null
}
if ((Test-PortOpen -Port $port) -and -not (Test-ProxyCompatible -Health $health)) {
  Stop-StaleAssistantProxy -Health $health
  $health = $null
}

if (-not (Test-ProxyCompatible -Health $health)) {
  New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
  $node = Find-NodeExecutable
  $logStem = if ($port -eq 17861) { "server" } else { "server-$port" }
  $null = Start-AssistantProxy -Node $node -WorkingDirectory $pluginRoot `
    -StandardOutput (Join-Path $RuntimeDirectory "$logStem.log") `
    -StandardError (Join-Path $RuntimeDirectory "$logStem-error.log")
  $health = Wait-ProxyCompatible -TimeoutSeconds 15
  if (-not (Test-ProxyCompatible -Health $health)) { throw "Photoshop Assistant v$requiredBridgeVersion bridge failed to start on port $port." }
}

if ($ProxyOnly) { exit 0 }

$photoshop = Find-Photoshop
if (-not $photoshop) {
  Write-Warning "Photoshop.exe was not found in common install paths. Start Photoshop manually."
  exit 0
}
Start-Process -FilePath $photoshop
