param([Parameter(Mandatory = $true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# scripts/install.ps1 is the one-line installer's source of truth (README, "Install"). This
# runs it for real against a built HydraSetup.exe: a dry run with a deliberately wrong
# SHA256SUMS must be refused and install nothing, then a real fresh install and uninstall
# must both succeed. Like desktop-installer-test.ps1, this intentionally cannot be a local
# developer acceptance command.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'The install-script test runs only on disposable GitHub-hosted Windows runners.'
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$workspaceRoot = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path.TrimEnd('\') + '\'
if (-not $installer.StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer must be a workspace artifact.' }

$installScript = Join-Path $PSScriptRoot 'install.ps1'
$installFolder = Join-Path $env:LOCALAPPDATA 'Programs\Hydra'
$installedExe = Join-Path $installFolder 'Hydra.exe'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{4C372D32-54B2-43D8-8C63-ECC31D3744A8}_is1'
# desktop-installer-test.ps1 (run just before this step) uninstalls in its own finally block,
# so nothing of its own should be left; refuse rather than run over a leftover install.
if ((Test-Path -LiteralPath $installedExe) -or (Test-Path -LiteralPath $uninstallKey)) {
  throw 'Runner already has a Hydra install; refusing to run the install-script test.'
}

$testRoot = Join-Path $env:RUNNER_TEMP ('hydra-install-script-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$realSums = Join-Path $testRoot 'SHA256SUMS'
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($realSums, "$hash  HydraSetup.exe`n")
$wrongSums = Join-Path $testRoot 'SHA256SUMS.wrong'
[IO.File]::WriteAllText($wrongSums, (('0' * 64) + "  HydraSetup.exe`n"))

function Invoke-InstallScript([string]$label, [string[]]$scriptArgs) {
  $stdout = Join-Path $testRoot ($label + '.out.log')
  $stderr = Join-Path $testRoot ($label + '.err.log')
  $process = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $installScript) + $scriptArgs) `
    -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if ($process.ExitCode -ne 0) {
    Write-Output "---- $label stdout ----"; Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue
    Write-Output "---- $label stderr ----"; Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue
  }
  return $process.ExitCode
}

try {
  # A wrong SHA256SUMS must be refused, even as a dry run, and must install nothing.
  $wrongExit = Invoke-InstallScript 'dry-run-wrong-sums' @('-InstallerPath', $installer, '-SumsPath', $wrongSums, '-DryRun')
  if ($wrongExit -eq 0) { throw 'install.ps1 -DryRun accepted a wrong SHA256SUMS.' }
  if ((Test-Path -LiteralPath $installedExe) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'A refused dry run left something installed.' }

  # A real, correctly-verified install must land Hydra.exe under the default per-user folder.
  $installExit = Invoke-InstallScript 'install' @('-InstallerPath', $installer, '-SumsPath', $realSums)
  if ($installExit -ne 0) { throw "install.ps1 failed with exit code $installExit." }
  if (-not (Test-Path -LiteralPath $installedExe)) { throw 'install.ps1 reported success but Hydra.exe is missing.' }
  if (-not (Test-Path -LiteralPath $uninstallKey)) { throw 'install.ps1 reported success but Hydra is not registered.' }

  # The installer it ran must itself uninstall cleanly.
  $uninstaller = Join-Path $installFolder 'unins000.exe'
  $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -WindowStyle Hidden -Wait -PassThru
  if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstall failed with exit code $($uninstallProcess.ExitCode)." }
  if ((Test-Path -LiteralPath $installedExe) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Uninstall left Hydra behind.' }
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'PASS: install.ps1 refuses a wrong SHA256SUMS and installs nothing, then a correctly-verified fresh install lands Hydra.exe and the installer uninstalls cleanly.'
