import path from 'node:path';
import { checkProvider } from '../../../src/core/diagnostics';
import { supportedCliDescription, supportedCliMinimum, supportedCliVersion } from '../../../src/core/cliVersions';
import { claudeWrittenServer, codexWrittenBlock, providerPaths, type ProviderPaths } from '../../../src/core/helperRegistration';
import { spawn } from 'node:child_process';
import { accountRpc, CodexAccountFlow, publicClaudeAccount, type AccountState } from '../../../src/core/accountSetup';
import { processLaunch, runProbe, terminateProcessTree } from '../../../src/core/process';
import { findProvider } from '../../../src/core/providers';
import type { AccountStatus, CliProvider, OnboardingReport, ProviderStatus, RegistrationStatus } from '../shared/ipc';

/**
 * First-run checks for the app (G3 milestone 4). Everything here is read-only:
 * - each CLI is found (machine setting, else PATH) and asked only `--version` and `--help` (Codex also
 *   `app-server --help`) through core's checkProvider, then its version is checked against cliVersions;
 * - the user-level `hydra` MCP registration is looked up in Claude's and Codex's config files, never written;
 * - whether the user is signed in is asked of each CLI (`claude auth status --json`, `codex login status`), and only a
 *   yes or no is kept (core's publicClaudeAccount discards identity fields);
 * - Sign in runs the CLI's own login out of sight: Claude Code's `auth login` opens the browser itself, and Codex's
 *   app-server hands back its login page (checked by core's loginUrl), which opens in the browser. Claude's output is
 *   never read; of Codex's protocol messages only the login page and the signed-in status are used. Hydra never sees a
 *   credential, and a sign-in still running when the app quits is stopped (`stopSignIns`).
 * No other provider process starts: G4 runs the start-up self-check (cliSelfCheck.ts) before a chat.
 */
export const providerNames: Record<CliProvider, string> = { claude: 'Claude Code', codex: 'Codex' };
const providers: CliProvider[] = ['claude', 'codex'];

export async function providerStatus(provider: CliProvider, configured: string | undefined, cwd: string, timeoutMs = 15_000): Promise<ProviderStatus> {
  const base = { provider, name: providerNames[provider], minimum: supportedCliMinimum(provider), requirement: supportedCliDescription(provider), configured: !!configured };
  let found;
  try { found = await findProvider(provider, configured); } catch (error) { return { ...base, found: false, supported: false, error: error instanceof Error ? error.message : String(error) }; }
  if (!found.available || !found.executable) {
    return { ...base, found: false, supported: false, error: configured ? `Hydra can't find ${configured}.` : `${providerNames[provider]} isn't on your PATH.` };
  }
  // 15 seconds by default, as the sign-in status check: a CLI's first start on a busy machine can take longer than 8.
  // Tests pass more: a fresh .cmd stand-in on a CI runner can wait on a virus scan past 15.
  const diagnostic = await checkProvider({ provider, executable: found.executable, available: true }, cwd, undefined, timeoutMs);
  if (diagnostic.status !== 'checked' || !diagnostic.version) {
    return { ...base, found: true, executable: found.executable, supported: false, error: diagnostic.error ?? 'The check failed.' };
  }
  const supported = supportedCliVersion(provider, diagnostic.version);
  const account = supported ? await accountStatus(provider, found.executable, cwd, timeoutMs) : undefined;
  return {
    ...base, found: true, executable: found.executable, version: diagnostic.version, supported, advertised: diagnostic.advertised, ...(account ? { account } : {}),
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

/** Each CLI's own status and sign-in commands, unmodified (hard rules 1 and 2). */
export const statusArgs: Record<CliProvider, string[]> = { claude: ['auth', 'status', '--json'], codex: ['login', 'status'] };
export const signInArgs = { claude: ['auth', 'login', '--claudeai'] };
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Whether the CLI says the user is signed in. Only that answer is kept; nothing else it prints is read or returned. */
export async function accountStatus(provider: CliProvider, executable: string, cwd: string, timeoutMs = 15_000): Promise<AccountStatus> {
  const probe = await runProbe(executable, statusArgs[provider], cwd, { timeoutMs, maxBytes: 16_384 }).catch(() => undefined);
  if (!probe || probe.error) return 'unknown';
  // Codex's first line says how ("Logged in using ChatGPT"); an API key isn't the user's subscription. Only that is kept.
  if (provider === 'codex') return probe.exitCode === 0 ? (/^Logged in using ChatGPT\b/.test(probe.stdout.trim()) ? 'signed-in' : 'other') : probe.exitCode === 1 ? 'signed-out' : 'unknown';
  let state: AccountState;
  try { state = publicClaudeAccount(probe.exitCode, probe.error, probe.stdout); } catch { return 'unknown'; }
  return state.status === 'signed-in' ? 'signed-in' : state.status === 'signed-out' ? 'signed-out' : state.status === 'other' ? 'other' : 'unknown';
}

/** Sign-ins running now, so quitting can stop them (a hidden login would otherwise outlive the app). */
const running = new Set<() => void>();
export function stopSignIns(): void { for (const stop of [...running]) stop(); running.clear(); }

export interface SignInDeps {
  /** Opens a provider's login page in the user's browser; false if it didn't open. */
  openUrl(url: string): Promise<boolean>;
  spawn?: typeof spawn;
  timeoutMs?: number;
}

/**
 * Claude Code's own `auth login`, with no window: it opens the browser and waits for the sign-in there. Its output is
 * ignored (never read) and nothing is written to it; it ends when the sign-in does, or after the timeout.
 */
function claudeSignIn(executable: string, cwd: string, deps: SignInDeps): Promise<boolean> {
  const launch = processLaunch(executable, signInArgs.claude);
  return new Promise(resolve => {
    const child = (deps.spawn ?? spawn)(launch.executable, launch.args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore'] });
    let done = false;
    const finish = (signedIn: boolean) => { if (done) return; done = true; clearTimeout(timer); running.delete(stop); resolve(signedIn); };
    const stop = () => { if (child.pid && child.exitCode === null) void terminateProcessTree(child.pid).catch(() => undefined); finish(false); };
    const timer = setTimeout(stop, deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
    running.add(stop);
    child.on('error', () => finish(false));
    child.on('exit', code => finish(code === 0));
  });
}

/** Codex's own login through its app-server (core's CodexAccountFlow, as the IDE uses): the page opens in the browser. */
function codexSignIn(executable: string, cwd: string, deps: SignInDeps): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const stop = () => { void flow.cancel().catch(() => undefined); finish(false); };
    const finish = (signedIn: boolean) => { if (!done) { done = true; running.delete(stop); resolve(signedIn); } };
    running.add(stop);
    const flow = new CodexAccountFlow((notify, failed) => accountRpc(executable, cwd, notify, failed), state => {
      if (state.status === 'signed-in' || state.status === 'other') finish(true);
      else if (state.status === 'error' || state.status === 'cancelled' || state.status === 'signed-out') finish(false);
    }, deps.openUrl);
    flow.login().catch(() => { finish(false); void flow.close().catch(() => undefined); });
  });
}

/**
 * Signs in with the CLI's own login, out of sight, and then asks the CLI whether it worked. Resolves when the sign-in
 * ends: finished in the browser, failed, or timed out.
 */
export async function signIn(provider: CliProvider, configured: string | undefined, cwd: string, deps: SignInDeps): Promise<{ signedIn: boolean; error?: string }> {
  const found = await findProvider(provider, configured).catch(() => undefined);
  if (!found?.available || !found.executable) return { signedIn: false, error: `${providerNames[provider]} isn't installed, so there's nothing to sign in to yet.` };
  const finished = provider === 'claude' ? await claudeSignIn(found.executable, cwd, deps) : await codexSignIn(found.executable, cwd, deps);
  const account = await accountStatus(provider, found.executable, cwd);
  if (account === 'signed-in' || account === 'other') return { signedIn: true };
  return { signedIn: false, error: finished ? `${providerNames[provider]} still says you're not signed in. Try again.` : 'Sign-in didn\'t finish. Try again.' };
}
