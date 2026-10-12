# Builds the Windows installer: dist\WhatsApp-Task-Bot-Setup-<version>.exe
# Needs Inno Setup 6. Run: powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
param([string]$Iscc)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# The bundled Node.js runtime. Change it only together with a full test.
$NodeVersion = 'v24.13.0'
$Root = Split-Path $PSScriptRoot -Parent
$Build = Join-Path $Root 'build'
$App = Join-Path $Build 'app'
$Cache = Join-Path $Build 'cache'
$Version = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version

if (-not $Iscc) {
  $Iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Iscc) { throw 'Inno Setup 6 is not installed. Install it: winget install JRSoftware.InnoSetup' }

# 1. Program files only. No personal files: config.json, .env, keys, data, and logs stay out.
if (Test-Path $App) { Remove-Item $App -Recurse -Force }
New-Item -ItemType Directory -Force $App, $Cache | Out-Null
foreach ($d in 'src', 'assets') { Copy-Item (Join-Path $Root $d) $App -Recurse }
New-Item -ItemType Directory -Force (Join-Path $App 'scripts') | Out-Null
foreach ($f in 'install-autostart.ps1', 'remove-autostart.ps1', 'make-shortcut.ps1') { Copy-Item (Join-Path $Root "scripts\$f") (Join-Path $App 'scripts') }
foreach ($f in 'package.json', 'package-lock.json', '.npmrc', 'LICENSE', 'README.md', 'SECURITY.md') { Copy-Item (Join-Path $Root $f) $App }
# This file tells the app that it is installed: personal files go to %LOCALAPPDATA%.
Set-Content -Path (Join-Path $App '.installed') -Value $Version -Encoding ascii

# 2. Production dependencies, exactly as in the lock file. .npmrc blocks install scripts.
Push-Location $App
try {
  npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
} finally { Pop-Location }

# 3. Node.js runtime, checked against the official SHA-256 list.
$Zip = "node-$NodeVersion-win-x64.zip"
$ZipPath = Join-Path $Cache $Zip
if (-not (Test-Path $ZipPath)) {
  Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$Zip" -OutFile $ZipPath
}
$Sums = (Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
$Want = ($Sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($Zip))$" }) -replace '\s.*$', ''
$Have = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
if (-not $Want -or $Have -ne $Want.Trim().ToLower()) { Remove-Item $ZipPath; throw "Checksum mismatch for $Zip" }
$Unzip = Join-Path $Cache "node-$NodeVersion"
if (-not (Test-Path $Unzip)) { Expand-Archive $ZipPath $Cache -Force; Rename-Item (Join-Path $Cache "node-$NodeVersion-win-x64") $Unzip }
New-Item -ItemType Directory -Force (Join-Path $App 'node') | Out-Null
Copy-Item (Join-Path $Unzip 'node.exe') (Join-Path $App 'node')
Copy-Item (Join-Path $Unzip 'LICENSE') (Join-Path $App 'node\LICENSE')

# 4. Smoke test: the bundled runtime loads the native SQLite module.
Push-Location $App
try { & '.\node\node.exe' -e "const D=require('better-sqlite3');new D(':memory:').prepare('select 1').get();console.log('sqlite ok')" } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'The bundled Node.js cannot load better-sqlite3' }

# 5. The installer.
& $Iscc "/DAppVersion=$Version" (Join-Path $Root 'installer\whatsapp-task-bot.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed' }
Get-Item (Join-Path $Root "dist\WhatsApp-Task-Bot-Setup-$Version.exe")
