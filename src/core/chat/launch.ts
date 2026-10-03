import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { processLaunch, terminateProcessTree } from '../process';
import type { ChatProcess, Launch, ProcessHandlers } from './session';

/** Longest line Hydra accepts from a CLI (an image echoed back, a big tool result); longer is treated as malformed. */
export const MAX_LINE = 32 * 1024 * 1024;

/**
 * Starts a chat CLI as a hidden child process (a `.cmd` shim through core's processLaunch), feeds its stdout to the
 * session line by line, and ends its whole process tree on kill. stderr is kept only as the last few lines, for an
 * error message. The environment is the user's own: a chat is the user's own agent.
 */
export function nodeLaunch(env: NodeJS.ProcessEnv = process.env, wrap: (executable: string, args: string[]) => { executable: string; args: string[] } = processLaunch): Launch {
  return (executable: string, args: string[], cwd: string, handlers: ProcessHandlers): ChatProcess => {
    const launch = wrap(executable, args);
    // Off Windows the CLI leads its own process group, so ending the tree reaches everything it started.
    const child = spawn(launch.executable, launch.args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
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
