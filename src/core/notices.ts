/**
 * Hydra's own notifications (docs/Heads.md, "Hydra's notifications"). In the Hydra desktop app, the workbench draws
 * them as Hydra-styled toasts (desktop/workbench/hydraNotices.ts, through the `hydra.desktop.notice.*` commands);
 * anywhere else, or if those commands fail, they fall back to the editor's own messages. Modal confirmations never
 * come here: they stay native dialogs.
 *
 * This file has no `vscode` import so it can be tested; src/notices.ts binds it to the editor.
 */
export type NoticeKind = 'info' | 'warning' | 'error';

export interface NoticeProgress { report(value: { message?: string; increment?: number }): void }
export interface NoticeCancellation { readonly isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void } }
export interface ProgressOptions { title: string; cancellable?: boolean }

export interface NoticeHost {
  /** Whether the workbench has Hydra's notice commands (the Hydra desktop app). Asked once. */
  hasDesktopNotices(): Promise<boolean>;
  execute<T>(command: string, ...args: unknown[]): Thenable<T | undefined>;
  native(kind: NoticeKind, message: string, actions: string[]): Thenable<string | undefined>;
  /** The editor's own modal warning, with a detail line: confirm()'s fallback outside the Hydra app. */
  nativeConfirm(message: string, detail: string, action: string): Thenable<string | undefined>;
  nativeProgress<T>(options: ProgressOptions, task: (progress: NoticeProgress, token: NoticeCancellation) => Thenable<T>): Thenable<T>;
  log?(message: string): void;
}

const cancelLabel = 'Cancel';

/** The toast already says "Hydra", so a message's own "Hydra: " prefix is dropped there (and kept natively). */
export function toastText(message: string): string {
  const trimmed = message.replace(/^Hydra:\s+/, '');
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : message;
}

export function createNotices(host: NoticeHost) {
  let desktop: Promise<boolean> | undefined;
  let counter = 0;
  const useDesktop = () => desktop ??= host.hasDesktopNotices().then(value => value, () => false);
  const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

  async function show<T extends string>(kind: NoticeKind, message: string, actions: T[]): Promise<T | undefined> {
    if (await useDesktop()) {
      try {
        const choice = await host.execute<string>('hydra.desktop.notice.show', { id: nextId('notice'), kind, message: toastText(message), actions });
        return actions.find(action => action === choice);
      } catch (error) {
        host.log?.(`[notices] falling back to the editor's messages: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return await host.native(kind, message, actions) as T | undefined;
  }

  async function withProgress<T>(options: ProgressOptions, task: (progress: NoticeProgress, token: NoticeCancellation) => Thenable<T>): Promise<T> {
    if (!await useDesktop()) return await host.nativeProgress(options, task);
    const id = nextId('progress');
    const listeners = new Set<() => void>();
    let cancelled = false;
    const token: NoticeCancellation = {
      get isCancellationRequested() { return cancelled; },
      onCancellationRequested(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    };
    let percent: number | undefined;
    let done = false;
    const shown = Promise.resolve().then(() => host.execute<string>('hydra.desktop.notice.show', { id, kind: 'info', message: toastText(options.title), actions: options.cancellable ? [cancelLabel] : [], progress: true, sticky: true }));
    // The toast closed while the task still runs: Cancel, or (for a cancellable task) the × or Escape, cancels it.
    const outcome = shown.then(choice => ({ choice, failed: false }), () => ({ choice: undefined, failed: true }));
    void outcome.then(({ choice, failed }) => {
      if (done || failed || cancelled || !options.cancellable) return;
      if (choice !== undefined && choice !== cancelLabel) return;
      cancelled = true;
      for (const listener of [...listeners]) listener();
    });
    // If the workbench refuses the toast before anything else happens, run the task with the editor's own progress.
    const refused = await Promise.race([outcome.then(({ failed }) => failed), new Promise<false>(resolve => setTimeout(() => resolve(false), 0))]);
    if (refused) return await host.nativeProgress(options, task);
    const progress: NoticeProgress = {
      report({ message, increment }) {
        const update: { detail?: string; progress?: number } = {};
        if (message !== undefined) update.detail = message;
        if (typeof increment === 'number' && Number.isFinite(increment)) update.progress = percent = Math.min(100, (percent ?? 0) + increment);
        if (Object.keys(update).length) void Promise.resolve(host.execute('hydra.desktop.notice.update', id, update)).catch(() => undefined);
      },
    };
    try {
      return await task(progress, token);
    } finally {
      done = true;
      void Promise.resolve(host.execute('hydra.desktop.notice.close', id)).catch(() => undefined);
    }
  }

  return {
    /**
     * A question that needs an answer before anything happens (installing an update): in the Hydra app a warning
     * card that stays until answered, with the detail under it; elsewhere the editor's modal dialog. Resolves with
     * `action`, or undefined for anything else (Not now, dismissed).
     */
    confirm: async (message: string, detail: string, action: string): Promise<string | undefined> => {
      if (await useDesktop()) {
        try {
          const choice = await host.execute<string>('hydra.desktop.notice.show', { id: nextId('confirm'), kind: 'warning', message: toastText(message), detail, actions: [action, 'Not now'], sticky: true });
          return choice === action ? action : undefined;
        } catch (error) {
          host.log?.(`[notices] falling back to the editor's dialog: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return (await host.nativeConfirm(message, detail, action)) === action ? action : undefined;
    },
    info: <T extends string>(message: string, ...actions: T[]) => show('info', message, actions),
    warning: <T extends string>(message: string, ...actions: T[]) => show('warning', message, actions),
    error: <T extends string>(message: string, ...actions: T[]) => show('error', message, actions),
    withProgress,
  };
}
