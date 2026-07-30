[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ConfigPath)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$LogDir = Join-Path $RepoRoot "data\agent-logs"
$LogPath = Join-Path $LogDir "agent.log"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 20MB) {
  $old = Join-Path $LogDir "agent.previous.log"
  Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $LogPath -Destination $old
}
$env:PUFF_AGENT_CONFIG = [System.IO.Path]::GetFullPath($ConfigPath)
Set-Location $RepoRoot
$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$EntryPoint = Join-Path $RepoRoot "apps\agent\dist\main.js"
$DelaySeconds = 2

while ($true) {
  $StartedAt = Get-Date
  (
    "[{0}] supervisor starting agent" -f $StartedAt.ToString("yyyy-MM-dd HH:mm:ss")
  ) | Out-File -LiteralPath $LogPath -Append
  try {
    & $NodePath $EntryPoint *>> $LogPath
    $ExitCode = if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE }
  } catch {
    $ExitCode = 1
    ($_ | Out-String) | Out-File -LiteralPath $LogPath -Append
  }

  if ($ExitCode -eq 75) {
    $PendingUpdate = Join-Path $RepoRoot "data\pending-agent-update.json"
    $UpdateScript = Join-Path $RepoRoot "scripts\windows\update-agent.ps1"
    if ((Test-Path -LiteralPath $PendingUpdate) -and (Test-Path -LiteralPath $UpdateScript)) {
      try {
        "[{0}] applying queued agent update" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss") |
          Out-File -LiteralPath $LogPath -Append
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $UpdateScript `
          -PendingPath $PendingUpdate -ConfigPath $ConfigPath *>> $LogPath
        if ($LASTEXITCODE -ne 0) {
          throw "Agent update process exited with code $LASTEXITCODE."
        }
        $ExitCode = 0
      } catch {
        ($_ | Out-String) | Out-File -LiteralPath $LogPath -Append
        $ExitCode = 1
      }
    }
  }

  $RuntimeSeconds = [Math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 1)
  (
    "[{0}] agent stopped: exit={1}, runtime={2}s; restarting in {3}s" -f `
      (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $ExitCode, $RuntimeSeconds, $DelaySeconds
  ) | Out-File -LiteralPath $LogPath -Append
  Start-Sleep -Seconds $DelaySeconds
  if ($RuntimeSeconds -ge 60) {
    $DelaySeconds = 2
  } else {
    $DelaySeconds = [Math]::Min(30, $DelaySeconds * 2)
  }
}

