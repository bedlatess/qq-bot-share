[CmdletBinding()]
param([string]$TaskName = "PuffQQBotAgent")

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  TaskName = $TaskName
  State = $task.State
  LastRunTime = $info.LastRunTime
  LastTaskResult = $info.LastTaskResult
  AgentProcesses = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*apps\agent\dist\main.js*' } | Measure-Object).Count
} | Format-List

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$log = Join-Path $RepoRoot "data\agent-logs\agent.log"
if (Test-Path $log) { Get-Content -LiteralPath $log -Tail 30 }

