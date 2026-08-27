$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$script = Join-Path $pluginRoot "Start-PhotoshopAgentV98.ps1"
$shell = New-Object -ComObject WScript.Shell

function Write-AssistantShortcut {
  param(
    [string]$Path,
    [string]$Arguments
  )
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $target
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $pluginRoot
  $shortcut.IconLocation = $target
  $shortcut.WindowStyle = 7
  $shortcut.Save()
}

$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Photoshop Assistant v9.8.lnk"
$startupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "Photoshop Assistant v9.8 Service.lnk"

Write-AssistantShortcut -Path $desktopShortcut `
  -Arguments "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
Write-AssistantShortcut -Path $startupShortcut `
  -Arguments "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -ProxyOnly"

Write-Host "Created Photoshop launcher: $desktopShortcut"
Write-Host "Registered assistant service at Windows sign-in: $startupShortcut"
