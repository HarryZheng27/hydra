import { CodexLimitTracker, codexPollDelay } from '../core/limitDetection';
import { LimitWatcher, workspaceOwns } from '../core/limitWatcher';
import type { LimitEvent } from '../core/limitEvents';
import type { QuotaState } from '../core/quota';
import type { Disposable, Host } from './host';

/**
 * Limit detection for chats in the official extensions (docs/internal/Hydra_Agent_Plan.md,
 * Phase 1). Heads report their own limits through HelperService.onLimit.
 * - Claude: event files from the StopFailure hook, via LimitWatcher.
 * - Codex: the account's rate-limit snapshot, polled while this window is focused.
 */
export class ClaudeChatLimits implements Disposable {
  private readonly watcher: LimitWatcher;
  /**
   * `laneWorktrees` lists this window's open lanes (id and worktree), read fresh on
   * each event: a lane's own Claude session is tagged with its laneId (claimed at
   * once, `ownsLane`), and its worktree also counts as an owned folder for a chat
   * event with no lane tag (`owns`), same as a workspace folder.
   */
  constructor(host: Pick<Host, 'folders'>, directory: string, claudeProjectsDir: string, emit: (event: LimitEvent) => void, laneWorktrees: () => readonly { id: string; worktree: string }[] = () => []) {
    this.watcher = new LimitWatcher({
      directory, claudeProjectsDir,
      owns: cwd => workspaceOwns([...host.folders().map(folder => folder.path), ...laneWorktrees().map(lane => lane.worktree)])(cwd),
      ownsLane: laneId => laneWorktrees().some(lane => lane.id === laneId),
    });
    this.watcher.onLimit(emit);
  }
  start(): Promise<void> { return this.watcher.start(); }
  dispose(): void { this.watcher.dispose(); }
}

/** Where Codex's limits are read (src/host/quota.ts's QuotaService). */
export interface QuotaSource { refresh(): Promise<void>; snapshot(): QuotaState }

/**
 * Reads Codex's limits through the quota source (the official CLI's app-server, no
 * model turn) every few minutes, only while this window has focus, and emits one
 * event when a limit is reached, not again until it clears. Rate limits are
 * account-wide, so this also covers the Codex extension's chats.
 */
export class CodexChatLimits implements Disposable {
  private readonly tracker = new CodexLimitTracker();
  private readonly disposables: Disposable[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private delay = codexPollDelay(0, 'ok');
  private last = 0;
  private polling = false;
  constructor(private readonly host: Pick<Host, 'focused' | 'onFocusChange'>, private readonly quota: QuotaSource, private readonly enabled: () => Promise<boolean>, private readonly emit: (event: LimitEvent) => void, private readonly log: (line: string) => void) {
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.disposables.push(host.onFocusChange(focused => { if (focused) void this.tick(); }));
  }
  private async tick(): Promise<void> {
    if (this.polling || !this.host.focused() || Date.now() - this.last < this.delay) return;
    this.polling = true;
    try {
      if (!await this.enabled()) return;
      this.last = Date.now();
      await this.quota.refresh();
      const state = this.quota.snapshot();
      if (state.status !== 'checked' || !state.snapshot) { this.delay = codexPollDelay(this.delay, 'failed'); return; }
      const event = this.tracker.observe(state.snapshot);
      this.delay = codexPollDelay(this.delay, this.tracker.isLimited ? 'limited' : 'ok');
      if (event) this.emit(event);
    } catch (error) {
      this.delay = codexPollDelay(this.delay, 'failed');
      this.log(`[limits] Codex limit check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { this.polling = false; }
  }
  dispose(): void { clearInterval(this.timer); for (const disposable of this.disposables) disposable.dispose(); }
}
