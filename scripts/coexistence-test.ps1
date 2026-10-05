# Hydra IDE and the Hydra app installed side by side (G6), in both orders: one is installed, then the other, which
# must leave the first's shortcuts alone; then the first is uninstalled, and the second keeps its program, its
# registration and its shortcuts; then the second goes. The data both use (the app's own, the Hydra storage they
# share, and the IDE's settings) is untouched throughout.
#   -IdeInstallerPath  a HydraSetup.exe (the pinned release in the App workflow; this build's in the desktop workflow)
#   -AppInstallerPath  a HydraAppSetup.exe
#   -DesktopShortcuts  both also make a desktop shortcut. Only with an IDE from after the rename to Hydra IDE: an older
#                      IDE's desktop shortcut is also Hydra.lnk, and it may replace the app's (Releases.md: the first
#                      app preview follows the rename release).
# Installing the IDE would replace a developer's own Hydra IDE, so this runs only on a disposable GitHub-hosted runner.
param(
  [Parameter(Mandatory = $true)][string]$IdeInstallerPath,
  [Parameter(Mandatory = $true)][string]$AppInstallerPath,
  [switch]$DesktopShortcuts
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'The coexistence test runs only on disposable GitHub-hosted Windows runners.'
}
$ideInstaller = (Resolve-Path -LiteralPath $IdeInstallerPath).Path
$appInstaller = (Resolve-Path -LiteralPath $AppInstallerPath).Path
$ideKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{4C372D32-54B2-43D8-8C63-ECC31D3744A8}_is1'
$appKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{F4C65ADB-835D-4926-B2F2-4C78F6967279}_is1'
if ((Test-Path -LiteralPath $ideKey) -or (Test-Path -LiteralPath $appKey)) { throw 'Hydra IDE or the Hydra app is already installed on this runner.' }
$testRoot = Join-Path $env:RUNNER_TEMP ('hydra-coexistence-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$products = @{
  ide = @{ name = 'Hydra IDE'; installer = $ideInstaller; key = $ideKey; folder = 'Hydra'; args = @($(if ($DesktopShortcuts) { '/MERGETASKS="desktopicon,!runcode,!associatewithfiles,!addtopath"' } else { '/MERGETASKS="!runcode,!associatewithfiles,!addtopath"' })) }
  app = @{ name = 'the Hydra app'; installer = $appInstaller; key = $appKey; folder = 'Hydra App'; args = @($(if ($DesktopShortcuts) { '/TASKS="desktopicon"' } else { '/TASKS=""' })) }
}
# Each order installs into folders of its own, so nothing one left can trip the next.
function Use-Folders([string]$label) {
  foreach ($product in $products.Values) { $product.dir = Join-Path (Join-Path $testRoot $label) $product.folder; $product.exe = Join-Path $product.dir 'Hydra.exe' }
}
Use-Folders 'none'

# The data neither uninstall may touch without /HYDRAREMOVEDATA.
$sentinels = @(
  (Join-Path $env:APPDATA 'Hydra App\hydra-coexistence-sentinel.txt'),
  (Join-Path $env:APPDATA 'Hydra\User\globalStorage\nico-dunlap.hydra-agent-manager\hydra-coexistence-sentinel.txt'),
  (Join-Path $env:APPDATA 'Hydra\User\hydra-coexistence-sentinel.txt')
)
foreach ($file in $sentinels) {
  if (Test-Path -LiteralPath $file) { throw "Unexpected existing sentinel: $file" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
  [IO.File]::WriteAllText($file, 'Keep this ' + $file)
}
$hashes = @{}
foreach ($file in $sentinels) { $hashes[$file] = (Get-FileHash -LiteralPath $file).Hash }
function Assert-DataKept([string]$when) {
  foreach ($file in $sentinels) { if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file).Hash -ne $hashes[$file]) { throw "$when changed or removed $file" } }
}

$shell = New-Object -ComObject WScript.Shell
# Every shortcut on the Start Menu or the desktop that opens this executable, with its hash.
function Get-Shortcuts([string]$exe) {
  $found = @{}
  foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('DesktopDirectory'))) {
    foreach ($link in @(Get-ChildItem -LiteralPath $folder -Recurse -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
      if ($shell.CreateShortcut($link.FullName).TargetPath -eq $exe) { $found[$link.FullName] = (Get-FileHash -LiteralPath $link.FullName).Hash }
    }
  }
  return $found
}
function Install-Product($product, [string]$label) {
  $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', ('/DIR="' + $product.dir + '"'), ('/LOG="' + (Join-Path $testRoot ($label + '.log')) + '"')) + $product.args
  $process = Start-Process -FilePath $product.installer -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installing $($product.name) ($label) failed: $($process.ExitCode)" }
}
function Uninstall-Product($product, [string]$label) {
  $uninstaller = Join-Path $product.dir 'unins000.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { return }
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="' + (Join-Path $testRoot ($label + '-uninstall.log')) + '"')) -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Uninstalling $($product.name) ($label) failed: $($process.ExitCode)" }
  # Inno's uninstaller hands off to a copy of itself in TEMP and returns at once; on a slow runner that copy can take
  # more than 30 seconds, so wait (up to two minutes) for the program, its registration and its folder to go.
  for ($i = 0; $i -lt 240 -and ((Test-Path -LiteralPath $product.exe) -or (Test-Path -LiteralPath $product.key) -or (Test-Path -LiteralPath $product.dir)); $i++) { Start-Sleep -Milliseconds 500 }
  if ((Test-Path -LiteralPath $product.exe) -or (Test-Path -LiteralPath $product.key)) { throw "Uninstalling $($product.name) left its program or registration." }
  if (Test-Path -LiteralPath $product.dir) { throw "Uninstalling $($product.name) left files: $((Get-ChildItem -LiteralPath $product.dir -Recurse -File | Select-Object -First 10 | ForEach-Object FullName) -join ', ')" }
}
function Assert-Installed($product, $shortcuts, [string]$when) {
  if (-not (Test-Path -LiteralPath $product.exe) -or -not (Test-Path -LiteralPath $product.key)) { throw "$when removed $($product.name)'s program or registration." }
  if ((Get-ItemProperty -LiteralPath $product.key).'Inno Setup: App Path' -ne $product.dir) { throw "$when changed $($product.name)'s registration." }
  foreach ($link in $shortcuts.Keys) {
    if (-not (Test-Path -LiteralPath $link) -or (Get-FileHash -LiteralPath $link).Hash -ne $shortcuts[$link]) { throw "$when removed or changed $($product.name)'s shortcut $link." }
  }
}

$results = @()
try {
  foreach ($first in @('ide', 'app')) {
    $second = if ($first -eq 'ide') { 'app' } else { 'ide' }
    $label = "$first-first"
    Use-Folders $label
    $shortcuts = @{}
    Install-Product $products[$first] "$label-$first"
    $shortcuts[$first] = Get-Shortcuts $products[$first].exe
    Install-Product $products[$second] "$label-$second"
    Assert-Installed $products[$first] $shortcuts[$first] "Installing $($products[$second].name) after it"
    $shortcuts[$second] = Get-Shortcuts $products[$second].exe
    $expected = if ($DesktopShortcuts) { 2 } else { 1 }
    foreach ($name in 'ide', 'app') { if ($shortcuts[$name].Count -ne $expected) { throw "$($products[$name].name) has $($shortcuts[$name].Count) shortcut(s), not $expected." } }
    # The app's is the Start Menu's Hydra.lnk; the IDE's is in its own Start Menu folder.
    if (-not $shortcuts.app.ContainsKey((Join-Path ([Environment]::GetFolderPath('Programs')) 'Hydra.lnk'))) { throw 'The app has no Start Menu Hydra.lnk.' }
    Uninstall-Product $products[$first] "$label-$first"
    Assert-Installed $products[$second] $shortcuts[$second] "Uninstalling $($products[$first].name)"
    Assert-DataKept "Uninstalling $($products[$first].name)"
    Uninstall-Product $products[$second] "$label-$second"
    Assert-DataKept "Uninstalling $($products[$second].name)"
    $results += "$($products[$first].name) uninstalled first: $($products[$second].name) kept $($shortcuts[$second].Count) shortcut(s), its registration and program, and all the data"
  }
} finally {
  foreach ($product in $products.Values) { try { Uninstall-Product $product 'cleanup' } catch { Write-Warning $_ } }
  foreach ($file in $sentinels) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
  $logs = Join-Path $env:GITHUB_WORKSPACE 'coexistence-test-logs'
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  Get-ChildItem -LiteralPath $testRoot -Filter '*.log' | Copy-Item -Destination $logs
  $cleanupLog = Join-Path $env:TEMP 'hydra-uninstall.log'
  if (Test-Path -LiteralPath $cleanupLog) { Copy-Item -LiteralPath $cleanupLog -Destination $logs }
}
$results
Write-Output "PASS: Hydra IDE and the Hydra app install side by side in both orders$(if ($DesktopShortcuts) { ', desktop shortcuts included' }); neither install touches the other's shortcuts, and uninstalling either leaves the other its program, registration, shortcuts and data."
