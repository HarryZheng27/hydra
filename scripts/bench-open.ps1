# Opens a folder in the installed Hydra from a clean environment, for benchmark runs (docs/Benchmark.md).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench-open.ps1 -Folder <repo> [-WaitSeconds 120]
#
# A window opened from a shell that runs inside a Hydra window inherits that shell's ELECTRON_RUN_AS_NODE, its
# VSCODE_* IPC variables and its PATH: the new window can then attach to the wrong instance, or fail to find
# claude.exe, so every head fails with "Claude Code CLI not found". This starts hydra.cmd with PATH rebuilt from the
# Machine and User values in the registry, those variables removed, and no console window.
#
# With -WaitSeconds, it then runs `hydra status` in the folder (from the same clean environment) until a Hydra
# window owns it, or the time runs out (exit 1).
#
# It records in the folder's .git (hydra-bench-window.json) whether a window already had the folder open before it
# ran, and which window owns it after. The harness closes only a window this opened (scripts/benchmark-windows.mjs),
# never one that was already open.
param(
  [Parameter(Mandatory = $true)][string]$Folder,
  [int]$WaitSeconds = 0,
  [string]$Hydra = "$env:LOCALAPPDATA\Programs\Hydra\bin\hydra.cmd"
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { Write-Error "No folder $Folder."; exit 2 }
if (-not (Test-Path -LiteralPath $Hydra)) { Write-Error "Hydra isn't installed at $Hydra."; exit 2 }
$Folder = (Resolve-Path -LiteralPath $Folder).Path

# Variables a shell inside a Hydra window sets, which a new window must not inherit.
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

function Get-Normal([string]$value) { return [IO.Path]::GetFullPath($value).TrimEnd('\', '/').ToLowerInvariant() }

# The window that owns this folder itself (not a parent folder's), from `hydra status --json`, or $null.
function Get-Owner {
  $status = Start-Clean 'status --json' $true
  # Read both streams without blocking, so a `hydra status` that hangs can't hang this: it gets 30 seconds, then
  # it and anything it started are killed and the next try comes.
  $stdoutTask = $status.StandardOutput.ReadToEndAsync()
  $stderrTask = $status.StandardError.ReadToEndAsync()
  if (-not $status.WaitForExit(30000)) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $status.Id /T /F 2>&1 | Out-Null
    return $null
  }
  $text = ''
  if ($stdoutTask.Wait(5000)) { $text = $stdoutTask.Result }
  [void]$stderrTask.Wait(5000)
  if ($status.ExitCode -ne 0 -or -not $text) { return $null }
  try { $answer = $text | ConvertFrom-Json } catch { return $null }
  if (-not $answer.repository -or -not $answer.window) { return $null }
  if ((Get-Normal $answer.repository) -ne (Get-Normal $Folder)) { return $null }
  return $answer
}

# Whether a window already had this folder open, recorded before opening it (hydra-bench-window.json in its .git).
$gitDir = Join-Path $Folder '.git'
$marker = Join-Path $gitDir 'hydra-bench-window.json'
$before = Get-Owner
$preexisting = $null -ne $before
if ($preexisting -and (Test-Path -LiteralPath $marker)) {
  # A window this script opened earlier and that is still open stays the harness's own.
  try { $old = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json } catch { $old = $null }
  if ($old -and $old.preexisting -eq $false -and $old.pid -eq $before.window.pid) { $preexisting = $false }
}
function Write-Marker($ownerPid) {
  if (-not (Test-Path -LiteralPath $gitDir -PathType Container)) { return }
  $record = [ordered]@{ version = 1; folder = $Folder; preexisting = $preexisting; pid = $ownerPid; at = (Get-Date).ToUniversalTime().ToString('o') }
  [IO.File]::WriteAllText($marker, ($record | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
}
if ($before) { Write-Marker ([int]$before.window.pid) } else { Write-Marker $null }
if ($preexisting) { Write-Output "A Hydra window ($($before.window.pid)) already had $Folder open: the harness will leave it open." }

$open = Start-Clean ('"' + $Folder + '"') $false
[void]$open.WaitForExit(60000)
Write-Output "Asked Hydra to open $Folder (exit $($open.ExitCode))."
if ($WaitSeconds -le 0) { exit 0 }

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $owner = Get-Owner
  if ($owner) {
    Write-Marker ([int]$owner.window.pid)
    Write-Output "Hydra window $($owner.window.pid) owns $($owner.repository)"
    exit 0
  }
}
Write-Error "No Hydra window owns $Folder after $WaitSeconds seconds. Is the folder trusted?"
exit 1
