// Included by hydra-app.iss, after hydra-update-mode.iss. Adapts the IDE's
// desktop/hydra-uninstall.iss to the app: uninstalling removes what this
// install wrote into Claude Code's and Codex's user settings, and, only when
// asked, the app's data.
var
  HydraAppRemoveData: Boolean;

// Only a real folder is removed: a junction or symbolic link could lead
// anywhere, so it is refused rather than followed.
function HydraAppRealDirectory(Path: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := False;
  if FindFirst(Path, FindRec) then begin
    try
      Result := ((FindRec.Attributes and $10) <> 0) and ((FindRec.Attributes and $400) = 0);
    finally
      FindClose(FindRec);
    end;
  end;
end;

// Removes Base\Parts[0]\...\Parts[n-1]. Base must be a known, existing folder,
// and every folder on the way must be a real one, never a link.
procedure HydraAppRemoveDataFolder(Base: String; Parts: array of String);
var
  Path: String;
  I: Integer;
begin
  if (Base = '') or not DirExists(Base) or (GetArrayLength(Parts) = 0) then Exit;
  Path := RemoveBackslashUnlessRoot(Base);
  for I := 0 to GetArrayLength(Parts) - 1 do begin
    Path := AddBackslash(Path) + Parts[I];
    if not DirExists(Path) then Exit;
    if not HydraAppRealDirectory(Path) then begin
      Log('Hydra: not removing data under ' + Path + ' because it is a link, not a folder.');
      Exit;
    end;
  end;
  if DelTree(Path, True, True, True) then
    Log('Hydra: removed ' + Path)
  else
    Log('Hydra: could not remove all of ' + Path);
end;

// The IDE shares one folder with the app: the Hydra extension's global storage
// (heads, plans, ownership, discovery). It goes only when no IDE is installed.
function HydraIdeInstalled(): Boolean;
begin
  Result := RegKeyExists(HKCU64, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + Copy('{#IdeUserAppId}', 2, 38) + '_is1') or
    RegKeyExists(HKLM64, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + Copy('{#IdeSystemAppId}', 2, 38) + '_is1');
end;

// Interactive uninstall asks (default No); a silent one removes data only
// when told to with /HYDRAREMOVEDATA.
function HydraAppRemoveDataWanted(): Boolean;
begin
  if UninstallSilent() then
    Result := HydraHasExactSwitch('/HYDRAREMOVEDATA')
  else
    Result := MsgBox('Also remove Hydra''s settings and chat history? Your projects and your Claude and Codex sign-ins are never touched.',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
end;

// dist/hydra-uninstall.cjs (src/uninstall.ts, the IDE's helper) removes only
// this installation's entries from Claude Code's and Codex's settings. It runs
// from inside app.asar with the app's own executable as Node (Exec can't set
// environment variables, so cmd sets ELECTRON_RUN_AS_NODE), logs to
// %TEMP%\hydra-uninstall.log, always exits 0 and stops itself after 20
// seconds. Any failure here leaves the uninstall going.
procedure HydraAppRunCleanup();
var
  App, Exe, Archive, Params: String;
  ResultCode: Integer;
begin
  App := RemoveBackslashUnlessRoot(ExpandConstant('{app}'));
  Exe := AddBackslash(App) + '{#ExeBasename}.exe';
  Archive := AddBackslash(App) + 'resources\app.asar';
  if not FileExists(Exe) or not FileExists(Archive) then begin
    Log('Hydra: uninstall cleanup not found; Claude Code and Codex settings left as they are.');
    Exit;
  end;
  Params := '/d /c set "ELECTRON_RUN_AS_NODE=1" && "' + Exe + '" "' + Archive + '\dist\hydra-uninstall.cjs" --app "' + App + '"';
  if Exec(ExpandConstant('{cmd}'), Params, GetTempDir(), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log('Hydra: uninstall cleanup finished (' + IntToStr(ResultCode) + ')')
  else
    Log('Hydra: uninstall cleanup could not start: ' + SysErrorMessage(ResultCode));
end;

procedure HydraAppUninstallCleanup(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    // Before any file is removed: the cleanup runs from the installed files.
    HydraAppRemoveData := HydraAppRemoveDataWanted();
    HydraAppRunCleanup();
  end else if (CurUninstallStep = usPostUninstall) and HydraAppRemoveData then begin
    // %APPDATA%\Hydra App, and never the IDE's %APPDATA%\Hydra beside it.
    HydraAppRemoveDataFolder(ExpandConstant('{userappdata}'), ['Hydra App']);
    if HydraIdeInstalled() then
      Log('Hydra: Hydra IDE is installed; its shared Hydra storage is kept.')
    else
      HydraAppRemoveDataFolder(ExpandConstant('{userappdata}'), ['Hydra', 'User', 'globalStorage', 'nico-dunlap.hydra-agent-manager']);
  end;
end;
