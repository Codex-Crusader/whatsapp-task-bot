# Puts the app shortcut (the launcher, with no console window) on the desktop.
# The installed app runs this from the Setup page. Run: powershell -File scripts\make-shortcut.ps1 -Path <file.lnk>
param([Parameter(Mandatory)][string]$Path)
$Root = Split-Path $PSScriptRoot -Parent
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($Path)
$s.TargetPath = "$env:WINDIR\System32\conhost.exe"
$s.Arguments = "--headless `"$Root\node\node.exe`" `"$Root\src\launcher.js`""
$s.WorkingDirectory = $Root
$s.IconLocation = "$Root\assets\icon.ico,0"
$s.Description = 'Open WhatsApp Task Bot'
$s.Save()
