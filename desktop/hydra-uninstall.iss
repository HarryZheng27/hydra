// Included just before the pinned CurUninstallStepChanged, whose first
// statement calls HydraUninstallCleanup. Uninstalling removes what connecting
// Hydra wrote into Claude Code's and Codex's user settings, so neither keeps
// starting a Hydra that is gone, and, only when asked, Hydra's own data.
var
  HydraRemoveData: Boolean;

// Only a real folder is removed: a junction or symbolic link could lead
// anywhere, so it is refused rather than followed.
function HydraRealDirectory(Path: String): Boolean;
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

// Base must be a known, existing folder: an unset variable must never turn
// Name into a path at the root of a drive.
procedure HydraRemoveDataFolder(Base, Name: String);
var
  Path: String;
begin
  if (Base = '') or not DirExists(Base) then Exit;
  Path := AddBackslash(RemoveBackslashUnlessRoot(Base)) + Name;
  if not DirExists(Path) then Exit;
  if not HydraRealDirectory(Path) then begin
    Log('Hydra: not removing ' + Path + ' because it is a link, not a folder.');
    Exit;
  end;
  if DelTree(Path, True, True, True) then
    Log('Hydra: removed ' + Path)
  else
    Log('Hydra: could not remove all of ' + Path);
end;

// Interactive uninstall asks (default No); a silent one removes data only
// when told to with /HYDRAREMOVEDATA.
function HydraRemoveDataWanted(): Boolean;
begin
  if UninstallSilent() then
    Result := HydraHasExactSwitch('/HYDRAREMOVEDATA')
  else
    Result := MsgBox('Also remove your Hydra settings, history and extensions? Your projects and your Claude and Codex sign-ins are never touched.',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
end;

// dist/hydra-uninstall.cjs removes only this installation's entries from
// Claude Code's and Codex's settings. It runs with Hydra's own executable as
// Node (Exec can't set environment variables, so cmd sets
// ELECTRON_RUN_AS_NODE), logs to %TEMP%\hydra-uninstall.log, always exits 0 and
// stops itself after 20 seconds. Any failure here leaves the uninstall going.
procedure HydraRunCleanup();
var
  App, Base, Exe, Script, Params: String;
  ResultCode: Integer;
begin
  App := RemoveBackslashUnlessRoot(ExpandConstant('{app}'));
  Base := App;
  if '{#VersionedResourcesFolder}' <> '' then
    Base := AddBackslash(Base) + '{#VersionedResourcesFolder}';
  Exe := AddBackslash(App) + '{#ExeBasename}.exe';
  Script := AddBackslash(Base) + 'resources\app\extensions\hydra-agent-manager\dist\hydra-uninstall.cjs';
  if not FileExists(Exe) or not FileExists(Script) then begin
    Log('Hydra: uninstall cleanup not found; Claude Code and Codex settings left as they are.');
    Exit;
  end;
  Params := '/d /c set "ELECTRON_RUN_AS_NODE=1" && "' + Exe + '" "' + Script + '" --app "' + App + '"';
  if Exec(ExpandConstant('{cmd}'), Params, GetTempDir(), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log('Hydra: uninstall cleanup finished (' + IntToStr(ResultCode) + ')')
  else
    Log('Hydra: uninstall cleanup could not start: ' + SysErrorMessage(ResultCode));
end;

procedure HydraUninstallCleanup(CurUninstallStep: TUninstallStep);
begin
  // The updater never runs the uninstaller; this only guarantees an update
  // can't take anyone's settings or data with it.
  if IsBackgroundUpdate() or IsHydraUpdate() then Exit;
  if CurUninstallStep = usUninstall then begin
    // Before any file is removed: the cleanup runs from the installed files.
    HydraRemoveData := HydraRemoveDataWanted();
    HydraRunCleanup();
  end else if CurUninstallStep = usPostUninstall then begin
    // Each install writes a fresh uninstall log (UninstallLogMode=overwrite), which records only folders that
    // install created, so after an update the install folder itself isn't in it. RemoveDir removes only an
    // empty folder: anything left in it stays.
    if RemoveDir(ExpandConstant('{app}')) then Log('Hydra: removed the empty install folder');
    if HydraRemoveData then begin
      // Exactly these two folders, never anything beside them (VS Code's, Cursor's).
      HydraRemoveDataFolder(ExpandConstant('{userappdata}'), 'Hydra');
      HydraRemoveDataFolder(GetEnv('USERPROFILE'), '.hydra');
    end;
  end;
end;
