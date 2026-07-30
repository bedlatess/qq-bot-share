[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PendingPath,
  [Parameter(Mandatory = $true)][string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$DataRoot = Join-Path $RepoRoot "data"
$Archive = Join-Path $DataRoot "agent-update.tar.gz"
$Staging = Join-Path $DataRoot "agent-update-staging"
$Backup = Join-Path $DataRoot "agent-update-backup"
$StatusPath = Join-Path $DataRoot "agent-update-status.json"

foreach ($Path in @($PendingPath, $ConfigPath)) {
  $FullPath = [System.IO.Path]::GetFullPath($Path)
  if (-not $FullPath.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Update path is outside Puff root: $FullPath"
  }
}

$Manifest = Get-Content -LiteralPath $PendingPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Manifest.url -or -not $Manifest.sha256) { throw "Invalid update manifest." }

function Write-UpdateStatus {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("current", "failed")][string]$State,
    [string]$ErrorMessage = ""
  )
  $Payload = @{
    state = $State
    targetVersion = [string]$Manifest.version
    at = [DateTime]::UtcNow.ToString("o")
  }
  if ($ErrorMessage) { $Payload.error = $ErrorMessage.Substring(0, [Math]::Min(500, $ErrorMessage.Length)) }
  $Json = $Payload | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($StatusPath, $Json, [Text.UTF8Encoding]::new($false))
}

trap {
  Write-UpdateStatus -State "failed" -ErrorMessage ($_ | Out-String).Trim()
  throw $_
}

New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $Backup -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Staging -Force | Out-Null
New-Item -ItemType Directory -Path $Backup -Force | Out-Null

Invoke-WebRequest -UseBasicParsing -Uri ([string]$Manifest.url) `
  -Headers @{ Authorization = "Bearer $($Config.nodeToken)" } `
  -TimeoutSec 120 -OutFile $Archive
$ActualHash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualHash -ne ([string]$Manifest.sha256).ToLowerInvariant()) {
  throw "Agent update SHA-256 mismatch."
}

& tar.exe -xzf $Archive -C $Staging
if ($LASTEXITCODE -ne 0) { throw "Failed to extract agent update." }

$Targets = @(
  "apps\agent\dist",
  "apps\agent\src",
  "apps\agent\tsconfig.json",
  "apps\agent\agent.config.example.json",
  "packages\shared\dist",
  "packages\shared\src",
  "packages\shared\tsconfig.json",
  "scripts\windows",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "apps\agent\package.json",
  "packages\shared\package.json"
)

function Copy-UpdateTarget {
  param([string]$Source, [string]$Destination)
  if ((Get-Item -LiteralPath $Source).PSIsContainer) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
  } else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
  }
}

try {
  foreach ($Relative in $Targets) {
    $Current = Join-Path $RepoRoot $Relative
    if (Test-Path -LiteralPath $Current) {
      $BackupTarget = Join-Path $Backup $Relative
      Copy-UpdateTarget -Source $Current -Destination $BackupTarget
    }
  }
  foreach ($Relative in $Targets) {
    $Source = Join-Path $Staging $Relative
    if (-not (Test-Path -LiteralPath $Source)) { throw "Update bundle missing $Relative" }
    $Destination = Join-Path $RepoRoot $Relative
    Copy-UpdateTarget -Source $Source -Destination $Destination
  }
  Set-Content -LiteralPath (Join-Path $DataRoot "agent-version.txt") `
    -Value ([string]$Manifest.version) -Encoding UTF8
  Write-UpdateStatus -State "current"
  Remove-Item -LiteralPath $PendingPath -Force
  Write-Host "Agent updated to $($Manifest.version)."
} catch {
  foreach ($Relative in $Targets) {
    $Saved = Join-Path $Backup $Relative
    if (Test-Path -LiteralPath $Saved) {
      $Destination = Join-Path $RepoRoot $Relative
      Copy-UpdateTarget -Source $Saved -Destination $Destination
    }
  }
  throw
} finally {
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
}
