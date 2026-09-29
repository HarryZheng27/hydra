import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { machineSetting } from './core/machineSetting';
import { findProvider } from './core/providers';

/** The claude CLI Hydra registers with: the configured or PATH claude, else the Claude Code extension's bundled one. */
export async function claudeForRegistration(): Promise<string | undefined> {
  const info = await findProvider('claude', machineSetting<string>(vscode.workspace.getConfiguration('hydra'), 'claudePath')).catch(() => undefined);
  if (info?.executable) return info.executable;
  const extension = vscode.extensions.getExtension('anthropic.claude-code');
  if (!extension) return undefined;
  const bundled = path.join(extension.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return await realpath(bundled).catch(() => undefined);
}
