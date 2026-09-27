# Hydra's one-line installer.
#
#   irm https://www.usefrontierdigital.com/hydra/install.ps1 | iex
#
# This file (scripts/install.ps1 in ndunl075/hydra) is the only copy: the website redirects
# that URL to it on main. It downloads the latest full release of
# Hydra from GitHub (ndunl075/hydra), checks it against the release's SHA256SUMS, and
# runs it silently. It never asks for admin and never changes your execution policy.
#
# Everything lives inside a function so that piping this script to iex doesn't leave
# variables behind in your PowerShell session. The top-level param() below only matters
# when this file is run directly, for example:
#
#   powershell -File scripts/install.ps1 -Version 0.25.0
#   powershell -File scripts/install.ps1 -DryRun
#   powershell -File scripts/install.ps1 -InstallerPath .\HydraSetup.exe -SumsPath .\SHA256SUMS
#
# When piped to iex, use $env:HYDRA_INSTALL_VERSION instead of -Version to pick a
# specific release; the default installs the latest full release.
[CmdletBinding()]
param(
  [string]$Version = $env:HYDRA_INSTALL_VERSION,
  [switch]$DryRun,
  [string]$InstallerPath,
  [string]$SumsPath
)

function Install-Hydra {
  [CmdletBinding()]
  param(
    [string]$Version,
    [switch]$DryRun,
    [string]$InstallerPath,
    [string]$SumsPath
  )
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'

  $repo = 'ndunl075/hydra'
  $installerName = 'HydraSetup.exe'
  $sumsName = 'SHA256SUMS'
  $installFolder = Join-Path $env:LOCALAPPDATA 'Programs\Hydra'

  # ---- Platform checks ----

  $psVersion = $PSVersionTable.PSVersion
  if ($psVersion.Major -lt 5 -or ($psVersion.Major -eq 5 -and $psVersion.Minor -lt 1)) {
    throw "This needs Windows PowerShell 5.1 or later (found $psVersion)."
  }
  $isWindowsHost = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
  if (-not $isWindowsHost) {
    throw 'Hydra is a Windows desktop app; this installer only runs on Windows.'
  }
  if (-not [System.Environment]::Is64BitOperatingSystem) {
    throw 'Hydra is a 64-bit (x64) app; this is a 32-bit Windows, so it cannot be installed here.'
  }
  $architecture = $null
  try { $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { $architecture = $null }
  if (-not $architecture) { $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
  if ($architecture -match 'Arm') {
    throw "Hydra's installer is built for x64 only; this machine is $architecture (ARM64), so it cannot be installed here."
  }

  # Windows PowerShell 5.1 defaults to an older TLS; PowerShell 7 already supports TLS 1.2.
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12 } catch { }
  }

  # ---- Resolve which HydraSetup.exe and SHA256SUMS to use ----

  $usingLocalFiles = [bool]$InstallerPath -or [bool]$SumsPath
  if ($usingLocalFiles -and (-not $InstallerPath -or -not $SumsPath)) {
    throw '-InstallerPath and -SumsPath must be used together.'
  }

  $downloadDir = $null
  if ($usingLocalFiles) {
    if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw "Installer not found: $InstallerPath" }
    if (-not (Test-Path -LiteralPath $SumsPath -PathType Leaf)) { throw "$sumsName not found: $SumsPath" }
    $installerFile = (Resolve-Path -LiteralPath $InstallerPath).Path
    $sumsFile = (Resolve-Path -LiteralPath $SumsPath).Path
    Write-Host "Using local files: $installerFile"
  } else {
    if ($Version) {
      if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "-Version must look like x.y.z (got '$Version')." }
      $tag = "v$Version"
      $releaseUri = "https://api.github.com/repos/$repo/releases/tags/$tag"
    } else {
      $releaseUri = "https://api.github.com/repos/$repo/releases/latest"
    }
    Write-Host 'Checking the latest Hydra release on GitHub...'
    $release = Resolve-HydraRelease -Uri $releaseUri -Repo $repo -InstallerName $installerName -SumsName $sumsName
    Write-Host "Found Hydra $($release.Version) ($($release.Tag))."

    $downloadDir = Join-Path $env:TEMP ('hydra-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
    $installerFile = Join-Path $downloadDir $installerName
    $sumsFile = Join-Path $downloadDir $sumsName
    try {
      Get-HydraDownload -Uri $release.SumsUrl -OutFile $sumsFile -Label $sumsName
      Get-HydraDownload -Uri $release.InstallerUrl -OutFile $installerFile -Label $installerName
    } catch {
      Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue
      throw
    }
  }

  # ---- Verify the installer's hash before doing anything with it ----

  Write-Host "Verifying $installerName against $sumsName..."
  $expectedHash = Read-InstallerSha256 -SumsPath $sumsFile -InstallerName $installerName
  $actualHash = (Get-FileHash -LiteralPath $installerFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    if ($downloadDir) { Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue }
    throw "$installerName does not match $sumsName (expected $expectedHash, got $actualHash)."
  }
  Write-Host 'Checksum matches.'

  if ($DryRun) {
    Write-Host ''
    Write-Host 'Dry run: verified, not installing.'
    Write-Host "  $installerFile"
    Write-Host "  $sumsFile"
    return
  }

  # ---- Refuse to install over a running Hydra instead of killing it ----

  $installRoot = ([System.IO.Path]::GetFullPath($installFolder)).TrimEnd('\') + '\'
  $running = @(Get-Process -Name 'Hydra' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase) })
  if ($running.Count -gt 0) {
    throw "Hydra is running. Close it, then run this installer again."
  }

  # ---- Install ----

  Write-Host 'Installing Hydra (no admin needed)...'
  $installerArguments = @('/SILENT', '/SP-', '/SUPPRESSMSGBOXES', '/NORESTART', '/NORESTARTAPPLICATIONS', '/MERGETASKS=!runcode')
  $process = Start-Process -FilePath $installerFile -ArgumentList $installerArguments -Wait -PassThru
  Write-Host "Installer exit code: $($process.ExitCode)"
  if ($process.ExitCode -ne 0) {
    throw "The Hydra installer failed with exit code $($process.ExitCode)."
  }

  if ($downloadDir) { Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue }

  Write-Host ''
  Write-Host "Hydra is installed at $installFolder"
  Write-Host 'Start it from the Start Menu, or run:'
  Write-Host "  $installFolder\Hydra.exe"
}

# GitHub's releases/latest (or releases/tags/<tag>) for ndunl075/hydra, accepted only
# when it is a published full release tagged v<x.y.z> with exactly one HydraSetup.exe
# and one SHA256SUMS asset, both served from that tag's own download folder. This
# mirrors the checks in src/core/updateCheck.ts (releaseFromPayload).
function Resolve-HydraRelease {
  param([string]$Uri, [string]$Repo, [string]$InstallerName, [string]$SumsName)
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'Hydra-install-script'; 'X-GitHub-Api-Version' = '2022-11-28' }
  try {
    $release = Invoke-RestMethod -Uri $Uri -Headers $headers -UseBasicParsing
  } catch {
    $status = $null
    if ($_.Exception.PSObject.Properties.Match('Response').Count -gt 0 -and $_.Exception.Response) {
      try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = $null }
    }
    $hint = ''
    if ($status -eq 403 -or $status -eq 429) { $hint = ' (GitHub rate-limited this request; try again in a bit.)' }
    elseif ($status -eq 404) { $hint = ' (no such release.)' }
    throw "Couldn't reach GitHub: $($_.Exception.Message)$hint"
  }
  $tag = $release.tag_name
  if ($tag -notmatch '^v\d+\.\d+\.\d+$') { throw "The release tag '$tag' is not v<x.y.z>." }
  if ($release.prerelease -ne $false) { throw "$tag is a prerelease." }
  if ($release.draft -ne $false) { throw "$tag is a draft." }

  $prefix = "https://github.com/$Repo/releases/download/$tag/"
  $assets = @($release.assets)
  $installerAssets = @($assets | Where-Object { $_.name -eq $InstallerName })
  $sumsAssets = @($assets | Where-Object { $_.name -eq $SumsName })
  if ($installerAssets.Count -ne 1) { throw "$tag does not have exactly one $InstallerName asset." }
  if ($sumsAssets.Count -ne 1) { throw "$tag does not have exactly one $SumsName asset." }
  $installerUrl = $installerAssets[0].browser_download_url
  $sumsUrl = $sumsAssets[0].browser_download_url
  if (-not $installerUrl.StartsWith($prefix, [System.StringComparison]::Ordinal)) { throw "$tag's $InstallerName isn't served from its own release folder." }
  if (-not $sumsUrl.StartsWith($prefix, [System.StringComparison]::Ordinal)) { throw "$tag's $SumsName isn't served from its own release folder." }

  [PSCustomObject]@{ Tag = $tag; Version = $tag.Substring(1); InstallerUrl = $installerUrl; SumsUrl = $sumsUrl }
}

# Exactly one non-empty line, "<64 hex> [ *]HydraSetup.exe" (sha256sum's text or binary
# marker), same shape src/core/updateCheck.ts's parseSums requires.
function Read-InstallerSha256 {
  param([string]$SumsPath, [string]$InstallerName)
  $lines = @(Get-Content -LiteralPath $SumsPath | Where-Object { $_.Trim() -ne '' })
  if ($lines.Count -ne 1) { throw "$SumsPath must have exactly one line, and has $($lines.Count)." }
  $pattern = "^([0-9a-fA-F]{64}) [ \*]$([regex]::Escape($InstallerName))`$"
  if ($lines[0].Trim() -match $pattern) { return $Matches[1].ToLowerInvariant() }
  throw "$SumsPath has no $InstallerName line."
}

# Downloads a file with a short progress line either side. $ProgressPreference is
# restored afterwards; SilentlyContinue avoids Invoke-WebRequest's slow default
# progress bar, which is especially slow on Windows PowerShell 5.1.
function Get-HydraDownload {
  param([string]$Uri, [string]$OutFile, [string]$Label)
  Write-Host "Downloading $Label..."
  $previousProgressPreference = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -Headers @{ 'User-Agent' = 'Hydra-install-script' }
  } finally {
    $ProgressPreference = $previousProgressPreference
  }
  $bytes = (Get-Item -LiteralPath $OutFile).Length
  Write-Host ("Downloaded {0} ({1:N1} MB)." -f $Label, ($bytes / 1MB))
}

try {
  Install-Hydra -Version $Version -DryRun:$DryRun -InstallerPath $InstallerPath -SumsPath $SumsPath
  if ($PSCommandPath) { exit 0 }
} catch {
  Write-Host "Hydra install failed: $($_.Exception.Message)" -ForegroundColor Red
  if ($PSCommandPath) { exit 1 }
}
