[CmdletBinding()]
param(
  [string]$StartScript = "C:\NapCat\start-bot1.ps1",
  [int]$OneBotPort = 3001,
  [string]$TaskName = "PuffNapCatBot1"
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "请使用管理员 PowerShell 运行此脚本。"
}

$StartScript = [System.IO.Path]::GetFullPath($StartScript)
if (-not (Test-Path -LiteralPath $StartScript)) {
  throw "NapCat 启动脚本不存在：$StartScript"
}
$watchScript = Join-Path $PSScriptRoot "watch-napcat.ps1"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$watchScript`" -StartScript `"$StartScript`" -OneBotPort $OneBotPort"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory (Split-Path -Parent $StartScript)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$task = Get-ScheduledTask -TaskName $TaskName
$portReady = $null -ne (Get-NetTCPConnection -State Listen -LocalPort $OneBotPort -ErrorAction SilentlyContinue | Select-Object -First 1)
[pscustomobject]@{
  TaskName = $TaskName
  State = $task.State
  StartScript = $StartScript
  OneBotPort = $OneBotPort
  PortListening = $portReady
} | Format-List
