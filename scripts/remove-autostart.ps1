# Stops the bot and removes it from Task Scheduler.
# Run: powershell -ExecutionPolicy Bypass -File scripts\remove-autostart.ps1
$TaskName = 'WhatsApp Task Bot'
$Root = Split-Path $PSScriptRoot -Parent
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed task '$TaskName'."
} else {
  Write-Host "Task '$TaskName' is not registered."
}
# Stopping the task ends conhost only, so stop this project's node process too.
# Find it by its full path, and by the dashboard port (a copy started by hand
# with a short path has no full path in its command line).
$Port = 4780
$Cfg = Join-Path $Root 'config.json'
if (Test-Path $Cfg) {
  $p = (Get-Content $Cfg -Raw | ConvertFrom-Json).dashboardPort
  if ($p) { $Port = $p }
}
$ids = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$Root\src\main.js*" } | ForEach-Object { $_.ProcessId })
$ids += @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { $_.OwningProcess } |
  Where-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName -eq 'node' })
foreach ($id in ($ids | Sort-Object -Unique)) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped bot process $id."
}
