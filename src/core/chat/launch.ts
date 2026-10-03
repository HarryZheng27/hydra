import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { processLaunch, terminateProcessTree } from '../process';
import type { ChatProcess, Launch, ProcessHandlers } from './session';

/** Longest line Hydra accepts from a CLI (an image echoed back, a big tool result); longer is treated as malformed. */
export const MAX_LINE = 32 * 1024 * 1024;

export interface ChatLaunch { executable: string; args: string[]; env?: NodeJS.ProcessEnv }

/**
 * npm's `codex.cmd` only runs `node codex.js`, which starts the package's own native `codex.exe` with two variables
 * set. A chat starts that same unmodified binary the same way, skipping PowerShell, cmd and node: faster, and
 * PowerShell can't re-encode its output (it turned "What’s" into "What�s"). Undefined when the shim isn't npm's
 * Codex or the binary isn't where the package puts it.
 */
export function npmCodexBinary(shim: string, triple = 'x86_64-pc-windows-msvc'): ChatLaunch | undefined {
  if (!/(^|[\\/])codex\.cmd$/i.test(shim)) return undefined;
  let text: string;
  try { text = readFileSync(shim, 'utf8'); } catch { return undefined; }
  if (!/node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(text)) return undefined;
  const root = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex');
  const platform = `codex-${triple.startsWith('aarch64') ? 'win32-arm64' : 'win32-x64'}`;
  for (const vendor of [path.join(root, 'node_modules', '@openai', platform, 'vendor'), path.join(path.dirname(shim), 'node_modules', '@openai', platform, 'vendor'), path.join(root, 'vendor')]) {
    const binary = path.join(vendor, triple, 'bin', 'codex.exe');
    if (existsSync(binary)) return { executable: binary, args: [], env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: root } };
  }
  return undefined;
}

/**
 * How a chat starts its CLI on Windows: npm's Codex as its native binary; any other `.cmd` shim through core's
 * processLaunch with PowerShell's console in UTF-8, so text in other scripts arrives intact; anything else as it is.
 */
export function chatLaunch(executable: string, args: string[]): ChatLaunch {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return processLaunch(executable, args);
  const native = npmCodexBinary(executable);
  if (native) return { ...native, args };
  const quote = (value: string) => `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; & ${[executable, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`;
  return { executable: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}

/**
 * Starts a chat CLI as a hidden child process (chatLaunch says how), feeds its stdout to the session line by line, and
 * ends its whole process tree on kill. stderr is kept only as the last few lines, for an error message. The
 * environment is the user's own: a chat is the user's own agent.
 */
export function nodeLaunch(env: NodeJS.ProcessEnv = process.env, wrap: (executable: string, args: string[]) => ChatLaunch = chatLaunch): Launch {
  return (executable: string, args: string[], cwd: string, handlers: ProcessHandlers): ChatProcess => {
    const launch = wrap(executable, args);
    // Off Windows the CLI leads its own process group, so ending the tree reaches everything it started.
    const child = spawn(launch.executable, launch.args, { cwd, env: launch.env ? { ...env, ...launch.env } : env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    // The unfinished line, kept as pieces so a long line isn't rejoined and rescanned on every chunk.
    let pieces: string[] = [];
    let pendingLength = 0;
    let stderr = '';
    let ended = false;
    child.stdout.on('data', (chunk: Buffer) => {
      let text = decoder.write(chunk);
      let newline: number;
      while ((newline = text.indexOf('\n')) >= 0) {
        const line = (pieces.join('') + text.slice(0, newline)).replace(/\r$/, '');
        pieces = [];
        pendingLength = 0;
        text = text.slice(newline + 1);
        handlers.line(line);
      }
      if (text) { pieces.push(text); pendingLength += text.length; }
      if (pendingLength > MAX_LINE) { pieces = []; pendingLength = 0; handlers.line('\u0000line too long'); }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });
    child.stdin.on('error', () => undefined);
    child.on('error', error => { if (!ended) { ended = true; handlers.error(error); } });
    child.on('close', code => {
      if (ended) return;
      ended = true;
      const rest = pieces.join('') + decoder.end();
      if (rest.trim()) handlers.line(rest);
      handlers.exit(code);
    });
    return {
      write: line => { if (!child.stdin.destroyed) child.stdin.write(`${line}\n`); },
      kill: () => {
        child.stdin.end();
        if (child.pid && child.exitCode === null) void terminateProcessTree(child.pid).catch(() => child.kill());
      },
      get stderr() { return stderr; },
    } as ChatProcess;
  };
}
