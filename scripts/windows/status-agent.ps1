[CmdletBinding()]
param([string]$TaskName = "PuffQQBotAgent")

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$info = Get-ScheduledTaskInfo -TaskName $TaskName
$processes = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*apps\agent\dist\main.js*' }
[pscustomobject]@{
  TaskName = $TaskName
  State = $task.State
  LastRunTime = $info.LastRunTime
  LastTaskResult = $info.LastTaskResult
  AgentProcesses = ($processes | Measure-Object).Count
  Healthy = ($task.State -eq 'Running' -and ($processes | Measure-Object).Count -eq 1)
} | Format-List

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$log = Join-Path $RepoRoot "data\agent-logs\agent.log"
if (Test-Path $log) { Get-Content -LiteralPath $log -Tail 30 }

