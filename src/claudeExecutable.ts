import * as vscode from 'vscode';
import { machineSetting } from './core/machineSetting';
import { claudeForRegistration as claudeFor } from './host/claudeExecutable';

/** The claude CLI Hydra registers with (src/host/claudeExecutable.ts), for the IDE's own callers. */
export function claudeForRegistration(): Promise<string | undefined> {
  return claudeFor(machineSetting<string>(vscode.workspace.getConfiguration('hydra'), 'claudePath'), vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath);
}
