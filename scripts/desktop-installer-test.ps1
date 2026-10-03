param([Parameter(Mandatory = $true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This intentionally cannot be a local developer acceptance command.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Installer lifecycle tests run only on disposable GitHub-hosted Windows runners.'
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$workspaceRoot = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path.TrimEnd('\') + '\'
if (-not $installer.StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer must be a workspace artifact.' }
$testRoot = Join-Path $env:RUNNER_TEMP ('hydra-installer-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'Hydra'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Hydra IDE.lnk'
$startFolder = Join-Path ([Environment]::GetFolderPath('Programs')) 'Hydra IDE'
$startShortcut = Join-Path $startFolder 'Hydra IDE.lnk'
# "Hydra" shortcuts are the Hydra app's now: the IDE never makes one, and leaves
# a stand-in for the app's alone through install and uninstall.
$appShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Hydra.lnk'
$oldStartFolder = Join-Path ([Environment]::GetFolderPath('Programs')) 'Hydra'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{4C372D32-54B2-43D8-8C63-ECC31D3744A8}_is1'
if ((Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $startFolder) -or (Test-Path -LiteralPath $appShortcut) -or (Test-Path -LiteralPath $oldStartFolder) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Runner already contains a Hydra install or shortcut; refusing to replace it.' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$shell = New-Object -ComObject WScript.Shell
$standIn = $shell.CreateShortcut($appShortcut)
$standIn.TargetPath = Join-Path $env:SystemRoot 'System32\notepad.exe'
$standIn.Save()
$appShortcutHash = (Get-FileHash -LiteralPath $appShortcut).Hash
function Assert-AppShortcutKept {
  if (-not (Test-Path -LiteralPath $appShortcut) -or (Get-FileHash -LiteralPath $appShortcut).Hash -ne $appShortcutHash) { throw 'The IDE changed or removed the Hydra app''s Hydra.lnk.' }
  if (Test-Path -LiteralPath $oldStartFolder) { throw 'The IDE made a "Hydra" Start Menu folder.' }
}
# The last case removes these two folders, so they must be the test's own. Earlier steps of this job
# (the build's smoke run) can leave Hydra data behind: set it aside for the test and put it back after.
$hydraData = @((Join-Path $env:APPDATA 'Hydra'), (Join-Path $env:USERPROFILE '.hydra'))
$setAside = @{}
foreach ($folder in $hydraData) {
  if (Test-Path -LiteralPath $folder) {
    $aside = Join-Path $testRoot ('preexisting-' + (Split-Path -Leaf $folder))
    Move-Item -LiteralPath $folder -Destination $aside
    $setAside[$folder] = $aside
  }
}
function Restore-SetAsideData {
  foreach ($folder in $setAside.Keys) {
    # The test's own data (sentinels, a junction) goes; the job's earlier data comes back.
    if (Test-Path -LiteralPath $folder) { cmd /d /c rmdir /s /q "$folder" | Out-Null }
    Move-Item -LiteralPath $setAside[$folder] -Destination $folder
  }
}
# The uninstall cleanup must edit ~/.claude.json directly here, and find the files at their default places.
if (Get-Command claude -ErrorAction SilentlyContinue) { throw 'A Claude CLI is on the runner; this test exercises the direct ~/.claude.json edit.' }
if ($env:CLAUDE_CONFIG_DIR -or $env:CODEX_HOME) { throw 'CLAUDE_CONFIG_DIR or CODEX_HOME is set; the connector files would be elsewhere.' }
$hydraSentinels = @(
  (Join-Path $env:APPDATA 'Hydra\User\hydra-installer-sentinel.txt'),
  (Join-Path $env:USERPROFILE '.hydra\extensions\hydra-installer-sentinel.txt')
)
$otherSentinels = @(
  (Join-Path $env:APPDATA 'Code\User\hydra-installer-sentinel.txt'),
  (Join-Path $env:APPDATA 'Cursor\User\hydra-installer-sentinel.txt'),
  (Join-Path $testRoot 'project\keep.txt'),
  # Reached only through a junction inside ~/.hydra: removing Hydra's data must not follow it.
  (Join-Path $testRoot 'linked-target\keep.txt')
)
$sentinels = $hydraSentinels + $otherSentinels
foreach ($file in $sentinels) {
  if (Test-Path -LiteralPath $file) { throw "Unexpected existing sentinel: $file" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
  [IO.File]::WriteAllText($file, 'Keep this user data ' + $file)
}
$linked = Join-Path $env:USERPROFILE '.hydra\extensions\linked-folder'
New-Item -ItemType Junction -Path $linked -Target (Join-Path $testRoot 'linked-target') | Out-Null
$hashes = @{}
foreach ($file in $sentinels) { $hashes[$file] = (Get-FileHash -LiteralPath $file).Hash }
$script:hydraDataRemoved = $false
function Assert-DataPreserved {
  $kept = if ($script:hydraDataRemoved) { $otherSentinels } else { $sentinels }
  foreach ($file in $kept) {
    if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file).Hash -ne $hashes[$file]) { throw "Installer changed user data: $file" }
  }
  if ($script:hydraDataRemoved) {
    foreach ($folder in $hydraData) { if (Test-Path -LiteralPath $folder) { throw "Hydra data was kept after /HYDRAREMOVEDATA: $folder" } }
  }
}

# ---- What connecting Hydra writes into Claude Code and Codex (helperRegistration.ts,
# claudeLimitHook.ts), next to unrelated entries that uninstalling must keep byte for byte.
$connectorFiles = [ordered]@{
  claudeJson = (Join-Path $env:USERPROFILE '.claude.json')
  claudeSettings = (Join-Path $env:USERPROFILE '.claude\settings.json')
  codexConfig = (Join-Path $env:USERPROFILE '.codex\config.toml')
}
$connectorBackup = Join-Path $testRoot 'connector-backup'
New-Item -ItemType Directory -Path $connectorBackup | Out-Null
$backedUp = @{}
foreach ($name in $connectorFiles.Keys) {
  if (Test-Path -LiteralPath $connectorFiles[$name]) {
    Copy-Item -LiteralPath $connectorFiles[$name] -Destination (Join-Path $connectorBackup $name)
    $backedUp[$name] = $true
  }
}
function Restore-ConnectorFiles {
  foreach ($name in $connectorFiles.Keys) {
    if ($backedUp.ContainsKey($name)) { Copy-Item -LiteralPath (Join-Path $connectorBackup $name) -Destination $connectorFiles[$name] -Force }
    elseif (Test-Path -LiteralPath $connectorFiles[$name]) { Remove-Item -LiteralPath $connectorFiles[$name] -Force }
  }
}
# Texts are built with LF so they don't depend on this script's own line endings.
function Join-Lines([string[]]$lines) { return ($lines -join "`n") }
function Json-Path([string]$value) { return $value.Replace('\', '\\') }
function Get-ConnectorTexts([string]$owner) {
  $exe = Json-Path (Join-Path $owner 'Hydra.exe')
  $dist = Json-Path (Join-Path $owner 'resources\app\extensions\hydra-agent-manager\dist')
  $events = Json-Path (Join-Path $env:APPDATA 'Hydra\User\globalStorage\nico-dunlap.hydra-agent-manager\limit-events')
  $keepServer = Join-Lines @('{', '  "numStartups": 3,', '  "mcpServers": {', '    "keep-me": {', '      "type": "stdio",', '      "command": "npx",', '      "args": ["-y", "keep-me"]', '    }')
  $hydraServer = Join-Lines @(',', '    "hydra": {', '      "type": "stdio",', ('      "command": "' + $exe + '",'), ('      "args": ["' + $dist + '\\hydra-mcp.cjs"],'), '      "env": {"ELECTRON_RUN_AS_NODE": "1"},', '      "timeout": 3600000', '    }')
  $serversEnd = "`n  }`n}`n"
  $settingsKept = Join-Lines @('{', '  "permissions": {', '    "allow": [', '      "Bash(npm test)"', '    ]', '  }', '}', '')
  $powershell = Json-Path (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
  $run = "`$env:ELECTRON_RUN_AS_NODE='1'; & '" + $exe + "' '" + $dist + "\\hydra-limit-hook.cjs' '" + $events + "'; exit 0"
  $settingsSeeded = Join-Lines @('{', '  "permissions": {', '    "allow": [', '      "mcp__hydra",', '      "Bash(npm test)"', '    ]', '  },',
    '  "hooks": {', '    "StopFailure": [', '      {', '        "matcher": "rate_limit",', '        "hooks": [', '          {', '            "type": "command",',
    ('            "command": "' + $powershell + '",'), '            "args": [', '              "-NoLogo",', '              "-NoProfile",', '              "-NonInteractive",', '              "-Command",',
    ('              "' + $run + '"'), '            ],', '            "timeout": 30', '          }', '        ]', '      }', '    ]', '  }', '}', '')
  $codexKept = Join-Lines @('model = "gpt-5"', '', '[mcp_servers.keep-me]', 'command = "npx"', '')
  $codexBlock = Join-Lines @('', '# >>> Hydra helpers (managed by Hydra: connect or disconnect in Hydra Settings)', '[mcp_servers.hydra]',
    ("command = '" + (Join-Path $owner 'Hydra.exe') + "'"), ("args = ['" + (Join-Path $owner 'resources\app\extensions\hydra-agent-manager\dist\hydra-mcp.cjs') + "']"),
    'startup_timeout_sec = 30', 'tool_timeout_sec = 3600', "default_tools_approval_mode = 'approve'", '', '[mcp_servers.hydra.env]', "ELECTRON_RUN_AS_NODE = '1'", '# <<< Hydra helpers', '')
  return @{
    seeded = [ordered]@{ claudeJson = $keepServer + $hydraServer + $serversEnd; claudeSettings = $settingsSeeded; codexConfig = $codexKept + $codexBlock }
    kept = [ordered]@{ claudeJson = $keepServer + $serversEnd; claudeSettings = $settingsKept; codexConfig = $codexKept }
  }
}
function Set-Connections($texts) {
  foreach ($name in $connectorFiles.Keys) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $connectorFiles[$name]) -Force | Out-Null
    [IO.File]::WriteAllText($connectorFiles[$name], $texts[$name])
  }
}
function Assert-Connections($texts, [string]$why) {
  foreach ($name in $connectorFiles.Keys) {
    if ([IO.File]::ReadAllText($connectorFiles[$name]) -cne $texts[$name]) { throw "$why ($name)" }
  }
}
$cleanupLog = Join-Path $env:TEMP 'hydra-uninstall.log'
Remove-Item -LiteralPath $cleanupLog -Force -ErrorAction SilentlyContinue

function Invoke-Installer([string]$label, [string[]]$taskArgs) {
  $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NORESTARTAPPLICATIONS', ('/DIR="' + $installRoot + '"'), ('/LOG="' + (Join-Path $testRoot ($label + '.log')) + '"')) + $taskArgs
  $process = Start-Process -FilePath $installer -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer $label failed: $($process.ExitCode)" }
  if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'Hydra.exe'))) { throw 'Installed executable missing.' }
  if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'resources\app\extensions\hydra-agent-manager\dist\hydra-uninstall.cjs'))) { throw 'Uninstall cleanup missing from installer.' }
  $nativeHelper = Join-Path $installRoot 'tools\HydraUpdateVerify.exe'
  if (-not (Test-Path -LiteralPath $nativeHelper)) { throw 'Disabled native update helper missing from installer.' }
  if (Get-ChildItem -LiteralPath (Join-Path $installRoot 'tools') -Filter '*fixture*.exe' -File) { throw 'Native fixture executable leaked into installer.' }
  $helperProbe = Start-Process -FilePath $nativeHelper -ArgumentList '12345678-1234-4234-8234-123456789abc' -WindowStyle Hidden -Wait -PassThru
  if ($helperProbe.ExitCode -ne 2) { throw 'Installed native update helper accepted an unauthenticated operation.' }
  $product = Get-Content -LiteralPath (Join-Path $installRoot 'resources\app\product.json') -Raw | ConvertFrom-Json
  if ($product.nameShort -ne 'Hydra' -or $product.nameLong -ne 'Hydra IDE' -or $product.dataFolderName -ne '.hydra' -or $product.win32AppUserModelId -ne 'Hydra.IDE') { throw 'Installed product identity changed.' }
  if (-not (Test-Path -LiteralPath $startShortcut) -or $shell.CreateShortcut($startShortcut).TargetPath -ne (Join-Path $installRoot 'Hydra.exe')) { throw 'The "Hydra IDE" Start Menu shortcut is missing or opens something else.' }
  Assert-AppShortcutKept
  $registry = Get-ItemProperty -LiteralPath $uninstallKey
  if ($registry.DisplayVersion -ne $product.hydraVersion) { throw 'Installer version does not match the bundled Hydra version.' }
  Assert-DataPreserved
}
function Assert-EqualVersionRefused([string]$label) {
  $executable = Join-Path $installRoot 'Hydra.exe'
  $beforeHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash
  $beforeVersion = (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion
  $beforeShortcut = Test-Path -LiteralPath $desktopShortcut
  $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NORESTARTAPPLICATIONS', ('/DIR="' + $installRoot + '"'), ('/LOG="' + (Join-Path $testRoot ($label + '.log')) + '"'))
  $process = Start-Process -FilePath $installer -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -eq 0) { throw 'Equal-version reinstall was accepted.' }
  if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ne $beforeHash -or (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -ne $beforeVersion -or (Test-Path -LiteralPath $desktopShortcut) -ne $beforeShortcut) { throw 'Equal-version refusal changed the installation.' }
  Assert-DataPreserved
}
function Remove-TestInstallation([string]$label, [string[]]$extraArgs = @(), [switch]$RemovesData) {
  $uninstaller = Join-Path $installRoot 'unins000.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $process = Start-Process -FilePath $uninstaller -ArgumentList (@('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="' + (Join-Path $testRoot ($label + '-uninstall.log')) + '"')) + $extraArgs) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Uninstall failed: $($process.ExitCode)" }
    if ($RemovesData) { $script:hydraDataRemoved = $true }
  }
  if ((Test-Path -LiteralPath (Join-Path $installRoot 'Hydra.exe')) -or (Test-Path -LiteralPath (Join-Path $installRoot 'tools\HydraUpdateVerify.exe')) -or (Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $startFolder) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Uninstall left the executable, helper, shortcut, or registration behind.' }
  Assert-AppShortcutKept
  Assert-DataPreserved
}
try {
  # Fresh installs exercise the checkbox; equal-version reinstall is now refused.
  Invoke-Installer 'default-unchecked' @('/MERGETASKS="!runcode,!associatewithfiles,!addtopath"')
  if (Test-Path -LiteralPath $desktopShortcut) { throw 'Default installation created a desktop shortcut.' }
  Assert-EqualVersionRefused 'default-equal-refusal'
  # This installation's Claude Code and Codex entries go; unrelated ones stay byte for byte; data stays.
  $own = Get-ConnectorTexts $installRoot
  Set-Connections $own.seeded
  Remove-TestInstallation 'default'
  Assert-Connections $own.kept 'Uninstall did not remove exactly its own Claude Code and Codex entries'
  if (-not (Test-Path -LiteralPath $cleanupLog) -or -not (Select-String -LiteralPath $cleanupLog -SimpleMatch 'removed the hydra MCP entry' -Quiet)) { throw 'Uninstall cleanup did not run.' }
  Invoke-Installer 'enable-shortcut' @('/TASKS="desktopicon"')
  if (-not (Test-Path -LiteralPath $desktopShortcut)) { throw 'Selected desktop shortcut is missing.' }
  $shortcut = $shell.CreateShortcut($desktopShortcut)
  if ($shortcut.TargetPath -ne (Join-Path $installRoot 'Hydra.exe')) { throw 'Desktop shortcut targets another application.' }
  Assert-EqualVersionRefused 'selected-equal-refusal'
  # Another Hydra's entries (a dev build, a second install) are left alone, with the rule that serves them.
  $other = Get-ConnectorTexts (Join-Path $testRoot 'OtherHydra')
  Set-Connections $other.seeded
  Remove-TestInstallation 'selected'
  Assert-Connections $other.seeded 'Uninstall changed another Hydra''s Claude Code or Codex entries'
  # Asked to, uninstall removes exactly %APPDATA%\Hydra and %USERPROFILE%\.hydra, without following links.
  Invoke-Installer 'remove-data' @('/MERGETASKS="!runcode,!associatewithfiles,!addtopath"')
  Remove-TestInstallation 'remove-data' @('/HYDRAREMOVEDATA') -RemovesData
} finally {
  Remove-TestInstallation 'cleanup'
  Restore-ConnectorFiles
  $logRoot = Join-Path $env:GITHUB_WORKSPACE '.desktop\installer-test-logs'
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  Get-ChildItem -LiteralPath $testRoot -Filter '*.log' | Copy-Item -Destination $logRoot
  if (Test-Path -LiteralPath $cleanupLog) { Copy-Item -LiteralPath $cleanupLog -Destination $logRoot }
}
if ((Test-Path -LiteralPath (Join-Path $installRoot 'Hydra.exe')) -or (Test-Path -LiteralPath (Join-Path $installRoot 'tools\HydraUpdateVerify.exe')) -or (Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $startFolder) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Uninstall left the executable, helper, shortcut, or registration behind.' }
Assert-AppShortcutKept
Remove-Item -LiteralPath $appShortcut -Force
Assert-DataPreserved
Restore-SetAsideData
Write-Output 'PASS: fresh "Hydra IDE" installs with default-unchecked and selected desktop shortcuts leave the app''s Hydra.lnk alone; equal-version refusal, and uninstall preserve Hydra/VS Code/Cursor data and projects; uninstall removes only its own Claude Code and Codex entries, and removes Hydra data only with /HYDRAREMOVEDATA.'
