# Opens a folder in the installed Hydra from a clean environment, for benchmark runs (docs/Benchmark.md).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-open.ps1 -Folder <repo> [-WaitSeconds 120]
#
# A window opened from a shell that runs inside Hydra or VS Code inherits that shell's ELECTRON_RUN_AS_NODE, its
# VSCODE_* IPC variables and its PATH: the new window can then attach to the wrong instance, or fail to find
# claude.exe, so every head fails with "Claude Code CLI not found". This starts hydra.cmd with PATH rebuilt from the
# Machine and User values in the registry, those variables removed, and no console window.
#
# With -WaitSeconds, it then runs `hydra status` in the folder (from the same clean environment) until a Hydra
# window owns it, or the time runs out (exit 1).
param(
  [Parameter(Mandatory = $true)][string]$Folder,
  [int]$WaitSeconds = 0,
  [string]$Hydra = "$env:LOCALAPPDATA\Programs\Hydra\bin\hydra.cmd"
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { Write-Error "No folder $Folder."; exit 2 }
if (-not (Test-Path -LiteralPath $Hydra)) { Write-Error "Hydra isn't installed at $Hydra."; exit 2 }
$Folder = (Resolve-Path -LiteralPath $Folder).Path

# Variables a shell inside VS Code or Hydra sets, which a new window must not inherit.
$inherited = @('ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PID', 'VSCODE_CWD', 'VSCODE_NLS_CONFIG',
  'VSCODE_HANDLES_UNCAUGHT_ERRORS', 'VSCODE_CRASH_REPORTER_PROCESS_TYPE', 'VSCODE_ESM_ENTRYPOINT', 'VSCODE_CODE_CACHE_PATH',
  'VSCODE_AMD_ENTRYPOINT', 'VSCODE_INJECTION', 'VSCODE_GIT_IPC_HANDLE', 'VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_GIT_ASKPASS_EXTRA_ARGS', 'VSCODE_L10N_BUNDLE_LOCATION', 'VSCODE_DEV')
$cleanPath = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

function Start-Clean([string]$arguments, [bool]$capture) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Hydra
  $psi.Arguments = $arguments
  $psi.WorkingDirectory = $Folder
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $capture
  $psi.RedirectStandardError = $capture
  foreach ($name in @($psi.EnvironmentVariables.Keys)) {
    if ($inherited -contains $name -or $name -like 'VSCODE_*') { [void]$psi.EnvironmentVariables.Remove($name) }
  }
  $psi.EnvironmentVariables['Path'] = $cleanPath
  return [System.Diagnostics.Process]::Start($psi)
}

$open = Start-Clean ('"' + $Folder + '"') $false
[void]$open.WaitForExit(60000)
Write-Output "Asked Hydra to open $Folder (exit $($open.ExitCode))."
if ($WaitSeconds -le 0) { exit 0 }

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $status = Start-Clean 'status' $true
  $text = $status.StandardOutput.ReadToEnd() + $status.StandardError.ReadToEnd()
  [void]$status.WaitForExit(30000)
  if ($status.ExitCode -eq 0 -and $text -match 'Hydra window \d+ owns') { Write-Output $text.Trim(); exit 0 }
}
Write-Error "No Hydra window owns $Folder after $WaitSeconds seconds. Is the folder trusted?"
exit 1
