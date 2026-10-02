import { spawn } from 'node:child_process';
import path from 'node:path';
import { checkProvider } from '../../../src/core/diagnostics';
import { supportedCliDescription, supportedCliMinimum, supportedCliVersion } from '../../../src/core/cliVersions';
import { claudeWrittenServer, codexWrittenBlock, providerPaths, type ProviderPaths } from '../../../src/core/helperRegistration';
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

/** Whether the user-level `hydra` MCP server is registered with each CLI. Reads the files; writes nothing. */
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

/**
 * The console window for a sign-in: PowerShell runs the CLI's own login, then waits for Enter so its last words stay
 * readable. The script is passed encoded, each argument a single-quoted string, as core's processLaunch does.
 */
export function signInLaunch(provider: CliProvider, executable: string): { executable: string; args: string[] } {
  if (/[\r\n\u0000]/.test(executable)) throw new Error('The program path has a line break in it.');
  const title = `${providerNames[provider]} sign-in`;
  const script = [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`,
    `& ${[executable, ...signInArgs[provider]].map(psQuote).join(' ')}`,
    `Write-Host ''`,
    `Read-Host 'Press Enter to close this window' | Out-Null`,
  ].join('; ');
  return {
    executable: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

export type Spawner = (executable: string, args: string[], options: { cwd: string; detached: true; windowsHide: false; stdio: 'ignore' }) => { unref(): void; once(event: 'error', listener: (error: Error) => void): unknown };

/** Opens the sign-in console. Its output is never read: stdio is ignored and the window belongs to the user. */
export async function openSignIn(provider: CliProvider, configured: string | undefined, cwd: string, run: Spawner = spawn as unknown as Spawner): Promise<{ started: boolean; error?: string }> {
  const found = await findProvider(provider, configured).catch(() => undefined);
  if (!found?.available || !found.executable) return { started: false, error: `${providerNames[provider]} isn't installed, so there's nothing to sign in to yet.` };
  const launch = signInLaunch(provider, found.executable);
  return new Promise(resolve => {
    try {
      const child = run(launch.executable, launch.args, { cwd, detached: true, windowsHide: false, stdio: 'ignore' });
      child.once('error', error => resolve({ started: false, error: error.message }));
      child.unref();
      setTimeout(() => resolve({ started: true }), 250);
    } catch (error) { resolve({ started: false, error: error instanceof Error ? error.message : String(error) }); }
  });
}
