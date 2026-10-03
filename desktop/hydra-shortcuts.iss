// Included after hydra-update-mode.iss at the start of the pinned [Code] section.
// The IDE's shortcuts were called "Hydra" until it became "Hydra IDE"; the name
// "Hydra" now belongs to the Hydra app. An upgrade removes the IDE's old
// Hydra.lnk files, and only those: a Hydra.lnk that opens anything else (the
// app's) is left where it is.
//
// The uninstall side is [Setup]'s UninstallLogMode=overwrite (see
// brandedInstaller): each install writes a fresh uninstall log, so a later
// uninstall no longer remembers, or deletes, the old Hydra.lnk paths.
var
  HydraOldGroup: String;

// Called from PrepareToInstall, before this install rewrites the registration:
// the Start Menu folder the installed version used, or '' if there is none.
procedure HydraRememberOldShortcuts();
var
  Key, Group: String;
begin
  HydraOldGroup := '';
  Key := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + Copy('{#AppId}', 2, 38) + '_is1';
  if not RegQueryStringValue(HKCU64, Key, 'Inno Setup: Icon Group', Group) then Exit;
  // A folder name below the Start Menu's Programs, never a path out of it.
  if Group = '' then Exit;
  if (Pos(':', Group) > 0) or (Pos('..', Group) > 0) or (Group[1] = '\') then Exit;
  HydraOldGroup := AddBackslash(ExpandConstant('{autoprograms}')) + Group;
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

// Deletes Path only when it is a shortcut to this installation's Hydra.exe.
procedure HydraRemoveOldShortcut(Path: String);
begin
  if not FileExists(Path) then Exit;
  if CompareText(HydraShortcutTarget(Path), ExpandConstant('{app}\{#ExeBasename}.exe')) <> 0 then begin
    Log('Hydra: leaving ' + Path + ' because it opens something else.');
    Exit;
  end;
  if DeleteFile(Path) then
    Log('Hydra: removed the old shortcut ' + Path)
  else
    Log('Hydra: could not remove the old shortcut ' + Path);
end;

// Called at ssPostInstall, once the "Hydra IDE" shortcuts exist, so a failed
// install never leaves the user with no shortcut at all.
procedure HydraReplaceOldShortcuts();
begin
  HydraRemoveOldShortcut(ExpandConstant('{autodesktop}\Hydra.lnk'));
  HydraRemoveOldShortcut(ExpandConstant('{userappdata}\Microsoft\Internet Explorer\Quick Launch\Hydra.lnk'));
  if HydraOldGroup = '' then Exit;
  HydraRemoveOldShortcut(AddBackslash(HydraOldGroup) + 'Hydra.lnk');
  // The old folder goes only if nothing else is left in it.
  try
    if CompareText(RemoveBackslashUnlessRoot(HydraOldGroup), RemoveBackslashUnlessRoot(ExpandConstant('{group}'))) <> 0 then
      if RemoveDir(HydraOldGroup) then Log('Hydra: removed the empty Start Menu folder ' + HydraOldGroup);
  except
    Log('Hydra: left the old Start Menu folder ' + HydraOldGroup + ': ' + GetExceptionMessage());
  end;
end;
