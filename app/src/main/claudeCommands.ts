import { spawn } from 'node:child_process';
import { cloudEnvironment } from '../../../src/core/chat/cloud';

export interface ListedCommand { name: string; description?: string; argumentHint?: string; builtin?: boolean }

/**
 * Claude Code's slash commands for a folder, for the home's / menu before any chat starts there: the CLI's own
 * initialize reply (no message, so no model call), read and the process ended. Callers only ask for a folder the user
 * trusted in Hydra, since starting Claude Code there runs its hooks. Cached by folder for ten minutes.
 */
const cache = new Map<string, { at: number; commands: ListedCommand[] }>();

export function readCommands(response: unknown): ListedCommand[] {
  const commands = (response as { commands?: unknown } | undefined)?.commands;
  if (!Array.isArray(commands)) return [];
  return commands.flatMap(command => {
    if (!command || typeof command !== 'object') return [];
    const { name, description, argumentHint, builtin } = command as Record<string, unknown>;
    if (typeof name !== 'string' || !/^[a-z0-9][\w:.-]{0,63}$/i.test(name)) return [];
    return [{ name, ...(typeof description === 'string' && description ? { description: description.slice(0, 300) } : {}), ...(typeof argumentHint === 'string' && argumentHint ? { argumentHint: argumentHint.slice(0, 100) } : {}), ...(builtin === true ? { builtin: true } : {}) }];
  }).slice(0, 400);
}

export function claudeCommands(executable: string, cwd: string, timeoutMs = 30_000): Promise<ListedCommand[]> {
  const cached = cache.get(cwd.toLowerCase());
  if (cached && Date.now() - cached.at < 10 * 60_000) return Promise.resolve(cached.commands);
  return new Promise(resolve => {
    let done = false, buffer = '';
    const child = spawn(executable, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd, env: cloudEnvironment(process.env), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (commands: ListedCommand[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      if (commands.length) cache.set(cwd.toLowerCase(), { at: Date.now(), commands });
      resolve(commands);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 4 * 1024 * 1024) { finish([]); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as { type?: string; response?: { response?: unknown } };
          if (message.type === 'control_response') { finish(readCommands(message.response?.response)); return; }
        } catch { /* not JSON: keep reading */ }
      }
    });
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'hydra-commands', request: { subtype: 'initialize' } })}\n`);
  });
}
