# Registers the bot in Task Scheduler: start at log on, no console window.
# Run: powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 [-StartNow] [-Node <path to node.exe>]
param([switch]$StartNow, [string]$Node)
$ErrorActionPreference = 'Stop'

$TaskName = 'WhatsApp Task Bot'
$Root = Split-Path $PSScriptRoot -Parent
# The installed app brings its own node.exe. A developer copy uses the one on PATH.
if (-not $Node) {
  $Bundled = Join-Path $Root 'node\node.exe'
  $Node = if (Test-Path $Bundled) { $Bundled } else { (Get-Command node.exe).Source }
}
$User = "$env:USERDOMAIN\$env:USERNAME"

# conhost --headless runs node with no window. No VBScript (removed from new Windows 11 builds).
$Action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
  -Argument "--headless `"$Node`" `"$Root\src\main.js`" --background" -WorkingDirectory $Root
$Logon = New-ScheduledTaskTrigger -AtLogOn -User $User
# conhost always exits with code 0, so "restart on failure" never fires after a crash.
# A second trigger repeats every 5 minutes, forever: if the bot runs, the start is
# ignored (one copy only); if the bot stopped, it starts again.
$Watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$Trigger = @($Logon, $Watch)
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
# No time limit (the default stops a task after 3 days). One copy only.
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal `
  -Settings $Settings -Description 'Read-only WhatsApp task bot.' -Force | Out-Null
Write-Host "Registered task '$TaskName'. It starts at your next log on."

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host 'Started now.'
}
