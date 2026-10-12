; Inno Setup script. Build it with scripts\build-installer.ps1, not by hand:
; the script stages the files in build\app first.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "WhatsApp Task Bot"
#define AppPublisher "Bhargavaram Krishnapur"
#define AppUrl "https://github.com/Codex-Crusader/whatsapp-task-bot"
#define Launch '--headless ""{app}\node\node.exe"" ""{app}\src\launcher.js""'

[Setup]
AppId={{6F1C2E4B-8A73-4D2B-9C5E-3B7A1D0E9F42}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
; Per user: no administrator rights, no UAC prompt.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
LicenseFile=..\LICENSE
; Shown during installation: what the program sends where.
InfoBeforeFile=privacy.txt
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\assets\icon.ico
UninstallDisplayName={#AppName}
; File details that the code signing service checks.
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
VersionInfoCopyright=Copyright (C) 2026 {#AppPublisher}. GPL-3.0.
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
OutputDir=..\dist
OutputBaseFilename=WhatsApp-Task-Bot-Setup-{#AppVersion}
CloseApplications=no

[Tasks]
Name: "desktopicon"; Description: "Put an icon on the desktop"; GroupDescription: "Icons:"

[Files]
Source: "..\build\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; An update replaces the program files. Your personal files are in another folder.
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\node_modules"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{sys}\conhost.exe"; Parameters: "{#Launch}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"; Comment: "Open WhatsApp Task Bot"
Name: "{autodesktop}\{#AppName}"; Filename: "{sys}\conhost.exe"; Parameters: "{#Launch}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"; Comment: "Open WhatsApp Task Bot"; Tasks: desktopicon

[Run]
Filename: "{sys}\conhost.exe"; Parameters: "{#Launch}"; WorkingDir: "{app}"; Description: "Open WhatsApp Task Bot now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\remove-autostart.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveAutostart"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  DataDir = '{localappdata}\WhatsApp Task Bot';

// Before an update: stop the running bot, so that no program file is in use.
// The task stays registered and starts the new version.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Script: String;
  Code: Integer;
begin
  Result := '';
  Script := ExpandConstant('{app}\scripts\remove-autostart.ps1');
  if FileExists(Script) then
    Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '" -StopOnly', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

// After an update with "Start with Windows" on: start the bot again.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if (CurStep = ssPostInstall) and WizardSilent then
    Exec('schtasks.exe', '/Run /TN "{#AppName}"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

// The uninstaller asks before it deletes the personal files.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Dir: String;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  Dir := ExpandConstant(DataDir);
  if not DirExists(Dir) then Exit;
  if UninstallSilent then Exit;
  if MsgBox('Also delete your personal data?' + #13#10#13#10 +
            'This deletes the WhatsApp link, your tasks, reports, settings, and keys in:' + #13#10 + Dir + #13#10#13#10 +
            'Click No to keep them for a new install.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    DelTree(Dir, True, True, True);
end;
