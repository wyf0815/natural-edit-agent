param(
  [string]$ModelsDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) "models\mobilesam"),
  [switch]$AllowUnverifiedModels
)

$ErrorActionPreference = "Stop"
$required = @{
  "mobile_sam_image_encoder.onnx" = @{
    Length = 28157093
    Sha256 = "580F5FB648EA1062C0AABC26217AED56921985F03F0CBBD852BBA81D760CC749"
  }
  "sam_mask_decoder_single.onnx" = @{
    Length = 16501323
    Sha256 = "93915FC7C993AB9D59AB8C9CCD3BCE37F7509C81AB4150A74ABD4D2ABBD8570D"
  }
}

$missing = @()
$mismatched = @()
foreach ($name in ($required.Keys | Sort-Object)) {
  $file = Join-Path $ModelsDirectory $name
  if (-not (Test-Path -LiteralPath $file)) {
    $missing += $file
    continue
  }
  $item = Get-Item -LiteralPath $file
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  Write-Host "$name`t$($item.Length) bytes`tSHA256 $hash"
  $expected = $required[$name]
  if ($item.Length -ne $expected.Length -or $hash -ne $expected.Sha256) {
    $mismatched += "$file`n  expected $($expected.Length) bytes / $($expected.Sha256)`n  actual   $($item.Length) bytes / $hash"
  }
}

if ($missing.Count -gt 0) {
  Write-Error ("MobileSAM model files are missing:`n" + ($missing -join "`n"))
  exit 1
}

if ($mismatched.Count -gt 0) {
  $details = "MobileSAM model integrity verification failed:`n" + ($mismatched -join "`n")
  if (-not $AllowUnverifiedModels) {
    Write-Error "$details`nUse -AllowUnverifiedModels only for an intentional local experiment; v9.8 remains fail-closed by default."
    exit 1
  }
  Write-Warning "$details`nContinuing only because -AllowUnverifiedModels was explicitly supplied."
}

if ($mismatched.Count -eq 0) {
  Write-Host "MobileSAM model files match the approved v9.8 baseline."
} else {
  Write-Warning "Unverified MobileSAM files were accepted for this local run only."
}
Write-Host "Run npm run test:v98:bridge:strict for the model-backed bridge check."
