import * as vscode from 'vscode';
import { createNotices, type NoticeKind } from './core/notices';

const native: Record<NoticeKind, (message: string, ...items: string[]) => Thenable<string | undefined>> = {
  info: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
  warning: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
  error: (message, ...items) => vscode.window.showErrorMessage(message, ...items),
};

/**
 * Hydra's non-modal messages and progress (src/core/notices.ts): Hydra-styled toasts in the desktop app, the editor's
 * own messages anywhere else. Modal confirmations keep using vscode.window directly.
 */
export const notices = createNotices({
  hasDesktopNotices: async () => (await vscode.commands.getCommands(true)).includes('hydra.desktop.notice.show'),
  execute: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  native: (kind, message, actions) => native[kind](message, ...actions),
  nativeProgress: (options, task) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: options.title, cancellable: options.cancellable }, task),
});
