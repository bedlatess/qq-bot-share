[CmdletBinding()]
param([string]$TaskName = "PuffQQBotAgent")

$ErrorActionPreference = "Stop"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Write-Host "Agent 计划任务已卸载。源码、配置和日志已保留。"

