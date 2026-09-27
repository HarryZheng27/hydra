import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * scripts/install.ps1 is the source of truth for the one-line installer served at
 * https://www.usefrontierdigital.com/hydra/install.ps1 (README, "Install"). This file
 * doesn't run the installer (that needs Windows and a real install), so it just checks
 * the script's text for the pieces the installer contract requires, plus (when
 * powershell.exe is available) that the file parses as valid PowerShell.
 */
const scriptPath = path.join(__dirname, '..', 'scripts', 'install.ps1');
const script = readFileSync(scriptPath, 'utf8');

test('install.ps1 resolves the release through the same API GitHub serves to the in-app updater', () => {
  assert.match(script, /https:\/\/api\.github\.com\/repos\/\$repo\/releases\/latest/);
  assert.match(script, /https:\/\/api\.github\.com\/repos\/\$repo\/releases\/tags\/\$tag/);
  assert.match(script, /repo\s*=\s*'ndunl075\/hydra'/);
});

test('install.ps1 requires a published full release tagged v<x.y.z>', () => {
  assert.match(script, /-notmatch\s+'\^v\\d\+\\\.\\d\+\\\.\\d\+\$'/);
  assert.match(script, /release\.prerelease -ne \$false/);
  assert.match(script, /release\.draft -ne \$false/);
});

test('install.ps1 requires exactly one HydraSetup.exe and one SHA256SUMS asset from the tag\'s own download folder', () => {
  assert.match(script, /installerAssets\.Count -ne 1/);
  assert.match(script, /sumsAssets\.Count -ne 1/);
  assert.match(script, /releases\/download\/\$tag\//);
  assert.match(script, /StartsWith\(\$prefix, \[System\.StringComparison\]::Ordinal\)/g);
});

test('install.ps1 verifies the installer\'s SHA-256 against SHA256SUMS before installing', () => {
  // .NET, not Get-FileHash: Windows PowerShell started from PowerShell 7 can't load Get-FileHash.
  assert.match(script, /\$actualHash = Get-Sha256 -Path \$installerFile/);
  assert.match(script, /\[System\.Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.doesNotMatch(script, /Get-FileHash\s+-/, 'no call to Get-FileHash (comments may name it)');
  assert.match(script, /\$actualHash -ne \$expectedHash/);
  assert.match(script, /\[0-9a-fA-F\]\{64\}/);
  // A hash mismatch is checked, and the download is cleaned up, before the DryRun early-return,
  // so a DryRun with a wrong SHA256SUMS still fails instead of silently "passing".
  const mismatchIndex = script.indexOf('$actualHash -ne $expectedHash');
  const dryRunIndex = script.indexOf('if ($DryRun) {');
  assert.ok(mismatchIndex > -1 && dryRunIndex > -1 && mismatchIndex < dryRunIndex, 'the checksum check must run before the DryRun early return');
});

test('install.ps1 runs the installer with the same silent flags as the in-app updater', () => {
  assert.match(script, /'\/SILENT', '\/SP-', '\/SUPPRESSMSGBOXES', '\/NORESTART', '\/NORESTARTAPPLICATIONS', '\/MERGETASKS=!runcode'/);
});

test('install.ps1 refuses non-Windows, 32-bit and ARM64 hosts, and never elevates or touches execution policy', () => {
  assert.match(script, /this installer only runs on Windows/);
  assert.match(script, /32-bit Windows, so it cannot be installed here/);
  assert.match(script, /ARM64\), so it cannot be installed here/);
  assert.doesNotMatch(script, /RunAsAdministrator/);
  assert.doesNotMatch(script, /Set-ExecutionPolicy/);
});

test('install.ps1 enables TLS 1.2 for Windows PowerShell 5.1', () => {
  assert.match(script, /SecurityProtocolType\]::Tls12/);
});

test('install.ps1 supports -Version, -DryRun, -InstallerPath/-SumsPath, and the HYDRA_INSTALL_VERSION env fallback', () => {
  assert.match(script, /\[string\]\$Version = \$env:HYDRA_INSTALL_VERSION/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[string\]\$InstallerPath/);
  assert.match(script, /\[string\]\$SumsPath/);
});

test('install.ps1 refuses to overwrite a running Hydra instead of killing it', () => {
  assert.match(script, /Get-Process -Name 'Hydra'/);
  assert.match(script, /Hydra is running\. Close it, then run this installer again\./);
});

test('install.ps1 wraps its work in a function so a piped run does not leak variables into the caller\'s session', () => {
  assert.match(script, /function Install-Hydra \{/);
  assert.match(script, /Set-StrictMode -Version Latest/);
  assert.match(script, /\$ErrorActionPreference = 'Stop'/);
});

const powershell = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['powershell.exe'], { encoding: 'utf8' });
const hasPowerShell = powershell.status === 0 && powershell.stdout.trim().length > 0;

test('install.ps1 parses as valid PowerShell (parse only; nothing is executed)', { skip: !hasPowerShell ? 'powershell.exe was not found on PATH' : false }, () => {
  const command = [
    '$ErrorActionPreference = "Stop"',
    '$errors = $null; $tokens = $null',
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors)`,
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.ToString() }; exit 1 } else { exit 0 }',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `PowerShell parse errors:\n${result.stderr}`);
});
