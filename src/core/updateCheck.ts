import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * The in-app update prompt (README, "Updating"): find the latest full release on
 * GitHub, download its HydraSetup.exe, and check it against the release's SHA256SUMS.
 * No vscode import, so it is unit-tested with an injected fetch (tests/updateCheck.test.ts);
 * src/extensionUpdates.ts wires it to notifications. The Electron main process's signed
 * update path (desktop/main) is a separate, disabled mechanism.
 */

export const releasesLatestUrl = 'https://api.github.com/repos/ndunl075/hydra/releases/latest';
const downloadPrefix = (tag: string) => `https://github.com/ndunl075/hydra/releases/download/${tag}/`;
/** The only hosts a download may start at or be redirected to, always over https on the default port. */
export const allowedDownloadHosts: ReadonlySet<string> = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
export const maxRedirects = 5;
export const maxInstallerBytes = 300 * 1024 * 1024;
const maxApiBytes = 2 * 1024 * 1024;
const maxSumsBytes = 64 * 1024;
const apiTimeoutMs = 15_000;
/** A download that receives nothing for this long is abandoned. */
const idleTimeoutMs = 60_000;
const installerName = 'HydraSetup.exe';
const sumsName = 'SHA256SUMS';

/** The slice of fetch this module uses; the global fetch fits, and tests inject their own. */
export type FetchLike = (url: string, init: { headers?: Record<string, string>; redirect: 'manual'; signal?: AbortSignal }) => Promise<Response>;

export interface LatestRelease { version: string; tag: string; notesUrl: string; installerUrl: string; sumsUrl: string }
export type LatestReleaseResult = { release: LatestRelease; reason?: undefined } | { release?: undefined; reason: string };

const versionPattern = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

/** x.y.z only: a prerelease or build suffix ("1.2.3-beta") is not a version Hydra updates to. */
export function parseVersion(value: unknown): [number, number, number] | undefined {
  const match = typeof value === 'string' ? versionPattern.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** -1, 0 or 1 like a sort comparator; undefined when either side isn't a plain x.y.z. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return undefined;
  for (let index = 0; index < 3; index++) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]! ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean { return compareVersions(candidate, current) === 1; }

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Reads a response body up to `cap` bytes; more than that is refused, not truncated. */
async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) { await response.body?.cancel().catch(() => undefined); throw new Error(`the response is larger than ${cap} bytes`); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel().catch(() => undefined); throw new Error(`the response is larger than ${cap} bytes`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** An AbortSignal that fires on the caller's signal or after `ms`. */
function withTimeout(ms: number, outer?: AbortSignal): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
  const onAbort = () => controller.abort(outer?.reason ?? new Error('cancelled'));
  if (outer?.aborted) onAbort(); else outer?.addEventListener('abort', onAbort, { once: true });
  return { signal: controller.signal, done: () => { clearTimeout(timer); outer?.removeEventListener('abort', onAbort); } };
}

/**
 * GitHub's releases/latest for ndunl075/hydra, accepted only when it is a published full
 * release tagged v<x.y.z> with HydraSetup.exe and SHA256SUMS served from that tag's own
 * download folder. Never throws: anything else comes back as a reason for the log.
 */
export async function latestRelease(fetchImpl: FetchLike = fetch, options: { signal?: AbortSignal; userAgent?: string } = {}): Promise<LatestReleaseResult> {
  const timeout = withTimeout(apiTimeoutMs, options.signal);
  let payload: unknown;
  try {
    const response = await fetchImpl(releasesLatestUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': options.userAgent || 'Hydra-update-check', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'manual', signal: timeout.signal,
    });
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return { reason: `GitHub answered ${response.status}${response.status === 403 || response.status === 429 ? ' (rate limited; try again later)' : ''}` }; }
    payload = JSON.parse((await readCapped(response, maxApiBytes)).toString('utf8'));
  } catch (error) {
    return { reason: `couldn't reach GitHub: ${describe(error)}` };
  } finally { timeout.done(); }
  return releaseFromPayload(payload);
}

/** The validation half of latestRelease, on an already parsed payload. */
export function releaseFromPayload(payload: unknown): LatestReleaseResult {
  if (!payload || typeof payload !== 'object') return { reason: 'the release is not a JSON object' };
  const release = payload as { tag_name?: unknown; prerelease?: unknown; draft?: unknown; html_url?: unknown; assets?: unknown };
  const tag = release.tag_name;
  if (typeof tag !== 'string' || !tag.startsWith('v') || !parseVersion(tag.slice(1))) return { reason: `the latest tag ${JSON.stringify(tag)} is not v<x.y.z>` };
  if (release.prerelease !== false) return { reason: `${tag} is a prerelease` };
  if (release.draft !== false) return { reason: `${tag} is a draft` };
  const assets = Array.isArray(release.assets) ? release.assets as { name?: unknown; browser_download_url?: unknown }[] : [];
  const asset = (name: string): string | undefined => {
    const matches = assets.filter(item => item && item.name === name);
    const url = matches.length === 1 ? matches[0]!.browser_download_url : undefined;
    return typeof url === 'string' && url.startsWith(downloadPrefix(tag)) && url.length > downloadPrefix(tag).length ? url : undefined;
  };
  const installerUrl = asset(installerName), sumsUrl = asset(sumsName);
  if (!installerUrl) return { reason: `${tag} has no ${installerName} from its own GitHub download folder` };
  if (!sumsUrl) return { reason: `${tag} has no ${sumsName} from its own GitHub download folder` };
  const releasePage = `https://github.com/ndunl075/hydra/releases/tag/${tag}`;
  const notesUrl = typeof release.html_url === 'string' && release.html_url === releasePage ? release.html_url : releasePage;
  return { release: { version: tag.slice(1), tag, notesUrl, installerUrl, sumsUrl } };
}

/** https, no credentials, default port, and one of allowedDownloadHosts. */
export function allowedDownloadUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && allowedDownloadHosts.has(url.hostname);
}

/** GETs `url`, following at most maxRedirects redirects, each of them to an allowed host; returns the final 200 response. */
async function getFollowing(fetchImpl: FetchLike, url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!allowedDownloadUrl(current)) throw new Error(`refused to download from ${safeUrl(current)}`);
    const response = await fetchImpl(current, { headers: { 'User-Agent': 'Hydra-update-check', Accept: 'application/octet-stream' }, redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location) throw new Error(`a redirect from ${safeUrl(current)} had no location`);
      if (hop + 1 > maxRedirects) throw new Error(`more than ${maxRedirects} redirects`);
      current = new URL(location, current).href;
      continue;
    }
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw new Error(`${safeUrl(current)} answered ${response.status}`); }
    return response;
  }
}

/** Scheme, host and path only: signed download URLs carry tokens in the query. */
function safeUrl(value: string): string {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return 'an invalid URL'; }
}

/** Exactly one non-empty line, `<64 hex>  HydraSetup.exe` (sha256sum's text or binary marker). */
export function parseSums(text: string): string {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length !== 1) throw new Error(`${sumsName} must have exactly one line, and has ${lines.length}`);
  const match = /^([0-9a-fA-F]{64}) [ *]HydraSetup\.exe$/.exec(lines[0]!.trim());
  if (!match) throw new Error(`${sumsName} has no ${installerName} line`);
  return match[1]!.toLowerCase();
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface DownloadOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Bytes received so far, and the declared total when the server sent one. */
  onProgress?: (received: number, total?: number) => void;
  maxBytes?: number;
}

/**
 * Downloads the release's SHA256SUMS and HydraSetup.exe into `<dir>/HydraSetup-<version>.exe`,
 * hashing while it streams. The installer is written under a temporary name and renamed only
 * once its hash matches; on any failure the partial file is removed. A file already at the
 * final name is reused when it matches, so a second Update doesn't download again.
 */
export async function downloadVerified(release: LatestRelease, dir: string, options: DownloadOptions = {}): Promise<{ file: string; sha256: string; reused: boolean }> {
  const fetchImpl = options.fetch ?? fetch;
  const cap = options.maxBytes ?? maxInstallerBytes;
  if (!parseVersion(release.version) || release.tag !== `v${release.version}`) throw new Error('The release version is not x.y.z.');
  for (const url of [release.installerUrl, release.sumsUrl]) if (!url.startsWith(downloadPrefix(release.tag))) throw new Error(`Refused a download outside ${downloadPrefix(release.tag)}.`);

  const sumsTimeout = withTimeout(apiTimeoutMs, options.signal);
  let expected: string;
  try {
    expected = parseSums((await readCapped(await getFollowing(fetchImpl, release.sumsUrl, sumsTimeout.signal), maxSumsBytes)).toString('utf8'));
  } catch (error) { throw new Error(`Couldn't read ${sumsName}: ${describe(error)}`); } finally { sumsTimeout.done(); }

  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `HydraSetup-${release.version}.exe`);
  if (await sha256File(file).then(hash => hash === expected, () => false)) return { file, sha256: expected, reused: true };

  const partial = `${file}.${randomBytes(4).toString('hex')}.partial`;
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error('cancelled'));
  if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new Error(`no data for ${idleTimeoutMs / 1000} s`)), idleTimeoutMs); };
  const handle = await open(partial, 'wx');
  let closed = false;
  try {
    touch();
    const response = await getFollowing(fetchImpl, release.installerUrl, controller.signal);
    const declared = Number(response.headers.get('content-length'));
    const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;
    if (total !== undefined && total > cap) { await response.body?.cancel().catch(() => undefined); throw new Error(`the installer is larger than ${Math.round(cap / 1024 / 1024)} MB`); }
    if (!response.body) throw new Error('the installer download was empty');
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    // Cancel or the idle timeout stop the read even if the body ignores the fetch signal.
    const stopReading = () => { void reader.cancel().catch(() => undefined); };
    if (controller.signal.aborted) stopReading(); else controller.signal.addEventListener('abort', stopReading, { once: true });
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (done) break;
      touch();
      received += value.byteLength;
      if (received > cap) { await reader.cancel().catch(() => undefined); throw new Error(`the installer is larger than ${Math.round(cap / 1024 / 1024)} MB`); }
      hash.update(value);
      await handle.write(value);
      options.onProgress?.(received, total);
    }
    if (total !== undefined && received !== total) throw new Error(`the download ended early (${received} of ${total} bytes)`);
    await handle.close(); closed = true;
    const actual = hash.digest('hex');
    if (actual !== expected) throw new Error(`HydraSetup.exe doesn't match ${sumsName} (expected ${expected}, got ${actual}); the download was deleted`);
    await rename(partial, file);
    return { file, sha256: actual, reused: false };
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await rm(partial, { force: true }).catch(() => undefined);
    const reason = controller.signal.aborted ? describe(controller.signal.reason) : describe(error);
    throw new Error(`Couldn't download Hydra ${release.version}: ${reason}`);
  } finally {
    clearTimeout(idle);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

// ---- Eligibility ----

export interface EligibilityInput { platform: string; production: boolean; execPath: string; exists: (file: string) => boolean; testRun?: boolean }

/** Only an installed Hydra on Windows (unins000.exe beside the running exe), in a production window, updates itself. */
export function updateEligibility(input: EligibilityInput): { eligible: true; installDir: string } | { eligible: false; reason: string } {
  if (input.platform !== 'win32') return { eligible: false, reason: 'In-app updates are Windows-only for now.' };
  if (!input.production || input.testRun) return { eligible: false, reason: "This is a development window, so Hydra doesn't update it." };
  const installDir = path.win32.dirname(input.execPath);
  if (!input.exists(path.win32.join(installDir, 'unins000.exe'))) return { eligible: false, reason: "This Hydra wasn't installed with HydraSetup.exe, so it can't update itself." };
  return { eligible: true, installDir };
}

// ---- The confirm text ----

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "2 heads and 1 lane are running and will be stopped." (empty when nothing runs), plus a line when Stop All Agents is on. */
export function runningNotice(heads: number, lanes: number, stopped: boolean): string {
  const parts = [heads > 0 ? count(heads, 'head') : '', lanes > 0 ? count(lanes, 'lane') : ''].filter(Boolean);
  const lines: string[] = [];
  if (parts.length) lines.push(`${parts.join(' and ')} ${heads + lanes === 1 ? 'is' : 'are'} running and will be stopped.`);
  if (stopped) lines.push('Stop All Agents is on, and stays on after the restart.');
  return lines.join(' ');
}

// ---- The update helper ----

export const installerArguments = ['/SILENT', '/SP-', '/SUPPRESSMSGBOXES', '/NORESTART', '/NORESTARTAPPLICATIONS', '/MERGETASKS=!runcode'] as const;
/** How long the helper waits for Hydra to close before giving up on the update. */
export const helperWaitMinutes = 10;
/**
 * The built-in extension's scripts that other programs run with Hydra.exe as their runtime: the MCP server Claude
 * Code and Codex start, the usage-limit hook, and the `hydra` command. They keep Hydra.exe in use, and the MCP server
 * runs as long as its app does, so the helper stops them once Hydra's own windows have closed; their apps start them
 * again when they next need them.
 */
export const helperBridgeScripts = ['hydra-mcp.cjs', 'hydra-limit-hook.cjs', 'hydra-cli.cjs'] as const;

/**
 * A single-quoted PowerShell string literal. PowerShell treats the typographic single
 * quotes (U+2018..U+201B) as quote marks too, so each is doubled like '. Control
 * characters never belong in these paths and are refused.
 */
export function psQuote(value: string): string {
  if (/[\u0000-\u001f]/.test(value)) throw new Error('A path for the update helper has a control character.');
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`;
}

export interface HelperScriptInput { installer: string; installDir: string; exe: string; log: string }

/**
 * The PowerShell started through WMI just before Hydra quits (updateLauncherArguments): wait (bounded) until
 * Hydra itself has closed, stop the bridges other programs run on Hydra.exe (helperBridgeScripts), wait until no
 * process from the install folder runs, run the installer silently, log its exit code, reopen Hydra. It deletes nothing but the downloaded installer, and only after it succeeded.
 * Written with a UTF-8 BOM (updateHelperFileContents) so Windows PowerShell reads non-ASCII paths.
 */
export function updateHelperScript(input: HelperScriptInput): string {
  return [
    '# Hydra update helper: written by Hydra just before it closed to install an update.',
    "$ErrorActionPreference = 'Continue'",
    `$installer = ${psQuote(input.installer)}`,
    `$installDir = ${psQuote(input.installDir)}`,
    `$exe = ${psQuote(input.exe)}`,
    `$log = ${psQuote(input.log)}`,
    'function Write-Log([string]$message) {',
    "  try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $message) -Encoding UTF8 } catch { }",
    '}',
    "$root = [System.IO.Path]::GetFullPath($installDir).TrimEnd('\\') + '\\'",
    'function Get-HydraProcesses {',
    '  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) })',
    '}',
    `$bridgeScripts = @(${helperBridgeScripts.map(name => psQuote(`\\resources\\app\\extensions\\hydra-agent-manager\\dist\\${name}`)).join(', ')})`,
    'function Test-Bridge($process) {',
    '  $line = [string]$process.CommandLine',
    '  foreach ($script in $bridgeScripts) { if ($line.IndexOf($script, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true } }',
    '  return $false',
    '}',
    "Write-Log ('Waiting for Hydra in ' + $root + ' to close.')",
    `$deadline = (Get-Date).AddMinutes(${helperWaitMinutes})`,
    'while (@(Get-HydraProcesses | Where-Object { -not (Test-Bridge $_) }).Count -gt 0) {',
    '  if ((Get-Date) -gt $deadline) {',
    `    Write-Log 'Hydra was still running after ${helperWaitMinutes} minutes, so the update was not installed.'`,
    '    exit 1',
    '  }',
    '  Start-Sleep -Seconds 1',
    '}',
    'foreach ($bridge in @(Get-HydraProcesses | Where-Object { Test-Bridge $_ })) {',
    "  Write-Log ('Stopping ' + $bridge.ProcessId + ', a Hydra bridge another app runs, so the update can replace it; that app starts it again when it needs it.')",
    '  Stop-Process -Id $bridge.ProcessId -Force -ErrorAction SilentlyContinue',
    '}',
    'while ((Get-HydraProcesses).Count -gt 0) {',
    '  if ((Get-Date) -gt $deadline) {',
    `    Write-Log 'Hydra was still running after ${helperWaitMinutes} minutes, so the update was not installed.'`,
    '    exit 1',
    '  }',
    '  Start-Sleep -Seconds 1',
    '}',
    'Start-Sleep -Seconds 2',
    "Write-Log ('Running ' + $installer)",
    '$code = -1',
    'try {',
    `  $process = Start-Process -FilePath $installer -ArgumentList ${installerArguments.map(argument => psQuote(argument)).join(',')} -Wait -PassThru`,
    '  $code = $process.ExitCode',
    '} catch {',
    "  Write-Log ('The installer did not start: ' + $_.Exception.Message)",
    '}',
    "Write-Log ('The installer exited with code ' + $code + '.')",
    'if ($code -eq 0) { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }',
    "Write-Log ('Reopening ' + $exe)",
    'try { Start-Process -FilePath $exe } catch { Write-Log (\'Hydra did not reopen: \' + $_.Exception.Message) }',
    '',
  ].join('\r\n');
}

/** The script file's bytes: a UTF-8 BOM, then the script. */
export function updateHelperFileContents(input: HelperScriptInput): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(updateHelperScript(input), 'utf8')]);
}

/**
 * How the helper is started: a short hidden PowerShell asks WMI (Win32_Process.Create, window
 * hidden) to start it, then exits. A WMI-created process has WmiPrvSE as its parent and belongs
 * to no job, so nothing about Hydra's own process tree (the extension host, a job object) can end
 * it when Hydra quits; it also starts with the user's default environment, not the extension
 * host's. Passed as -EncodedCommand, so no path needs quoting on the command line. Exit code 0
 * means the helper is running.
 */
export function updateLauncherArguments(powershell: string, helper: string): string[] {
  const helperCommand = `"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helper}"`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(helperCommand)}; ProcessStartupInformation = $startup }`,
    'if ($result.ReturnValue -ne 0) { exit 1 }',
    'exit 0',
  ].join('\n');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

// ---- Scheduling and the offer (the vscode side is src/extensionUpdates.ts) ----

export const firstCheckDelayMs = 30_000;
export const checkIntervalMs = 24 * 60 * 60 * 1000;

/** How long to wait before the next automatic check: at least 30 s after startup, then 24 h after the last one (in any window). */
export function nextAutoCheckDelay(lastCheck: number | undefined, now: number): number {
  const due = typeof lastCheck === 'number' && Number.isFinite(lastCheck) && lastCheck <= now ? lastCheck + checkIntervalMs - now : 0;
  return Math.max(firstCheckDelayMs, due);
}

export type UpdateOffer = { kind: 'offer'; message: string } | { kind: 'latest'; message: string } | { kind: 'skipped' } | { kind: 'unknown'; message: string };

/** What a check shows: an automatic one says nothing unless there is a newer version you haven't skipped. */
export function updateOffer(latest: string, current: string, skipped: string | undefined, manual: boolean): UpdateOffer {
  const order = compareVersions(latest, current);
  if (order === undefined) return { kind: 'unknown', message: `Hydra couldn't compare ${latest} with this version (${current}).` };
  if (order <= 0) return { kind: 'latest', message: `You're on the latest version (${current}).` };
  if (!manual && skipped === latest) return { kind: 'skipped' };
  return { kind: 'offer', message: `Hydra ${latest} is available (you have ${current}).` };
}

/**
 * The helper's environment: the extension host's, minus Electron's and VS Code's own
 * variables. ELECTRON_RUN_AS_NODE in particular would make the reopened Hydra.exe run
 * as plain Node instead of opening a window.
 */
export function helperEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(ELECTRON_|VSCODE_)/i.test(key)));
}
