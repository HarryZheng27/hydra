# The Hydra app's installer lifecycle: install, update, refusals and uninstall.
#   -InstallerPath       HydraAppSetup.exe to test (app/scripts/package.mjs --installer)
#   -PriorInstallerPath  an older HydraAppSetup.exe of the same package (package.mjs --prior=<version>)
#   -SafeLocal           runs on a developer's machine: only into a fresh test folder, never touching existing Hydra
#                        data, Claude Code or Codex settings, and never removing data. Without it, the script runs only
#                        on a disposable GitHub-hosted Windows runner and also tests connector cleanup and /HYDRAREMOVEDATA.
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$PriorInstallerPath,
  [switch]$SafeLocal
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $SafeLocal -and ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows')) {
  throw 'The full app installer test runs only on disposable GitHub-hosted Windows runners; use -SafeLocal on your own machine.'
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$prior = (Resolve-Path -LiteralPath $PriorInstallerPath).Path
$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$testRoot = Join-Path $tempBase ('hydra-app-installer-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'Hydra App'
$exe = Join-Path $installRoot 'Hydra.exe'
$programs = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$startShortcut = Join-Path $programs 'Hydra.lnk'
$desktopShortcut = Join-Path $desktop 'Hydra.lnk'
$appKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{F4C65ADB-835D-4926-B2F2-4C78F6967279}_is1'
$ideKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{4C372D32-54B2-43D8-8C63-ECC31D3744A8}_is1'
if ((Test-Path -LiteralPath $appKey) -or (Test-Path -LiteralPath $startShortcut) -or (Test-Path -LiteralPath $desktopShortcut)) { throw 'The Hydra app or a Hydra.lnk is already here; refusing to replace it.' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$shell = New-Object -ComObject WScript.Shell
function Get-ShortcutTarget([string]$path) { return $shell.CreateShortcut($path).TargetPath }

# ---- Data: the app's own, the folder it shares with the IDE, and the IDE's settings beside it.
$appData = Join-Path $env:APPDATA 'Hydra App'
$sharedData = Join-Path $env:APPDATA 'Hydra\User\globalStorage\nico-dunlap.hydra-agent-manager'
$ideSettings = Join-Path $env:APPDATA 'Hydra\User\settings.json'
$setAside = @{}
$sentinels = @()
$script:appDataRemoved = $false
$script:sharedDataRemoved = $false
if (-not $SafeLocal) {
  # The data cases remove these folders, so they must be the test's own: set aside anything earlier steps left.
  foreach ($folder in @($appData, $sharedData)) {
    if (Test-Path -LiteralPath $folder) {
      $aside = Join-Path $testRoot ('preexisting-' + (Split-Path -Leaf $folder))
      Move-Item -LiteralPath $folder -Destination $aside
      $setAside[$folder] = $aside
    }
  }
  if (Test-Path -LiteralPath $ideSettings) { throw 'IDE settings exist on this runner; the test plants its own.' }
  $sentinels = @((Join-Path $appData 'hydra-app-sentinel.txt'), (Join-Path $sharedData 'hydra-shared-sentinel.txt'), $ideSettings,
    (Join-Path $testRoot 'project\keep.txt'), (Join-Path $testRoot 'linked-target\keep.txt'))
  foreach ($file in $sentinels) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
    [IO.File]::WriteAllText($file, 'Keep this ' + $file)
  }
  # Reached only through a junction inside the app's data: removing it must not follow the link.
  New-Item -ItemType Junction -Path (Join-Path $appData 'linked-folder') -Target (Join-Path $testRoot 'linked-target') | Out-Null
} else {
  $sentinels = @((Join-Path $testRoot 'project\keep.txt'))
  New-Item -ItemType Directory -Path (Split-Path -Parent $sentinels[0]) -Force | Out-Null
  [IO.File]::WriteAllText($sentinels[0], 'Keep this project file')
}
# On a developer's machine the real folders are only checked to still be there (their files may be in use and changing).
$existingFolders = @($appData, $sharedData, (Split-Path -Parent $ideSettings)) | Where-Object { Test-Path -LiteralPath $_ }
$hashes = @{}
foreach ($file in $sentinels) { $hashes[$file] = (Get-FileHash -LiteralPath $file).Hash }
function Assert-DataPreserved {
  if ($SafeLocal) { foreach ($folder in $existingFolders) { if (-not (Test-Path -LiteralPath $folder)) { throw "The installer removed $folder" } } }
  foreach ($file in $sentinels) {
    $removed = ($script:appDataRemoved -and $file.StartsWith($appData + '\')) -or ($script:sharedDataRemoved -and $file.StartsWith($sharedData + '\'))
    if ($removed) { if (Test-Path -LiteralPath $file) { throw "Data removal kept $file" } ; continue }
    if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file).Hash -ne $hashes[$file]) { throw "The installer changed data it must keep: $file" }
  }
}

# ---- Connector entries this install writes into Claude Code and Codex, next to ones it must keep (CI only).
$connectorFiles = [ordered]@{ claudeJson = (Join-Path $env:USERPROFILE '.claude.json'); codexConfig = (Join-Path $env:USERPROFILE '.codex\config.toml') }
function Get-ConnectorTexts([string]$owner) {
  $ownerExe = Join-Path $owner 'Hydra.exe'
  $mcp = Join-Path $owner 'resources\app.asar\dist\hydra-mcp.cjs'
  $keep = "{`n  ""mcpServers"": {`n    ""keep-me"": {""type"": ""stdio"", ""command"": ""npx"", ""args"": [""-y"", ""keep-me""]}"
  $hydra = ",`n    ""hydra"": {""type"": ""stdio"", ""command"": ""$($ownerExe.Replace('\', '\\'))"", ""args"": [""$($mcp.Replace('\', '\\'))""], ""env"": {""ELECTRON_RUN_AS_NODE"": ""1""}}"
  $end = "`n  }`n}`n"
  $codexKept = "model = ""gpt-5""`n`n[mcp_servers.keep-me]`ncommand = ""npx""`n"
  $codexBlock = "`n# >>> Hydra helpers (managed by Hydra: connect or disconnect in Hydra Settings)`n[mcp_servers.hydra]`ncommand = '$ownerExe'`nargs = ['$mcp']`n`n[mcp_servers.hydra.env]`nELECTRON_RUN_AS_NODE = '1'`n# <<< Hydra helpers`n"
  return @{ seeded = [ordered]@{ claudeJson = $keep + $hydra + $end; codexConfig = $codexKept + $codexBlock }; kept = [ordered]@{ claudeJson = $keep + $end; codexConfig = $codexKept } }
}
$connectorBackup = Join-Path $testRoot 'connector-backup'
$backedUp = @{}
if (-not $SafeLocal) {
  if (Get-Command claude -ErrorAction SilentlyContinue) { throw 'A Claude CLI is on the runner; this test exercises the direct ~/.claude.json edit.' }
  New-Item -ItemType Directory -Path $connectorBackup | Out-Null
  foreach ($name in $connectorFiles.Keys) { if (Test-Path -LiteralPath $connectorFiles[$name]) { Copy-Item -LiteralPath $connectorFiles[$name] -Destination (Join-Path $connectorBackup $name); $backedUp[$name] = $true } }
}
function Set-Connections($texts) { foreach ($name in $connectorFiles.Keys) { New-Item -ItemType Directory -Path (Split-Path -Parent $connectorFiles[$name]) -Force | Out-Null; [IO.File]::WriteAllText($connectorFiles[$name], $texts[$name]) } }
function Assert-Connections($texts, [string]$why) { foreach ($name in $connectorFiles.Keys) { if ([IO.File]::ReadAllText($connectorFiles[$name]) -cne $texts[$name]) { throw "$why ($name)" } } }
function Restore-ConnectorFiles {
  if ($SafeLocal) { return }
  foreach ($name in $connectorFiles.Keys) {
    if ($backedUp.ContainsKey($name)) { Copy-Item -LiteralPath (Join-Path $connectorBackup $name) -Destination $connectorFiles[$name] -Force }
    elseif (Test-Path -LiteralPath $connectorFiles[$name]) { Remove-Item -LiteralPath $connectorFiles[$name] -Force }
  }
}

# ---- Running the installer and uninstaller.
$common = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-')
function Invoke-Setup([string]$setup, [string]$label, [string[]]$extra, [switch]$Refused) {
  $arguments = $common + @(('/DIR="' + $installRoot + '"'), ('/LOG="' + (Join-Path $testRoot ($label + '.log')) + '"')) + $extra
  $process = Start-Process -FilePath $setup -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($Refused) { if ($process.ExitCode -eq 0) { throw "Setup $label was accepted but must be refused." } }
  elseif ($process.ExitCode -ne 0) { throw "Setup $label failed: $($process.ExitCode)" }
}
function Invoke-Uninstall([string]$label, [string[]]$extra = @(), [switch]$Refused) {
  $uninstaller = Join-Path $installRoot 'unins000.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { return }
  $process = Start-Process -FilePath $uninstaller -ArgumentList ($common[0..2] + @(('/LOG="' + (Join-Path $testRoot ($label + '-uninstall.log')) + '"')) + $extra) -WindowStyle Hidden -Wait -PassThru
  if ($Refused) { if ($process.ExitCode -eq 0) { throw "Uninstall $label was accepted but must be refused." }; return }
  if ($process.ExitCode -ne 0) { throw "Uninstall $label failed: $($process.ExitCode)" }
  for ($i = 0; $i -lt 60 -and (Test-Path -LiteralPath $installRoot); $i++) { Start-Sleep -Milliseconds 500 }
}
function Assert-Installed([string]$version, [bool]$desktopWanted) {
  if (-not (Test-Path -LiteralPath $exe)) { throw 'Hydra.exe is missing.' }
  foreach ($relative in @('resources\app.asar', 'resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\pty.node', 'resources\packs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot $relative))) { throw "The install is missing $relative." }
  }
  $registration = Get-ItemProperty -LiteralPath $appKey
  if ($registration.DisplayVersion -ne $version -or $registration.DisplayName -ne 'Hydra App' -or $registration.'Inno Setup: App Path' -ne $installRoot) { throw 'The app''s registration is wrong.' }
  # A per-user install: registered under HKCU only, never for the machine.
  if (Test-Path -LiteralPath ('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{F4C65ADB-835D-4926-B2F2-4C78F6967279}_is1')) { throw 'The app registered for the whole machine.' }
  if (-not (Test-Path -LiteralPath $startShortcut) -or (Get-ShortcutTarget $startShortcut) -ne $exe) { throw 'The Start Menu''s Hydra.lnk is missing or opens something else.' }
  if ((Test-Path -LiteralPath $desktopShortcut) -ne $desktopWanted) { throw "Desktop shortcut present: $(Test-Path -LiteralPath $desktopShortcut), wanted: $desktopWanted" }
  # The packaged app runs scripts from its archive as Node (the MCP bridge, the uninstall cleanup).
  $env:ELECTRON_RUN_AS_NODE = '1'
  try { $help = & $exe (Join-Path $installRoot 'resources\app.asar\dist\hydra-cli.cjs') --help 2>&1 | Out-String } finally { Remove-Item Env:\ELECTRON_RUN_AS_NODE }
  if ($help -notmatch 'Usage: hydra') { throw 'The installed Hydra.exe could not run hydra-cli.cjs from its archive.' }
  Assert-DataPreserved
}
function Assert-Removed {
  if ((Test-Path -LiteralPath $exe) -or (Test-Path -LiteralPath $appKey) -or (Test-Path -LiteralPath $startShortcut) -or (Test-Path -LiteralPath $installRoot)) { throw 'Uninstall left the app, its folder, its registration or its Start Menu shortcut.' }
  if ((Test-Path -LiteralPath $desktopShortcut) -and (Get-ShortcutTarget $desktopShortcut) -eq $exe) { throw 'Uninstall left the app''s desktop shortcut.' }
  Assert-DataPreserved
}
# Holds Hydra.exe open the way a chat's MCP bridge does: the app's executable running as Node.
function Start-Bridge {
  $info = New-Object System.Diagnostics.ProcessStartInfo $exe
  $info.Arguments = '-e "setTimeout(() => {}, 120000)"'
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
  return [Diagnostics.Process]::Start($info)
}
# Ends the stand-in and anything it started from the install (Electron's crash handler), then waits until Windows
# lets go of Hydra.exe.
function Stop-Bridge($bridge) {
  if (-not $bridge.HasExited) { $bridge.Kill(); $bridge.WaitForExit() }
  Get-CimInstance Win32_Process -Filter "Name='Hydra.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 60; $i++) {
    try { [IO.File]::Open($exe, 'Open', 'Write', 'None').Dispose(); return } catch { Start-Sleep -Milliseconds 500 }
  }
  throw 'Hydra.exe stayed in use after the stand-in bridge ended.'
}

$ideStandIn = $null
try {
  # 1. A fresh install: Start Menu only, as the user, with no admin; the same version again is refused.
  Invoke-Setup $installer 'fresh' @()
  $version = (Get-ItemProperty -LiteralPath $appKey).DisplayVersion
  Assert-Installed $version $false
  Invoke-Setup $installer 'equal-refused' @() -Refused
  Assert-Installed $version $false
  # 2. While Hydra.exe runs (as the app or as a chat's bridge), neither an update nor an uninstall goes ahead.
  $bridge = Start-Bridge
  try {
    Start-Sleep -Seconds 2
    Invoke-Uninstall 'running-refused' -Refused
    Assert-Installed $version $false
  } finally { Stop-Bridge $bridge }
  Invoke-Uninstall 'fresh'
  Assert-Removed

  # 3. An update from an older release keeps the desktop shortcut it was installed with, through /HYDRAUPDATE=1.
  Invoke-Setup $prior 'prior' @('/TASKS="desktopicon"')
  $priorVersion = (Get-ItemProperty -LiteralPath $appKey).DisplayVersion
  if ($priorVersion -eq $version) { throw 'The prior installer has the same version.' }
  Assert-Installed $priorVersion $true
  Invoke-Setup $installer 'update-task-override' @('/HYDRAUPDATE=1', '/TASKS=""') -Refused
  Invoke-Setup $installer 'update-bad-switch' @('/HYDRAUPDATE=2') -Refused
  Invoke-Setup $installer 'update' @('/HYDRAUPDATE=1')
  Assert-Installed $version $true
  Invoke-Setup $prior 'downgrade-refused' @() -Refused
  $bridge = Start-Bridge
  try {
    Start-Sleep -Seconds 2
    Invoke-Setup $prior 'running-update-refused' @('/HYDRAUPDATE=1') -Refused
  } finally { Stop-Bridge $bridge }
  Assert-Installed $version $true
  Invoke-Uninstall 'updated'
  Assert-Removed

  # 4. A Hydra.lnk on the desktop that opens something else (an IDE from before the rename) is never replaced or removed.
  $foreign = $shell.CreateShortcut($desktopShortcut); $foreign.TargetPath = Join-Path $env:SystemRoot 'System32\notepad.exe'; $foreign.Save()
  $foreignHash = (Get-FileHash -LiteralPath $desktopShortcut).Hash
  Invoke-Setup $installer 'foreign-desktop' @('/TASKS="desktopicon"')
  if ((Get-FileHash -LiteralPath $desktopShortcut).Hash -ne $foreignHash) { throw 'The installer replaced a Hydra.lnk that opens something else.' }
  if (-not $SafeLocal) {
    # This install's Claude Code and Codex entries go at uninstall; another app's stay byte for byte.
    $own = Get-ConnectorTexts $installRoot
    Set-Connections $own.seeded
  }
  Invoke-Uninstall 'foreign-desktop'
  if ((Get-FileHash -LiteralPath $desktopShortcut).Hash -ne $foreignHash) { throw 'Uninstall removed a Hydra.lnk that opens something else.' }
  Remove-Item -LiteralPath $desktopShortcut -Force
  Assert-Removed
  if (-not $SafeLocal) {
    Assert-Connections $own.kept 'Uninstall did not remove exactly its own Claude Code and Codex entries'
    $other = Get-ConnectorTexts (Join-Path $testRoot 'OtherHydra')
    Set-Connections $other.seeded
    Invoke-Setup $installer 'other-connections' @()
    Invoke-Uninstall 'other-connections'
    Assert-Connections $other.seeded 'Uninstall changed another Hydra''s Claude Code or Codex entries'
    Assert-Removed

    # 5. /HYDRAREMOVEDATA removes %APPDATA%\Hydra App without following links; with the IDE installed, the shared
    #    storage stays; without it, that goes too. The IDE's own settings are never touched.
    $ideStandIn = New-Item -Path $ideKey -Force
    Invoke-Setup $installer 'remove-data-ide-installed' @()
    Invoke-Uninstall 'remove-data-ide-installed' @('/HYDRAREMOVEDATA')
    $script:appDataRemoved = $true
    if (Test-Path -LiteralPath $appData) { throw '/HYDRAREMOVEDATA kept %APPDATA%\Hydra App.' }
    Assert-Removed
    Remove-Item -LiteralPath $ideKey -Recurse -Force; $ideStandIn = $null
    Invoke-Setup $installer 'remove-data-no-ide' @()
    Invoke-Uninstall 'remove-data-no-ide' @('/HYDRAREMOVEDATA')
    $script:sharedDataRemoved = $true
    if (Test-Path -LiteralPath $sharedData) { throw 'Without the IDE, /HYDRAREMOVEDATA kept the shared Hydra storage.' }
    Assert-Removed
  }
} finally {
  try { Invoke-Uninstall 'cleanup' } catch { Write-Warning $_ }
  if ($ideStandIn) { Remove-Item -LiteralPath $ideKey -Recurse -Force -ErrorAction SilentlyContinue }
  Restore-ConnectorFiles
  foreach ($folder in $setAside.Keys) {
    if (Test-Path -LiteralPath $folder) { cmd /d /c rmdir /s /q "$folder" | Out-Null }
    Move-Item -LiteralPath $setAside[$folder] -Destination $folder
  }
  $logs = if ($env:GITHUB_WORKSPACE) { Join-Path $env:GITHUB_WORKSPACE 'app\out\installer-test-logs' } else { Join-Path $testRoot 'logs' }
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  Get-ChildItem -LiteralPath $testRoot -Filter '*.log' | Copy-Item -Destination $logs
  $cleanupLog = Join-Path $env:TEMP 'hydra-uninstall.log'
  if (Test-Path -LiteralPath $cleanupLog) { Copy-Item -LiteralPath $cleanupLog -Destination $logs }
}
$mode = if ($SafeLocal) { 'safe local' } else { 'full' }
Write-Output "PASS ($mode): a per-user install with a Hydra Start Menu shortcut, equal-version and downgrade refusal, refusal while Hydra.exe runs, an update that keeps the desktop choice, a foreign Hydra.lnk left alone, and an uninstall that leaves nothing$(if (-not $SafeLocal) { ', removes only its own Claude Code and Codex entries, and removes data only with /HYDRAREMOVEDATA, keeping the shared storage while the IDE is installed' })."
