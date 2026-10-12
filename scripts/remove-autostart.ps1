# Stops the bot and removes it from Task Scheduler.
# Run: powershell -ExecutionPolicy Bypass -File scripts\remove-autostart.ps1 [-StopOnly]
# -StopOnly stops the bot but keeps the task (the installer uses it before an update).
param([switch]$StopOnly)
$TaskName = 'WhatsApp Task Bot'
$Root = Split-Path $PSScriptRoot -Parent
$Installed = Test-Path (Join-Path $Root '.installed')
$Main = "$Root\src\main.js"

# Only the task that starts this copy. Another copy can use the same task name.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$ours = $task -and (@($task.Actions | Where-Object { $_.Arguments -like "*$Main*" }).Count -gt 0)
if ($ours) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $StopOnly) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task '$TaskName'."
  }
} elseif ($task) {
  Write-Host "Task '$TaskName' starts another copy of the bot. It stays."
} else {
  Write-Host "Task '$TaskName' is not registered."
}

# Stopping the task ends conhost only, so stop this copy's node process too.
# Windows can show the same path in short (8.3) or long form, so compare short forms.
$fso = New-Object -ComObject Scripting.FileSystemObject
function Short([string]$p) { try { $fso.GetFile($p).ShortPath } catch { $p } }
$OurNode = Short "$Root\node\node.exe"
$OurMain = Short $Main
$ids = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$Main*" -or $_.CommandLine -like "*$OurMain*" -or ($Installed -and $_.ExecutablePath -and (Short $_.ExecutablePath) -eq $OurNode) } |
  ForEach-Object { $_.ProcessId })
# A developer copy started by hand with a short path has no full path in its
# command line: find it by the dashboard port. Not for the installed app, because
# that port can belong to another copy.
if (-not $Installed) {
  $Port = 4780
  $Cfg = Join-Path $Root 'config.json'
  if (Test-Path $Cfg) {
    $p = (Get-Content $Cfg -Raw | ConvertFrom-Json).dashboardPort
    if ($p) { $Port = $p }
  }
  $ids += @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { $_.OwningProcess } |
    Where-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName -eq 'node' })
}
foreach ($id in ($ids | Sort-Object -Unique)) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped bot process $id."
}
