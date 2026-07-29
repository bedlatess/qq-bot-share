[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [string]$TaskName = "PuffQQBotAgent"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $ConfigPath) { $ConfigPath = Join-Path $RepoRoot "apps\agent\agent.config.json" }
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)

function Ensure-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "请使用管理员 PowerShell 运行此脚本。"
  }
}

function Ensure-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $major = [int]((& node --version).TrimStart('v').Split('.')[0])
    if ($major -ge 20) { return }
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $versions = Invoke-RestMethod "https://nodejs.org/dist/index.json"
  $release = $versions | Where-Object { $_.lts -and ([int]$_.version.TrimStart('v').Split('.')[0] -ge 22) } | Select-Object -First 1
  if (-not $release) { throw "未找到可用的 Node.js LTS 版本。" }
  $msiName = "node-$($release.version)-x64.msi"
  $msiPath = Join-Path $env:TEMP $msiName
  Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/$msiName" -OutFile $msiPath
  $process = Start-Process msiexec.exe -ArgumentList @('/i', $msiPath, '/qn', '/norestart') -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "Node.js 安装失败，退出码 $($process.ExitCode)。" }
  $env:Path = "${env:ProgramFiles}\nodejs;$env:Path"
}

Ensure-Administrator
Ensure-Node
Set-Location $RepoRoot
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw "npm ci 失败。" }
& npm.cmd run build --workspace=@puff/shared
if ($LASTEXITCODE -ne 0) { throw "shared 构建失败。" }
& npm.cmd run build --workspace=@puff/agent
if ($LASTEXITCODE -ne 0) { throw "agent 构建失败。" }

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "apps\agent\agent.config.example.json") -Destination $ConfigPath
  throw "已生成配置模板：$ConfigPath。填入控制台生成的 nodeId、nodeToken 和机器人信息后重新运行。"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.nodeId -like '*replace*' -or $config.nodeToken -like '*replace*') {
  throw "Agent 配置仍是模板值：$ConfigPath"
}

$startScript = Join-Path $PSScriptRoot "start-agent.ps1"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -ConfigPath `"$ConfigPath`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
Write-Host "Agent 已安装并启动。任务：$TaskName；配置：$ConfigPath"
Get-ScheduledTaskInfo -TaskName $TaskName | Format-List LastRunTime,LastTaskResult,NextRunTime

