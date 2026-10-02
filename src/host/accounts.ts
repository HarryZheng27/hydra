import { mkdir } from 'node:fs/promises';
import { accountRpc, CodexAccountFlow, supportedAccountVersion, publicClaudeAccount, type AccountState } from '../core/accountSetup';
import { supportedCliDescription } from '../core/cliVersions';
import { findProvider } from '../core/providers';
import { processLaunch, runProbe } from '../core/process';
import type { Provider } from '../core/model';
import type { Disposable, Host, HostTerminal } from './host';

/**
 * Signing in to Claude Code and Codex with their own unmodified flows (docs/internal/hydra-app/G2-host-split.md,
 * milestone 7; the IDE's Accounts panel, src/extensionAccounts.ts, shows it). Only public auth-mode fields are ever
 * read; Hydra never sees a credential. `available` is false outside the local Hydra desktop build.
 */
export class AccountsService implements Disposable {
  private readonly states: Record<Provider, AccountState> = { claude: { status: 'unchecked', text: 'Not checked. Sign in or refresh when ready.' }, codex: { status: 'unchecked', text: 'Not checked. Sign in or refresh when ready.' } };
  private readonly probes = new Map<Provider, AbortController>();
  private codex?: CodexAccountFlow;
  private terminal?: { terminal: HostTerminal; closed: Disposable };
  private disposed = false;
  private readonly listeners = new Set<(states: Record<Provider, AccountState>) => void>();
  constructor(private readonly host: Host, private readonly available: boolean) {}
  /** Hears every change of state, with a copy of both providers' states. */
  onUpdate(listener: (states: Record<Provider, AccountState>) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  snapshot(): Record<Provider, AccountState> { return structuredClone(this.states); }
  update(provider: Provider, state: AccountState): void {
    if (this.disposed) return;
    this.states[provider] = state;
    for (const listener of [...this.listeners]) listener(this.snapshot());
  }
  private closeTerminal(): void {
    const open = this.terminal;
    this.terminal = undefined;
    open?.closed.dispose(); open?.terminal.dispose();
  }
  async action(provider: Provider, action: 'login' | 'refresh' | 'cancel' | 'guide'): Promise<void> {
    if (action === 'cancel') {
      this.probes.get(provider)?.abort(); this.probes.delete(provider);
      if (provider === 'codex') { const flow = this.codex; this.codex = undefined; await flow?.cancel().catch(() => {}); }
      else this.closeTerminal();
      this.update(provider, { status: 'cancelled', text: 'Local setup stopped. This does not sign out an existing account. Refresh to check.' }); return;
    }
    if (!this.available || !this.host.trusted() || this.disposed || this.host.remote || this.host.settings.get<unknown>('handoff', undefined)) throw new Error('Use account setup in your trusted local Hydra window.');
    if (action === 'guide') { await this.host.openUrl(provider === 'claude' ? 'https://code.claude.com/docs/en/setup' : 'https://developers.openai.com/codex/cli'); return; }
    if (this.probes.has(provider) || this.states[provider].status === 'pending' || this.states[provider].status === 'working') return;
    const controller = new AbortController(); this.probes.set(provider, controller); this.update(provider, { status: 'working', text: 'Checking the installed provider version…' });
    try {
      const configured = this.host.settings.machine<string>(`${provider}Path`);
      const found = await findProvider(provider, configured); if (controller.signal.aborted) return;
      if (!found.executable) throw new Error(`Install ${supportedCliDescription(provider)} using its official guide, or set its executable path in Hydra editor settings.`);
      const cwd = this.host.paths.storage; await mkdir(cwd, { recursive: true });
      const version = await runProbe(found.executable, ['--version'], cwd, { signal: controller.signal, timeoutMs: 8000, maxBytes: 16384 });
      if (controller.signal.aborted) return;
      if (version.error || version.exitCode !== 0 || !supportedAccountVersion(provider, version.stdout)) throw new Error(`Account setup needs ${supportedCliDescription(provider)}; this one reports "${(version.stdout || '').trim().slice(0, 80) || 'no version'}". Update it with its official guide, or set its path in Hydra editor settings.`);
      if (provider === 'codex') {
        const flow = new CodexAccountFlow((notify, failed) => accountRpc(found.executable!, cwd, notify, failed), state => { if (this.codex === flow) this.update(provider, state); }, async url => { if (controller.signal.aborted || this.disposed) return false; return this.host.openUrl(url); }); this.codex = flow;
        if (action === 'login') await flow.login(); else await flow.refresh();
      } else if (action === 'login') {
        const launch = processLaunch(found.executable, ['auth', 'login', '--claudeai']);
        const terminal = this.host.openTerminal({ name: 'Claude Code · Subscription sign-in', cwd, shellPath: launch.executable, shellArgs: launch.args });
        const closed = terminal.onClose(() => {
          if (this.terminal?.terminal !== terminal) return;
          this.terminal.closed.dispose(); this.terminal = undefined;
          this.update('claude', { status: 'unchecked', text: 'Claude Code sign-in terminal closed. Refresh status to check the result.' });
        });
        this.terminal = { terminal, closed };
        this.update(provider, { status: 'pending', text: 'Complete the unmodified Claude Code sign-in flow in its terminal/browser. Close that terminal, then refresh status. Hydra does not read its terminal output.' });
      } else {
        const status = await runProbe(found.executable, ['auth', 'status', '--json'], cwd, { signal: controller.signal, timeoutMs: 15000, maxBytes: 16384 });
        if (controller.signal.aborted) return;
        // Only public auth-mode fields are interpreted; identity and credential fields are discarded.
        this.update(provider, publicClaudeAccount(status.exitCode, status.error, status.stdout));
      }
    } catch (error) { if (!controller.signal.aborted) this.update(provider, { status: 'error', text: error instanceof Error ? error.message : 'Account setup failed. Retry or use the official client.' }); }
    finally { if (this.probes.get(provider) === controller) this.probes.delete(provider); }
  }
  async shutdown(): Promise<void> { this.disposed = true; for (const controller of this.probes.values()) controller.abort(); this.probes.clear(); this.closeTerminal(); await this.codex?.cancel().catch(() => {}); }
  dispose(): void { void this.shutdown(); }
}
