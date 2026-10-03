import { spawn } from 'node:child_process';
import path from 'node:path';
import { cmdUnsafe } from '../../../src/core/process';

/**
 * A console window the user owns, running one of their CLIs unmodified: Open in terminal
 * (a chat's interactive resume). Hydra never reads it: stdio is ignored.
 *
 * A hidden `cmd /c start` gives PowerShell a console of its own, which the user sees. (Node's `detached` would give it
 * none: libuv sets DETACHED_PROCESS, and PowerShell without a console exits at once.) The script travels
 * base64-encoded, each argument a single-quoted PowerShell string, as core's processLaunch does, so nothing from a
 * path or an id reaches cmd: its command line holds only a fixed title, PowerShell's own path and base64.
 */
export const psQuote = (value: string): string => `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;

const titlePattern = /^[A-Za-z0-9 .:()-]{1,60}$/;

/** The script a console runs: an optional folder, the CLI with its arguments, then a wait for Enter. */
export function consoleScript(title: string, executable: string, args: string[], cwd?: string): string {
  if (!titlePattern.test(title)) throw new Error('That window title isn\'t allowed.');
  for (const part of [executable, ...args, ...(cwd ? [cwd] : [])]) if (/[\r\n\u0000]/.test(part)) throw new Error('A path or argument has a line break in it.');
  return [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`,
    ...(cwd ? [`Set-Location -LiteralPath ${psQuote(cwd)}`] : []),
    `& ${[executable, ...args].map(psQuote).join(' ')}`,
    `Write-Host ''`,
    `Read-Host 'Press Enter to close this window' | Out-Null`,
  ].join('; ');
}

export function consoleLaunch(title: string, script: string): { executable: string; commandLine: string } {
  if (!titlePattern.test(title)) throw new Error('That window title isn\'t allowed.');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (cmdUnsafe.test(powershell)) throw new Error('Windows\' own folder has a character cmd can\'t take.');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return {
    executable: path.join(systemRoot, 'System32', 'cmd.exe'),
    commandLine: `/d /s /c "start "${title}" "${powershell}" -NoLogo -NoProfile -EncodedCommand ${encoded}"`,
  };
}

export const CONSOLE_TIMEOUT_MS = 15_000;

export interface SpawnedChild { once(event: 'error', listener: (error: Error) => void): unknown; once(event: 'exit', listener: (code: number | null) => void): unknown }
export type Spawner = (executable: string, args: string[], options: { cwd: string; windowsHide: true; windowsVerbatimArguments: true; stdio: 'ignore' }) => SpawnedChild;

/** Opens the console. `started` means Windows opened it (`start` exited 0). */
export function openConsole(launch: { executable: string; commandLine: string }, cwd: string, run: Spawner = spawn as unknown as Spawner): Promise<{ started: boolean; error?: string }> {
  return new Promise(resolve => {
    // `start` returns at once; if cmd somehow doesn't, the call still answers.
    const timer = setTimeout(() => resolve({ started: false, error: 'Windows took too long to open the window.' }), CONSOLE_TIMEOUT_MS);
    const finish = (result: { started: boolean; error?: string }) => { clearTimeout(timer); resolve(result); };
    try {
      const child = run(launch.executable, [launch.commandLine], { cwd, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
      child.once('error', error => finish({ started: false, error: error.message }));
      child.once('exit', code => finish(code === 0 ? { started: true } : { started: false, error: `Windows couldn't open the window (${code}).` }));
    } catch (error) { finish({ started: false, error: error instanceof Error ? error.message : String(error) }); }
  });
}
