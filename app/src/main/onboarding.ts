import path from 'node:path';
import { checkProvider } from '../../../src/core/diagnostics';
import { supportedCliDescription, supportedCliMinimum, supportedCliVersion } from '../../../src/core/cliVersions';
import { claudeWrittenServer, codexWrittenBlock, providerPaths, type ProviderPaths } from '../../../src/core/helperRegistration';
import { consoleLaunch, consoleScript, CONSOLE_TIMEOUT_MS, openConsole, type SpawnedChild, type Spawner } from './console';
import { spawn } from 'node:child_process';
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

/** The PowerShell script a sign-in window runs: the CLI's own login, then a wait for Enter so its last words stay readable. */
export function signInScript(provider: CliProvider, executable: string): string {
  return consoleScript(`${providerNames[provider]} sign-in`, executable, signInArgs[provider]);
}

/** How a sign-in window is opened (console.ts says how, and why not Node's `detached`). */
export function signInLaunch(provider: CliProvider, executable: string): { executable: string; commandLine: string } {
  return consoleLaunch(`${providerNames[provider]} sign-in`, signInScript(provider, executable));
}

export const SIGN_IN_TIMEOUT_MS = CONSOLE_TIMEOUT_MS;
export type { SpawnedChild, Spawner };

/**
 * Opens the sign-in console. Its output is never read: stdio is ignored and the window belongs to the user. `started`
 * means Windows started the window (`start` exited 0); whether the user finishes signing in is theirs to see.
 */
export async function openSignIn(provider: CliProvider, configured: string | undefined, cwd: string, run: Spawner = spawn as unknown as Spawner): Promise<{ started: boolean; error?: string }> {
  const found = await findProvider(provider, configured).catch(() => undefined);
  if (!found?.available || !found.executable) return { started: false, error: `${providerNames[provider]} isn't installed, so there's nothing to sign in to yet.` };
  let launch: { executable: string; commandLine: string };
  try { launch = signInLaunch(provider, found.executable); } catch (error) { return { started: false, error: error instanceof Error ? error.message : String(error) }; }
  return openConsole(launch, cwd, run);
}
