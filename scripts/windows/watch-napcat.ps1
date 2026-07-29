[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StartScript,
  [Parameter(Mandatory = $true)][int]$OneBotPort,
  [string]$LogPath = ""
)

$ErrorActionPreference = "Continue"
$StartScript = [System.IO.Path]::GetFullPath($StartScript)
if (-not (Test-Path -LiteralPath $StartScript)) {
  throw "NapCat 启动脚本不存在：$StartScript"
}
if (-not $LogPath) {
  $LogPath = Join-Path (Split-Path -Parent $StartScript) "napcat-watchdog-$OneBotPort.log"
}
$nextLaunchAt = [DateTime]::MinValue

function Write-WatchLog([string]$Message) {
  if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 5MB) {
    Move-Item -LiteralPath $LogPath -Destination "$LogPath.previous" -Force
  }
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value (
    "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  )
}

Write-WatchLog "watchdog started; OneBot port=$OneBotPort"
while ($true) {
  $listening = $null -ne (Get-NetTCPConnection -State Listen -LocalPort $OneBotPort -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $listening -and (Get-Date) -ge $nextLaunchAt) {
    Write-WatchLog "port $OneBotPort is down; launching $StartScript"
    try {
      $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`""
      Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden | Out-Null
    } catch {
      Write-WatchLog "launch failed: $($_.Exception.Message)"
    }
    $nextLaunchAt = (Get-Date).AddMinutes(1)
  }
  Start-Sleep -Seconds 10
}
