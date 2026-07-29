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
& node.exe "apps\agent\dist\main.js" *>> $LogPath
exit $LASTEXITCODE

