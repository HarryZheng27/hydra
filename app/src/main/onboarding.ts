import { spawn } from 'node:child_process';
import path from 'node:path';
import { checkProvider } from '../../../src/core/diagnostics';
import { supportedCliDescription, supportedCliMinimum, supportedCliVersion } from '../../../src/core/cliVersions';
import { claudeWrittenServer, codexWrittenBlock, providerPaths, type ProviderPaths } from '../../../src/core/helperRegistration';
import { cmdUnsafe } from '../../../src/core/process';
import { findProvider } from '../../../src/core/providers';
import type { CliProvider, OnboardingReport, ProviderStatus, RegistrationStatus } from '../shared/ipc';

/**
 * First-run checks for the app (G3 milestone 4). Everything here is read-only:
 * - each CLI is found (machine setting, else PATH) and asked only `--version` and `--help` (Codex also
 *   `app-server --help`) through core's checkProvider, then its version is checked against cliVersions;
 * - the user-level `hydra` MCP registration is looked up in Claude's and Codex's config files, never written;
 * - Sign in opens a console window running the CLI's own login, and reads nothing back.
 * No other provider process starts: G4 runs the start-up self-check (cliSelfCheck.ts) before a chat.
 */
export const providerNames: Record<CliProvider, string> = { claude: 'Claude Code', codex: 'Codex' };
const providers: CliProvider[] = ['claude', 'codex'];

export async function providerStatus(provider: CliProvider, configured: string | undefined, cwd: string): Promise<ProviderStatus> {
  const base = { provider, name: providerNames[provider], minimum: supportedCliMinimum(provider), requirement: supportedCliDescription(provider), configured: !!configured };
  let found;
  try { found = await findProvider(provider, configured); } catch (error) { return { ...base, found: false, supported: false, error: error instanceof Error ? error.message : String(error) }; }
  if (!found.available || !found.executable) {
    return { ...base, found: false, supported: false, error: configured ? `Hydra can't find ${configured}.` : `${providerNames[provider]} isn't on your PATH.` };
  }
  const diagnostic = await checkProvider({ provider, executable: found.executable, available: true }, cwd);
  if (diagnostic.status !== 'checked' || !diagnostic.version) {
    return { ...base, found: true, executable: found.executable, supported: false, error: diagnostic.error ?? 'The check failed.' };
  }
  const supported = supportedCliVersion(provider, diagnostic.version);
  return {
    ...base, found: true, executable: found.executable, version: diagnostic.version, supported, advertised: diagnostic.advertised,
    ...(supported ? {} : { error: `Hydra needs ${supportedCliDescription(provider)}; this is ${diagnostic.version}.` }),
  };
}

/**
 * Whether the user-level `hydra` MCP server is registered with each CLI. Reads the files and writes nothing. Only
 * `mcpServers.hydra` (Claude) and Hydra's marked block (Codex) are looked at; nothing else in them is kept or returned.
 */
export async function registrationStatus(paths: ProviderPaths = providerPaths()): Promise<Record<CliProvider, RegistrationStatus>> {
  const hide = () => '•••';
  const look = async (find: () => Promise<string | undefined>, where: string): Promise<RegistrationStatus> => {
    try { return { registered: (await find()) !== undefined, where }; } catch (error) { return { registered: false, where, error: error instanceof Error ? error.message : String(error) }; }
  };
  const [claude, codex] = await Promise.all([
    look(() => claudeWrittenServer(paths, hide), paths.claudeJson),
    look(() => codexWrittenBlock(paths.codexConfig, hide), paths.codexConfig),
  ]);
  return { claude, codex };
}

export async function onboardingReport(cliPaths: Partial<Record<CliProvider, string>>, cwd: string): Promise<OnboardingReport> {
  const [statuses, registration] = await Promise.all([Promise.all(providers.map(provider => providerStatus(provider, cliPaths[provider], cwd))), registrationStatus()]);
  return { providers: statuses, registration, checkedAt: new Date().toISOString() };
}

/** Each CLI's own sign-in command: unmodified, in its own terminal (hard rules 1 and 2). */
export const signInArgs: Record<CliProvider, string[]> = { claude: ['auth', 'login', '--claudeai'], codex: ['login'] };

const psQuote = (value: string) => `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;

/** The PowerShell script a sign-in window runs: the CLI's own login, then a wait for Enter so its last words stay readable. */
export function signInScript(provider: CliProvider, executable: string): string {
  if (/[\r\n\u0000]/.test(executable)) throw new Error('The program path has a line break in it.');
  return [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(`${providerNames[provider]} sign-in`)}`,
    `& ${[executable, ...signInArgs[provider]].map(psQuote).join(' ')}`,
    `Write-Host ''`,
    `Read-Host 'Press Enter to close this window' | Out-Null`,
  ].join('; ');
}

/**
 * How a sign-in window is opened: a hidden `cmd /c start` gives PowerShell a console of its own, which the user sees.
 * (Node's `detached` would give it none: libuv sets DETACHED_PROCESS, and PowerShell without a console exits at once.)
 * The script travels base64-encoded, each argument a single-quoted PowerShell string, as core's processLaunch does,
 * so nothing in a path reaches cmd: its command line holds only the fixed title, PowerShell's own path and base64.
 */
export function signInLaunch(provider: CliProvider, executable: string): { executable: string; commandLine: string } {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (cmdUnsafe.test(powershell)) throw new Error('Windows\' own folder has a character cmd can\'t take.');
  const encoded = Buffer.from(signInScript(provider, executable), 'utf16le').toString('base64');
  return {
    executable: path.join(systemRoot, 'System32', 'cmd.exe'),
    commandLine: `/d /s /c "start "${providerNames[provider]} sign-in" "${powershell}" -NoLogo -NoProfile -EncodedCommand ${encoded}"`,
  };
}

export const SIGN_IN_TIMEOUT_MS = 15_000;

export interface SpawnedChild { once(event: 'error', listener: (error: Error) => void): unknown; once(event: 'exit', listener: (code: number | null) => void): unknown }
export type Spawner = (executable: string, args: string[], options: { cwd: string; windowsHide: true; windowsVerbatimArguments: true; stdio: 'ignore' }) => SpawnedChild;

/**
 * Opens the sign-in console. Its output is never read: stdio is ignored and the window belongs to the user. `started`
 * means Windows started the window (`start` exited 0); whether the user finishes signing in is theirs to see.
 */
export async function openSignIn(provider: CliProvider, configured: string | undefined, cwd: string, run: Spawner = spawn as unknown as Spawner): Promise<{ started: boolean; error?: string }> {
  const found = await findProvider(provider, configured).catch(() => undefined);
  if (!found?.available || !found.executable) return { started: false, error: `${providerNames[provider]} isn't installed, so there's nothing to sign in to yet.` };
  let launch: { executable: string; commandLine: string };
  try { launch = signInLaunch(provider, found.executable); } catch (error) { return { started: false, error: error instanceof Error ? error.message : String(error) }; }
  return new Promise(resolve => {
    // `start` returns at once; if cmd somehow doesn't, the call still answers.
    const timer = setTimeout(() => resolve({ started: false, error: 'Windows took too long to open the sign-in window.' }), SIGN_IN_TIMEOUT_MS);
    const finish = (result: { started: boolean; error?: string }) => { clearTimeout(timer); resolve(result); };
    try {
      const child = run(launch.executable, [launch.commandLine], { cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
      child.once('error', error => finish({ started: false, error: error.message }));
      child.once('exit', code => finish(code === 0 ? { started: true } : { started: false, error: `Windows couldn't open the sign-in window (${code}).` }));
    } catch (error) { finish({ started: false, error: error instanceof Error ? error.message : String(error) }); }
  });
}
