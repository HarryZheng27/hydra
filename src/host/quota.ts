import { mkdir } from 'node:fs/promises';
import { accountRpc, supportedAccountVersion } from '../core/accountSetup';
import { supportedCliDescription } from '../core/cliVersions';
import { readCodexQuota, type QuotaState } from '../core/quota';
import { findProvider } from '../core/providers';
import { runProbe } from '../core/process';
import type { Provider } from '../core/model';
import type { Disposable, Host } from './host';

/**
 * Codex's usage limits, read through the official CLI's app-server with no model turn
 * (docs/internal/hydra-app/G2-host-split.md, milestone 7: the IDE's Usage limits panel,
 * src/extensionQuota.ts, shows it; Codex chat limits poll it). `available` is false outside
 * the local Hydra desktop build.
 */
export class QuotaService implements Disposable {
  private state: QuotaState = { status: 'unchecked', text: 'Not checked. Refresh when ready.' };
  private controller?: AbortController;
  private pending?: Promise<void>;
  private disposed = false;
  private readonly listeners = new Set<(state: QuotaState) => void>();
  private readonly configuration: Disposable;
  constructor(private readonly host: Host, private readonly available: boolean) {
    this.configuration = host.settings.onChange(affects => {
      if (!affects('codexPath') && !affects('handoff')) return;
      this.controller?.abort(); this.controller = undefined;
      this.update({ status: 'unchecked', text: 'Provider configuration changed. Refresh to read its usage limits.' });
    });
  }
  /** Hears every change of state, with a copy of it. */
  onUpdate(listener: (state: QuotaState) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  snapshot(): QuotaState { return structuredClone(this.state); }
  private update(state: QuotaState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener(this.snapshot());
  }
  /** A refresh couldn't run here: say so, keeping the last limits read. */
  failed(text: string): void { this.update({ status: 'error', text, snapshot: this.state.snapshot }); }
  async guide(provider: Provider): Promise<void> {
    await this.host.openUrl(provider === 'claude' ? 'https://code.claude.com/docs/en/costs#using-the-usage-command' : 'https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt');
  }
  refresh(): Promise<void> {
    if (!this.available || !this.host.trusted() || this.disposed || this.host.remote || this.host.settings.get<unknown>('handoff', undefined)) return Promise.reject(new Error('Use usage limits in your trusted local Hydra window.'));
    if (this.pending) return this.pending;
    const controller = new AbortController(); this.controller = controller;
    const previous = this.state.snapshot;
    this.update({ status: 'checking', text: 'Checking the installed Codex CLI…', snapshot: previous });
    const action = async () => {
      try {
        const found = await findProvider('codex', this.host.settings.machine<string>('codexPath'));
        if (controller.signal.aborted) return;
        if (!found.executable) throw new Error(`Install ${supportedCliDescription('codex')} or set its executable path in Hydra settings.`);
        const cwd = this.host.paths.storage; await mkdir(cwd, { recursive: true });
        const version = await runProbe(found.executable, ['--version'], cwd, { signal: controller.signal, timeoutMs: 8000, maxBytes: 16384 });
        if (controller.signal.aborted) return;
        if (version.error || version.exitCode !== 0 || !supportedAccountVersion('codex', version.stdout)) throw new Error(`Usage-limit refresh needs ${supportedCliDescription('codex')}. Update Codex, or use its official client.`);
        const snapshot = await readCodexQuota(() => accountRpc(found.executable!, cwd, () => {}, () => {}, 'quota'), controller.signal);
        if (!controller.signal.aborted && this.controller === controller) this.update({ status: 'checked', text: 'Provider-reported Codex usage limits. These are shared across the signed-in account.', snapshot });
      } catch {
        if (!controller.signal.aborted && this.controller === controller) this.update({ status: 'error', text: 'Codex could not report usage limits. Check its executable version and ChatGPT sign-in in the official client, then retry. No model turn was submitted.', snapshot: previous });
      }
    };
    this.pending = action().finally(() => { if (this.controller === controller) this.controller = undefined; this.pending = undefined; });
    return this.pending;
  }
  async cancel(): Promise<void> { this.controller?.abort(); this.controller = undefined; this.update({ status: 'cancelled', text: 'Local refresh stopped. No sign-in or account limits were changed.', snapshot: this.state.snapshot }); await this.pending; }
  async shutdown(): Promise<void> { this.disposed = true; this.controller?.abort(); await this.pending; }
  dispose(): void { this.configuration.dispose(); void this.shutdown(); }
}
