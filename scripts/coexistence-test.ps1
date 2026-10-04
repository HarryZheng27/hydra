# Hydra IDE and the Hydra app installed side by side (G6). Both are installed, then uninstalled one at a time, in
# both orders: whichever stays keeps its program, its registration and its shortcuts, and the data both use (the
# app's own, the Hydra storage they share, and the IDE's settings) is untouched.
#   -IdeInstallerPath  a HydraSetup.exe (the pinned release in the App workflow; this build's in the desktop workflow)
#   -AppInstallerPath  a HydraAppSetup.exe
# Installing the IDE would replace a developer's own Hydra IDE, so this runs only on a disposable GitHub-hosted runner.
param(
  [Parameter(Mandatory = $true)][string]$IdeInstallerPath,
  [Parameter(Mandatory = $true)][string]$AppInstallerPath
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
  ide = @{ name = 'Hydra IDE'; installer = $ideInstaller; key = $ideKey; dir = (Join-Path $testRoot 'Hydra'); args = @('/MERGETASKS="!runcode,!associatewithfiles,!addtopath"') }
  app = @{ name = 'the Hydra app'; installer = $appInstaller; key = $appKey; dir = (Join-Path $testRoot 'Hydra App'); args = @() }
}
foreach ($product in $products.Values) { $product.exe = Join-Path $product.dir 'Hydra.exe' }

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
  for ($i = 0; $i -lt 60 -and (Test-Path -LiteralPath $product.exe); $i++) { Start-Sleep -Milliseconds 500 }
  if ((Test-Path -LiteralPath $product.exe) -or (Test-Path -LiteralPath $product.key)) { throw "Uninstalling $($product.name) left its program or registration." }
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
    Install-Product $products.ide "$label-ide"
    Install-Product $products.app "$label-app"
    $shortcuts = @{ ide = (Get-Shortcuts $products.ide.exe); app = (Get-Shortcuts $products.app.exe) }
    foreach ($name in 'ide', 'app') { if ($shortcuts[$name].Count -eq 0) { throw "$($products[$name].name) made no shortcut." } }
    # Neither product's shortcut is the other's.
    foreach ($link in $shortcuts.ide.Keys) { if ($shortcuts.app.ContainsKey($link)) { throw "Both products claim $link." } }
    Assert-Installed $products.ide $shortcuts.ide 'Installing the app'
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
}
$results
Write-Output 'PASS: Hydra IDE and the Hydra app install side by side, and uninstalling either, in both orders, leaves the other its program, registration, shortcuts and data.'
