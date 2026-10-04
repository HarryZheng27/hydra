// The Hydra app's Windows installer: a per-user install with no admin prompt.
// app/scripts/package.mjs compiles it with these definitions:
//   Version, RawVersion  the app's release version (x.y.z, stable only)
//   SourceDir            the packaged app (Hydra.exe, resources\app.asar, ...)
//   OutputDir            where HydraAppSetup.exe goes
//   SetupIcon            the Hydra icon (.ico)
// It shares nothing with the IDE's installer (desktop/ and the pinned code.iss)
// except two of its includes: the /HYDRAUPDATE switch and install checks
// (hydra-update-mode.iss) and the wizard's tasks-list fix (hydra-wizard.iss).

#ifndef Version
  #error Version must be defined
#endif

// The app's own identity. The IDE's user AppId is {4C372D32-...} and its
// AppUserModelId Hydra.IDE; these must never match them.
#define AppId "{{F4C65ADB-835D-4926-B2F2-4C78F6967279}"
// Reserved for a system-wide app install, which doesn't exist: the shared
// check refuses a per-user install when this is registered.
#define IncompatibleTargetAppId "{{84B2FB6E-18E1-409B-99FC-040E4E7DED1D}"
#define NameLong "Hydra"
#define NameVersion "Hydra App"
#define ExeBasename "Hydra"
#define AppUserId "Hydra.App"
// The IDE's per-user and system registrations, for the data-removal rule.
#define IdeUserAppId "{{4C372D32-54B2-43D8-8C63-ECC31D3744A8}"
#define IdeSystemAppId "{{7B4D72DA-6A0A-41E8-A9DB-9136978BA112}"

[Setup]
AppId={#AppId}
AppName={#NameLong}
AppVerName={#NameVersion}
AppVersion={#Version}
VersionInfoVersion={#RawVersion}
VersionInfoProductName={#NameLong}
VersionInfoDescription=Hydra Setup
AppPublisher=Nico Dunlap
AppPublisherURL=https://github.com/ndunl075/hydra
AppSupportURL=https://github.com/ndunl075/hydra/issues
AppUpdatesURL=https://github.com/ndunl075/hydra/releases
DefaultDirName={userpf}\Hydra App
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=HydraAppSetup
SetupIconFile={#SetupIcon}
UninstallDisplayIcon={app}\{#ExeBasename}.exe
UninstallDisplayName={#NameVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
// Hydra checks for a running app itself (HydraAppInUse); never Restart Manager.
CloseApplications=no
RestartApplications=no
SourceDir={#SourceDir}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
// An update replaces the whole app: nothing an earlier version shipped stays behind.
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\locales"

[Files]
Source: "*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
// "Hydra" is the app's name: the IDE is "Hydra IDE". Neither shortcut replaces
// a Hydra.lnk that opens something else (an IDE from before the rename).
Name: "{autoprograms}\{#NameLong}"; Filename: "{app}\{#ExeBasename}.exe"; AppUserModelID: "{#AppUserId}"; Check: HydraAppMayWriteShortcut(ExpandConstant('{autoprograms}\{#NameLong}.lnk'))
Name: "{autodesktop}\{#NameLong}"; Filename: "{app}\{#ExeBasename}.exe"; AppUserModelID: "{#AppUserId}"; Tasks: desktopicon; Check: HydraAppMayWriteShortcut(ExpandConstant('{autodesktop}\{#NameLong}.lnk'))

[Run]
Filename: "{app}\{#ExeBasename}.exe"; Description: "{cm:LaunchProgram,{#NameLong}}"; Flags: nowait postinstall skipifsilent

[Code]
#include "..\..\desktop\hydra-update-mode.iss"
#include "..\..\desktop\hydra-wizard.iss"
#include "hydra-app-uninstall.iss"

function CreateFileW(FileName: String; Access, ShareMode, Security, Disposition, Flags, Template: Cardinal): Integer;
  external 'CreateFileW@kernel32.dll stdcall';
function CloseHandle(Handle: Integer): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

// True while {app}\Hydra.exe is running: as the app, or as Node for a Claude
// Code or Codex chat using Hydra's tools. Windows refuses write access to a
// running executable, so this asks for it and lets go at once. A virus scan of
// a just-installed file, or the app's crash handler still exiting, holds it for
// a moment too, so only ten seconds of refusals count as running.
function HydraAppInUse(): Boolean;
var
  Exe: String;
  Handle, Attempt, Error: Integer;
begin
  Result := False;
  Exe := ExpandConstant('{app}\{#ExeBasename}.exe');
  if not FileExists(Exe) then Exit;
  for Attempt := 1 to 10 do begin
    // GENERIC_WRITE, no sharing, OPEN_EXISTING.
    Handle := CreateFileW(Exe, $40000000, 0, 0, 3, 0, 0);
    if Handle <> -1 then begin
      CloseHandle(Handle);
      Result := False;
      Exit;
    end;
    Error := DLLGetLastError();
    if Error <> 32 then begin  // not ERROR_SHARING_VIOLATION
      Log('Hydra: could not check ' + Exe + ': ' + SysErrorMessage(Error));
      Result := False;
      Exit;
    end;
    Result := True;
    if Attempt < 10 then Sleep(1000);
  end;
  Log('Hydra: ' + Exe + ' stayed in use for ten seconds.');
end;

function HydraShortcutTarget(Path: String): String;
var
  Shell, Link: Variant;
begin
  Result := '';
  try
    Shell := CreateOleObject('WScript.Shell');
    Link := Shell.CreateShortcut(Path);
    Result := Link.TargetPath;
  except
    Log('Hydra: could not read the shortcut ' + Path + ': ' + GetExceptionMessage());
  end;
end;

// A Hydra.lnk may be written when there is none, or it already opens this app.
function HydraAppMayWriteShortcut(Path: String): Boolean;
begin
  Result := not FileExists(Path) or
    (CompareText(HydraShortcutTarget(Path), ExpandConstant('{app}\{#ExeBasename}.exe')) = 0);
  if not Result then Log('Hydra: leaving ' + Path + ' because it opens something else.');
end;

function InitializeSetup(): Boolean;
begin
  Result := not ((HydraUpdateSwitchState() < 0) or HydraHasSwitch('/UPDATE') or not HydraUpdateArgumentsValid());
  if not Result then Log('Hydra: refusing invalid update arguments.');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := HydraCheckInstall();
  if Result <> '' then Exit;
  if HydraAppInUse() then
    Result := 'Close Hydra, and any Claude Code or Codex chats using Hydra''s tools, then run setup again.';
end;

// Only a deliberate install without the desktop task removes this app's own
// desktop shortcut; an update keeps the choice it was installed with.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Desktop: String;
begin
  if (CurStep <> ssPostInstall) or IsHydraUpdate() or WizardIsTaskSelected('desktopicon') then Exit;
  Desktop := ExpandConstant('{autodesktop}\{#NameLong}.lnk');
  if FileExists(Desktop) and (CompareText(HydraShortcutTarget(Desktop), ExpandConstant('{app}\{#ExeBasename}.exe')) = 0) then
    if DeleteFile(Desktop) then Log('Hydra: removed the desktop shortcut ' + Desktop);
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  if HydraAppInUse() then begin
    if not UninstallSilent() then
      MsgBox('Close Hydra, and any Claude Code or Codex chats using Hydra''s tools, then uninstall again.', mbError, MB_OK);
    Log('Hydra: the app is running; uninstall refused.');
    Result := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  HydraAppUninstallCleanup(CurUninstallStep);
end;
